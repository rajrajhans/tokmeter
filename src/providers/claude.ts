import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userInfo } from "node:os";
import type { AccountConfig, ProviderSnapshot, UsageWindow } from "../types.js";
import {
  defaultClaudeCredentialsPath,
  defaultClaudeKeychainService,
} from "../config.js";
import { pathExists, readJsonFile, writeJsonFile } from "../utils/fs.js";
import { nowIso, secondsUntil } from "../utils/time.js";
import type { Provider } from "./types.js";

const execFileAsync = promisify(execFile);

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];
const USER_AGENT = "claude-code/2.1.71";
const REFRESH_SKEW_MS = 60_000;

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
  const sub = oauth.subscriptionType ?? "unknown";
  const tier = planTier(oauth);
  if (tier.includes("20x") || /max_20x/i.test(tier)) return "Max 20x";
  if (tier.includes("5x") || /max_5x/i.test(tier)) return "Max 5x";
  if (sub === "max") return "Max";
  if (sub === "pro") return "Pro";
  if (sub === "team") return "Team";
  return sub.charAt(0).toUpperCase() + sub.slice(1);
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
  const source = account.source ?? "auto";
  const filePath = account.credentialsPath ?? defaultClaudeCredentialsPath();

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
      throw new Error(
        `Claude keychain service not found: ${service}`,
      );
    }
  }

  if (source === "credentials_file" || source === "auto" || source === "auth_file") {
    if (await pathExists(filePath)) {
      const data = await readJsonFile<ClaudeCredentials>(filePath);
      if (data?.claudeAiOauth?.accessToken) {
        return { kind: "file", path: filePath, data };
      }
    }
    if (source === "credentials_file" || source === "auth_file") {
      throw new Error(`Claude credentials file missing or invalid: ${filePath}`);
    }
  }

  throw new Error(
    "No Claude credentials found (keychain or ~/.claude/.credentials.json)",
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

async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  let lastErr = "refresh failed";
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
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt,
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`Claude token refresh failed: ${lastErr}`);
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
    const fetchedAt = nowIso();
    try {
      const store = await loadCredentials(account);
      const oauth = store.data.claudeAiOauth!;
      let accessToken = oauth.accessToken;
      let writeWarning: string | undefined;
      const sourceLabel =
        store.kind === "keychain" ? "keychain" : "credentials_file";

      const expired =
        typeof oauth.expiresAt === "number" &&
        oauth.expiresAt - REFRESH_SKEW_MS <= Date.now();

      if (expired) {
        if (!oauth.refreshToken) {
          throw new Error("Claude access token expired and no refresh token");
        }
        const refreshed = await refreshAccessToken(oauth.refreshToken);
        accessToken = refreshed.accessToken;
        const next: ClaudeCredentials = {
          ...store.data,
          claudeAiOauth: {
            ...oauth,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? oauth.refreshToken,
            expiresAt: refreshed.expiresAt ?? oauth.expiresAt,
          },
        };
        const persisted = await persistCredentials(store, next);
        if (!persisted.ok) writeWarning = persisted.warning;
      }

      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": USER_AGENT,
        },
      });

      if (!res.ok) {
        // One retry after forced refresh on 401
        if (res.status === 401 && oauth.refreshToken) {
          const refreshed = await refreshAccessToken(oauth.refreshToken);
          accessToken = refreshed.accessToken;
          const next: ClaudeCredentials = {
            ...store.data,
            claudeAiOauth: {
              ...oauth,
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken ?? oauth.refreshToken,
              expiresAt: refreshed.expiresAt ?? oauth.expiresAt,
            },
          };
          const persisted = await persistCredentials(store, next);
          if (!persisted.ok) writeWarning = persisted.warning;

          const retry = await fetch(USAGE_URL, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "anthropic-beta": "oauth-2025-04-20",
              "User-Agent": USER_AGENT,
            },
          });
          if (!retry.ok) {
            throw new Error(`Claude usage API HTTP ${retry.status}`);
          }
          const usage = (await retry.json()) as UsageResponse;
          return buildSnapshot(account, oauth, usage, sourceLabel, fetchedAt, writeWarning);
        }
        throw new Error(`Claude usage API HTTP ${res.status}`);
      }

      const usage = (await res.json()) as UsageResponse;
      return buildSnapshot(account, oauth, usage, sourceLabel, fetchedAt, writeWarning);
    } catch (e) {
      return {
        provider: "claude",
        accountId: account.id,
        label: account.label,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
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
