import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userInfo } from "node:os";
import type { AccountConfig, ProviderSnapshot, UsageWindow } from "../types.js";
import {
  defaultClaudeCredentialsPath,
  defaultClaudeKeychainService,
} from "../config.js";
import { join } from "node:path";
import {
  pathExists,
  readJsonFile,
  writeJsonFile,
} from "../utils/fs.js";
import {
  cacheRoot,
  clearBackoff,
  isBackedOff,
  markBackoff,
} from "../utils/backoff.js";
import { claudePlanName } from "../claude-plan.js";
import { formatFetchError } from "../utils/network.js";
import { nowIso, secondsUntil, WEEK_SECONDS } from "../utils/time.js";
import type { Provider } from "./types.js";

const execFileAsync = promisify(execFile);

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// Prefer platform first; only fall through on non-429 failures.
const TOKEN_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];
const USER_AGENT = "claude-code/2.1.71";
const REFRESH_SKEW_MS = 60_000;
/** After a 429, do not hit /oauth/token again for this long. */
const REFRESH_429_BACKOFF_MS = 15 * 60_000;
/** Serve last successful usage this long when live fetch fails. */
const USAGE_CACHE_TTL_MS = 10 * 60_000;
/**
 * The usage endpoint is rate-limited separately from inference (Claude Code
 * can be working fine while it 429s). Honour its Retry-After across runs so a
 * HUD / status bar polling every few seconds doesn't keep the limit alive.
 */
const USAGE_BACKOFF_FILE = "claude-usage-backoff.json";
/** Fallback cooldown when a 429 carries no usable Retry-After. */
const USAGE_429_DEFAULT_BACKOFF_MS = 10 * 60_000;
/** While rate-limited, last good usage beats an error for this long. */
const RATE_LIMITED_CACHE_TTL_MS = 24 * 60 * 60_000;

type ClaudeOauth = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  /** Claude Code keychain field (e.g. default_claude_max_20x). */
  rateLimitTier?: string;
  [key: string]: unknown;
};

type ClaudeCredentials = {
  claudeAiOauth?: ClaudeOauth;
  mcpOAuth?: unknown;
  [key: string]: unknown;
};

type CredStore =
  | { kind: "keychain"; service: string; account: string; data: ClaudeCredentials }
  | { kind: "file"; path: string; data: ClaudeCredentials };

type LimitEntry = {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: { display_name?: string; id?: string | null } } | null;
  is_active?: boolean;
};

type UsageResponse = {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  limits?: LimitEntry[];
  extra_usage?: {
    is_enabled?: boolean;
    used_credits?: number | null;
    utilization?: number | null;
    user_disabled?: boolean;
  };
  spend?: {
    enabled?: boolean;
    percent?: number;
    used?: { amount_minor?: number; currency?: string; exponent?: number };
  };
};

function planTier(oauth: ClaudeOauth): string {
  const raw = oauth as Record<string, unknown>;
  // Prefer known field; also accept plural typo if it appears in the wild.
  const tier =
    oauth.rateLimitTier ??
    raw["rateLimitTier"] ??
    raw["rateLimitTiers"] ??
    "";
  return typeof tier === "string" ? tier : "";
}

function formatPlan(oauth: ClaudeOauth): string {
  return claudePlanName(oauth as Record<string, unknown>);
}

async function readKeychain(
  service: string,
): Promise<{ account: string; data: ClaudeCredentials } | null> {
  if (process.platform !== "darwin") return null;
  const account = process.env.USER || userInfo().username;
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout.trim()) as ClaudeCredentials;
    return { account, data };
  } catch {
    return null;
  }
}

async function writeKeychain(
  service: string,
  account: string,
  data: ClaudeCredentials,
): Promise<void> {
  // -U updates if exists; -w sets password (JSON blob)
  // Never log the payload.
  const payload = JSON.stringify(data);
  await execFileAsync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s",
      service,
      "-a",
      account,
      "-w",
      payload,
    ],
    { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
  );
}

async function loadCredentials(account: AccountConfig): Promise<CredStore> {
  const service = account.keychainService ?? defaultClaudeKeychainService();
  // Prefer explicit overrides over ambient "auto" discovery.
  // A credentialsPath / non-default keychain service means a dedicated account slot.
  const hasExplicitFile = Boolean(account.credentialsPath);
  const hasExplicitKeychain =
    Boolean(account.keychainService) &&
    account.keychainService !== defaultClaudeKeychainService();
  const source =
    account.source ??
    (hasExplicitFile
      ? "credentials_file"
      : hasExplicitKeychain
        ? "keychain"
        : "auto");
  const filePath = account.credentialsPath ?? defaultClaudeCredentialsPath();

  // Explicit credentials file → never fall back to ambient keychain
  // (that would merge every Claude account into the currently logged-in one).
  if (source === "credentials_file" || source === "auth_file") {
    if (await pathExists(filePath)) {
      const data = await readJsonFile<ClaudeCredentials>(filePath);
      if (data?.claudeAiOauth?.accessToken) {
        return { kind: "file", path: filePath, data };
      }
    }
    throw new Error(`Claude credentials file missing or invalid: ${filePath}`);
  }

  if (source === "keychain" || source === "auto") {
    const kc = await readKeychain(service);
    if (kc?.data?.claudeAiOauth?.accessToken) {
      return {
        kind: "keychain",
        service,
        account: kc.account,
        data: kc.data,
      };
    }
    if (source === "keychain") {
      throw new Error(`Claude keychain service not found: ${service}`);
    }
  }

  if (source === "auto") {
    if (await pathExists(filePath)) {
      const data = await readJsonFile<ClaudeCredentials>(filePath);
      if (data?.claudeAiOauth?.accessToken) {
        return { kind: "file", path: filePath, data };
      }
    }
  }

  throw new Error(
    "No Claude credentials found (keychain or credentials file)",
  );
}

async function persistCredentials(
  store: CredStore,
  data: ClaudeCredentials,
): Promise<{ ok: boolean; warning?: string }> {
  try {
    if (store.kind === "keychain") {
      await writeKeychain(store.service, store.account, data);
    } else {
      await writeJsonFile(store.path, data);
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      warning: `Token refreshed in-memory but failed to write back (${msg})`,
    };
  }
}

function refreshFp(oauth: ClaudeOauth): string {
  const r = oauth.refreshToken;
  if (r && r.length >= 12) return r.slice(-12);
  return oauth.accessToken.slice(-12);
}

const BACKOFF_FILE = "claude-refresh-backoff.json";

async function isRefreshBackedOff(fp: string): Promise<number | null> {
  return isBackedOff(BACKOFF_FILE, fp);
}

async function markRefreshBackoff(fp: string, status: number): Promise<void> {
  await markBackoff(BACKOFF_FILE, fp, REFRESH_429_BACKOFF_MS, status);
}

async function clearRefreshBackoff(fp: string): Promise<void> {
  await clearBackoff(BACKOFF_FILE, fp);
}

type CachedUsage = {
  fetchedAt: string;
  usage: UsageResponse;
  plan?: string | null;
  sourceLabel?: string;
};

async function readUsageCache(accountId: string): Promise<CachedUsage | null> {
  const p = join(cacheRoot(), "claude-usage", `${accountId}.json`);
  try {
    if (!(await pathExists(p))) return null;
    return await readJsonFile<CachedUsage>(p);
  } catch {
    return null;
  }
}

async function writeUsageCache(
  accountId: string,
  cache: CachedUsage,
): Promise<void> {
  await writeJsonFile(
    join(cacheRoot(), "claude-usage", `${accountId}.json`),
    cache,
  );
}

/**
 * If Claude Code's live keychain holds a fresher access token for the same
 * login (same refresh-token fingerprint), prefer it over a stale snapshot file.
 */
async function adoptFresherLiveTokens(
  store: CredStore,
  oauth: ClaudeOauth,
): Promise<ClaudeOauth> {
  if (store.kind !== "file") return oauth;
  const live = await readKeychain(defaultClaudeKeychainService());
  const liveOauth = live?.data?.claudeAiOauth;
  if (!liveOauth?.accessToken) return oauth;

  const a = refreshFp(oauth);
  const b = refreshFp(liveOauth);
  if (a !== b) return oauth;

  const liveExp = liveOauth.expiresAt ?? 0;
  const fileExp = oauth.expiresAt ?? 0;
  if (liveExp <= fileExp) return oauth;

  const merged: ClaudeOauth = {
    ...oauth,
    accessToken: liveOauth.accessToken,
    refreshToken: liveOauth.refreshToken ?? oauth.refreshToken,
    expiresAt: liveOauth.expiresAt ?? oauth.expiresAt,
  };
  // Persist so next run is cheap.
  const next: ClaudeCredentials = {
    ...store.data,
    claudeAiOauth: merged,
  };
  await persistCredentials(store, next);
  return merged;
}

class RefreshError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RefreshError";
  }
}

async function refreshAccessToken(
  refreshToken: string,
  fp: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const backedOffUntil = await isRefreshBackedOff(fp);
  if (backedOffUntil) {
    const mins = Math.ceil((backedOffUntil - Date.now()) / 60_000);
    throw new RefreshError(
      `OAuth refresh rate-limited (429); retry in ~${mins}m. ` +
        `Or log into this account in Claude Code, then: tokmeter save-claude <label>`,
      429,
    );
  }

  let lastErr = "refresh failed";
  let lastStatus: number | undefined;
  for (const url of TOKEN_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLAUDE_CLIENT_ID,
        }),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status} from ${url}`;
        lastStatus = res.status;
        // Do not hammer the second host after a 429 — same rate limit budget.
        if (res.status === 429) {
          await markRefreshBackoff(fp, 429);
          throw new RefreshError(
            `OAuth refresh rate-limited (HTTP 429). Backing off ${REFRESH_429_BACKOFF_MS / 60_000}m. ` +
              `Log into this account in Claude Code, then: tokmeter save-claude <label>`,
            429,
          );
        }
        continue;
      }
      const body = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        expires_at?: number;
      };
      if (!body.access_token) {
        lastErr = "missing access_token in refresh response";
        continue;
      }
      const expiresAt =
        typeof body.expires_at === "number"
          ? body.expires_at < 1e12
            ? body.expires_at * 1000
            : body.expires_at
          : typeof body.expires_in === "number"
            ? Date.now() + body.expires_in * 1000
            : undefined;
      await clearRefreshBackoff(fp);
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt,
      };
    } catch (e) {
      if (e instanceof RefreshError) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new RefreshError(
    `Claude token refresh failed: ${lastErr}`,
    lastStatus,
  );
}

class UsageRateLimitedError extends Error {
  constructor(readonly until: number) {
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
    super(`Claude usage API rate-limited (HTTP 429); retry in ~${mins}m`);
    this.name = "UsageRateLimitedError";
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function fetchUsageApi(
  accessToken: string,
  accountId: string,
): Promise<{ ok: true; usage: UsageResponse } | { ok: false; status: number }> {
  const backedOffUntil = await isBackedOff(USAGE_BACKOFF_FILE, accountId);
  if (backedOffUntil) throw new UsageRateLimitedError(backedOffUntil);

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": USER_AGENT,
    },
  });
  if (res.status === 429) {
    const waitMs =
      retryAfterMs(res.headers.get("retry-after")) ??
      USAGE_429_DEFAULT_BACKOFF_MS;
    await markBackoff(USAGE_BACKOFF_FILE, accountId, waitMs, 429);
    throw new UsageRateLimitedError(Date.now() + waitMs);
  }
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, usage: (await res.json()) as UsageResponse };
}

/**
 * If the live Claude Code login looks like this slot, snapshot it into the
 * slot file (same as `tokmeter save-claude <label>`) so we pick up rotated tokens.
 *
 * Safety: only when plans match (or refresh-token fingerprint matches), so we
 * never overwrite "max" with a live "pro" session.
 */
async function tryRehydrateFromLiveLogin(
  account: AccountConfig,
  fileOauth: ClaudeOauth,
): Promise<{ ok: true; plan: string } | { ok: false; reason: string }> {
  if (!account.credentialsPath && account.source !== "credentials_file") {
    return { ok: false, reason: "not a captured file slot" };
  }

  const liveKc = await readKeychain(defaultClaudeKeychainService());
  const liveOauth = liveKc?.data?.claudeAiOauth;
  if (!liveOauth?.accessToken) {
    return { ok: false, reason: "no live Claude Code login in keychain" };
  }

  const livePlan = formatPlan(liveOauth);
  const slotPlan = formatPlan(fileOauth);
  const sameFp = refreshFp(liveOauth) === refreshFp(fileOauth);
  if (!sameFp && livePlan !== slotPlan) {
    return {
      ok: false,
      reason: `live is ${livePlan}, slot is ${slotPlan} — switch Claude Code to this account first`,
    };
  }

  const liveExpired =
    typeof liveOauth.expiresAt === "number" &&
    liveOauth.expiresAt - REFRESH_SKEW_MS <= Date.now();
  if (liveExpired && !sameFp) {
    // Live is also stale and not the same token lineage — won't help.
    return { ok: false, reason: "live login token also expired" };
  }

  // Snapshot live → slot file (no config churn beyond file write).
  const { captureClaudeAccount } = await import("../claude-capture.js");
  await captureClaudeAccount({
    label: account.label,
    register: true,
  });

  // Allow a refresh retry after a prior 429 backoff for this slot.
  await clearRefreshBackoff(refreshFp(fileOauth));
  await clearRefreshBackoff(refreshFp(liveOauth));

  return { ok: true, plan: livePlan };
}

function windowsFromUsage(usage: UsageResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  if (Array.isArray(usage.limits) && usage.limits.length > 0) {
    for (const lim of usage.limits) {
      const kind = lim.kind ?? "limit";
      let id = kind;
      let label: string;
      if (kind === "session") {
        label = "Current session";
        id = "session";
      } else if (kind === "weekly_all") {
        label = "Weekly · All models";
        id = "weekly";
      } else if (kind === "weekly_scoped") {
        const name = lim.scope?.model?.display_name ?? "Scoped";
        label = `Weekly · ${name}`;
        id = `weekly:${name.toLowerCase().replace(/\s+/g, "-")}`;
      } else {
        label = kind.replace(/_/g, " ");
      }
      const resetsAt = lim.resets_at ?? null;
      windows.push({
        id,
        label,
        usedPercent: lim.percent ?? null,
        resetsAt,
        resetsInSeconds: secondsUntil(resetsAt),
        windowSeconds: kind === "weekly_all" || kind === "weekly_scoped"
          ? WEEK_SECONDS
          : undefined,
      });
    }
  } else {
    if (usage.five_hour) {
      windows.push({
        id: "session",
        label: "Current session",
        usedPercent: usage.five_hour.utilization ?? null,
        resetsAt: usage.five_hour.resets_at ?? null,
        resetsInSeconds: secondsUntil(usage.five_hour.resets_at),
      });
    }
    if (usage.seven_day) {
      windows.push({
        id: "weekly",
        label: "Weekly · All models",
        usedPercent: usage.seven_day.utilization ?? null,
        resetsAt: usage.seven_day.resets_at ?? null,
        resetsInSeconds: secondsUntil(usage.seven_day.resets_at),
        windowSeconds: WEEK_SECONDS,
      });
    }
  }

  // Usage credits / extra usage summary
  const extra = usage.extra_usage;
  const spend = usage.spend;
  if (extra || spend) {
    const enabled = spend?.enabled ?? extra?.is_enabled ?? false;
    if (!enabled) {
      windows.push({
        id: "credits",
        label: "Usage credits",
        usedPercent: null,
        resetsAt: null,
        extra: { status: "off" },
      });
    } else {
      windows.push({
        id: "credits",
        label: "Usage credits",
        usedPercent: spend?.percent ?? extra?.utilization ?? null,
        resetsAt: null,
        extra: {
          used_credits: extra?.used_credits ?? null,
          spend_minor: spend?.used?.amount_minor ?? null,
        },
      });
    }
  }

  return windows;
}

export class ClaudeProvider implements Provider {
  readonly name = "claude" as const;

  async fetchUsage(account: AccountConfig): Promise<ProviderSnapshot> {
    return this.fetchUsageInner(account, { allowRehydrate: true });
  }

  private async fetchUsageInner(
    account: AccountConfig,
    opts: { allowRehydrate: boolean },
  ): Promise<ProviderSnapshot> {
    const fetchedAt = nowIso();
    let fileOauthForRehydrate: ClaudeOauth | null = null;
    try {
      const store = await loadCredentials(account);
      let oauth = store.data.claudeAiOauth!;
      fileOauthForRehydrate = oauth;
      let writeWarning: string | undefined;
      const sourceLabel =
        store.kind === "keychain" ? "keychain" : "credentials_file";
      let fp = refreshFp(oauth);

      // Prefer a fresher live keychain token for the same login (if any).
      oauth = await adoptFresherLiveTokens(store, oauth);
      fp = refreshFp(oauth);
      let accessToken = oauth.accessToken;

      // 1) Always try usage with the current access token first.
      //    Tokens often still work past expiresAt; this avoids refresh spam.
      let usageResult = await fetchUsageApi(accessToken, account.id);

      // 2) Only refresh on 401 (or missing token), not merely because of expiresAt.
      if (!usageResult.ok && usageResult.status === 401) {
        if (!oauth.refreshToken) {
          throw new Error("Claude access token rejected and no refresh token");
        }
        const refreshed = await refreshAccessToken(oauth.refreshToken, fp);
        accessToken = refreshed.accessToken;
        const nextOauth: ClaudeOauth = {
          ...oauth,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? oauth.refreshToken,
          expiresAt: refreshed.expiresAt ?? oauth.expiresAt,
        };
        oauth = nextOauth;
        const next: ClaudeCredentials = {
          ...store.data,
          claudeAiOauth: nextOauth,
        };
        const persisted = await persistCredentials(
          { ...store, data: next },
          next,
        );
        if (!persisted.ok) writeWarning = persisted.warning;
        usageResult = await fetchUsageApi(accessToken, account.id);
      }

      // 3) Optional proactive refresh when token is near expiry but usage
      //    still worked — do it only if not backed off, best-effort.
      const nearExpiry =
        typeof oauth.expiresAt === "number" &&
        oauth.expiresAt - REFRESH_SKEW_MS <= Date.now();
      if (
        usageResult.ok &&
        nearExpiry &&
        oauth.refreshToken &&
        !(await isRefreshBackedOff(fp))
      ) {
        try {
          const refreshed = await refreshAccessToken(oauth.refreshToken, fp);
          const nextOauth: ClaudeOauth = {
            ...oauth,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? oauth.refreshToken,
            expiresAt: refreshed.expiresAt ?? oauth.expiresAt,
          };
          const next: ClaudeCredentials = {
            ...store.data,
            claudeAiOauth: nextOauth,
          };
          await persistCredentials({ ...store, data: next }, next);
        } catch {
          /* usage already ok; ignore proactive refresh failure */
        }
      }

      if (!usageResult.ok) {
        throw new Error(`Claude usage API HTTP ${usageResult.status}`);
      }

      const usage = usageResult.usage;
      await writeUsageCache(account.id, {
        fetchedAt,
        usage,
        plan: formatPlan(oauth),
        sourceLabel,
      });
      return buildSnapshot(
        account,
        oauth,
        usage,
        sourceLabel,
        fetchedAt,
        writeWarning,
      );
    } catch (e) {
      const usageRateLimited = e instanceof UsageRateLimitedError;
      // A 429 from either the usage API or the OAuth token endpoint says
      // nothing about the account, so last good usage stays worth showing.
      const rateLimited =
        usageRateLimited || (e instanceof RefreshError && e.status === 429);

      // One-shot: if this slot's file is stale but Claude Code is currently
      // logged into the same plan/account, re-run save-claude and retry once.
      // Not on a usage 429 — the token is fine, and retrying spends another
      // request against the very limit we just hit. (A refresh 429 still
      // tries: the live login may already hold a fresh token.)
      if (opts.allowRehydrate && fileOauthForRehydrate && !usageRateLimited) {
        try {
          const re = await tryRehydrateFromLiveLogin(
            account,
            fileOauthForRehydrate,
          );
          if (re.ok) {
            const retry = await this.fetchUsageInner(account, {
              allowRehydrate: false,
            });
            if (retry.ok) {
              retry.extras = {
                ...retry.extras,
                rehydrated: true,
                rehydratedPlan: re.plan,
              };
            }
            return retry;
          }
        } catch {
          /* fall through to cache / error */
        }
      }

      // Prefer cache over a hard error (esp. 429 storms). A rate limit says
      // nothing about the account, so older data is still worth showing then.
      const cached = await readUsageCache(account.id);
      if (cached) {
        const ageMs = Date.now() - Date.parse(cached.fetchedAt);
        const ttlMs = rateLimited ? RATE_LIMITED_CACHE_TTL_MS : USAGE_CACHE_TTL_MS;
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlMs) {
          // Age is shown by the renderer ("updated … ago") once it matters.
          const snap = buildSnapshot(
            account,
            { accessToken: "" },
            cached.usage,
            `${cached.sourceLabel ?? "cache"}+stale`,
            cached.fetchedAt,
            `showing last saved usage — ${e instanceof Error ? e.message : String(e)}`,
          );
          if (cached.plan) snap.plan = cached.plan;
          snap.provenance = "partial";
          snap.ok = true;
          return snap;
        }
      }

      return {
        provider: "claude",
        accountId: account.id,
        label: account.label,
        ok: false,
        error: formatFetchError(e),
        source: "oauth",
        provenance: "unknown",
        windows: [],
        fetchedAt,
      };
    }
  }
}

function buildSnapshot(
  account: AccountConfig,
  oauth: ClaudeOauth,
  usage: UsageResponse,
  sourceLabel: string,
  fetchedAt: string,
  writeWarning?: string,
): ProviderSnapshot {
  const extras: Record<string, unknown> = {
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: planTier(oauth) || null,
  };
  if (writeWarning) extras.warning = writeWarning;
  if (usage.spend) extras.spend = usage.spend;
  if (usage.extra_usage) extras.extra_usage = usage.extra_usage;

  return {
    provider: "claude",
    accountId: account.id,
    label: account.label,
    ok: true,
    plan: formatPlan(oauth),
    email: null,
    source: sourceLabel,
    provenance: "official",
    windows: windowsFromUsage(usage),
    extras,
    fetchedAt,
  };
}

export const claudeProvider = new ClaudeProvider();
