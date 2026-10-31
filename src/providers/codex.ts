import { join } from "node:path";
import type { AccountConfig, ProviderSnapshot, UsageWindow } from "../types.js";
import { defaultCodexHome } from "../config.js";
import {
  expandHome,
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
} from "../utils/fs.js";
import {
  cacheRoot,
  clearBackoff,
  isBackedOff,
  markBackoff,
} from "../utils/backoff.js";
import { acquireLock } from "../utils/lock.js";
import { formatFetchError } from "../utils/network.js";
import { nowIso, secondsUntil } from "../utils/time.js";
import type { Provider } from "./types.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * Public OAuth client the Codex CLI ships with (taken from the `client_id`
 * claim of its own access token) — not a secret.
 */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OIDC_ISSUER = "https://auth.openai.com";
const BACKOFF_FILE = "codex-refresh-backoff.json";
/** After a refresh rejection, don't hit the token endpoint again this soon. */
const REFRESH_BACKOFF_MS = 10 * 60_000;
/** Refresh proactively once the access token is this close to expiry. */
const REFRESH_SKEW_MS = 60_000;

type CodexTokens = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
};

type CodexAuth = {
  auth_mode?: string;
  tokens?: CodexTokens;
  OPENAI_API_KEY?: string;
  last_refresh?: string;
};

type RateWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

type CodexUsage = {
  email?: string;
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: RateWindow | null;
    secondary_window?: RateWindow | null;
  };
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | number;
  };
  rate_limit_reset_credits?: {
    available_count?: number;
    applicable_available_count?: number;
  };
};

function decodeJwt<T>(token: string | undefined): T | null {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as T;
  } catch {
    return null;
  }
}

function decodeJwtEmail(idToken: string | undefined): string | null {
  return decodeJwt<{ email?: string }>(idToken)?.email ?? null;
}

/** True when the access token's `exp` claim has passed (or is about to). */
function isAccessTokenExpired(accessToken: string | undefined): boolean {
  const exp = decodeJwt<{ exp?: number }>(accessToken)?.exp;
  if (typeof exp !== "number") return false; // unknown → let the API decide
  return exp * 1000 - REFRESH_SKEW_MS <= Date.now();
}

/* ------------------------------------------------------------------ *
 * OAuth refresh — recover an expired access token without `codex login`
 * ------------------------------------------------------------------ */

function refreshFp(tokens: CodexTokens): string {
  const r = tokens.refresh_token;
  if (r && r.length >= 12) return r.slice(-12);
  return (tokens.access_token ?? "").slice(-12);
}

type RefreshOutcome =
  | { ok: true; tokens: CodexTokens; adopted?: boolean }
  | { ok: false; note: string };

/**
 * Exchange the stored refresh token for a fresh access token and write the
 * rotated credentials back to auth.json, so the Codex CLI stays logged in too.
 *
 * Codex has no lock convention of its own, so the lock lives in tokmeter's
 * cache dir — enough to serialise concurrent tokmeter runs without dropping
 * unexpected files into CODEX_HOME.
 */
async function refreshCodexAuth(
  authPath: string,
  auth: CodexAuth,
): Promise<RefreshOutcome> {
  const tokens = auth.tokens ?? {};
  const refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    return {
      ok: false,
      note: "no refresh token in auth.json — run codex login",
    };
  }

  const fp = refreshFp(tokens);
  const backedOffUntil = await isBackedOff(BACKOFF_FILE, fp);
  if (backedOffUntil) {
    const mins = Math.max(1, Math.ceil((backedOffUntil - Date.now()) / 60_000));
    return {
      ok: false,
      note: `refresh failed recently; retrying in ~${mins}m — run codex login`,
    };
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(join(cacheRoot(), "codex-refresh.lock"));

    // Re-read under the lock: another process may have refreshed already, in
    // which case our refresh token is spent and theirs is the live one.
    const current = await readJsonFile<CodexAuth>(authPath);
    const latest = current.tokens;
    if (latest?.access_token && latest.refresh_token !== refreshToken) {
      return { ok: true, tokens: latest, adopted: true };
    }

    const res = await fetch(`${OIDC_ISSUER}/api/accounts/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
        scope: "openid profile email",
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const err = JSON.parse(bodyText) as {
          error?: string | { message?: string };
          error_description?: string;
        };
        if (typeof err.error === "string") {
          detail = err.error_description ?? err.error;
        } else if (err.error?.message) {
          detail = err.error.message;
        }
      } catch {
        /* keep HTTP status */
      }
      // invalid_grant means the refresh token itself is dead — only a real
      // login fixes that, so back off rather than retrying every render.
      await markBackoff(BACKOFF_FILE, fp, REFRESH_BACKOFF_MS, res.status);
      return {
        ok: false,
        note: `refresh rejected (${detail}) — run codex login`,
      };
    }

    const body = JSON.parse(bodyText) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };
    if (!body.access_token) {
      await markBackoff(BACKOFF_FILE, fp, REFRESH_BACKOFF_MS, res.status);
      return { ok: false, note: "refresh response had no access_token" };
    }

    const nextTokens: CodexTokens = {
      ...(latest ?? tokens),
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? refreshToken,
      id_token: body.id_token ?? latest?.id_token ?? tokens.id_token,
    };
    // Preserve every other field verbatim — this file is the Codex CLI's.
    await writeJsonFileAtomic(authPath, {
      ...current,
      tokens: nextTokens,
      last_refresh: nowIso(),
    });
    await clearBackoff(BACKOFF_FILE, fp);
    return { ok: true, tokens: nextTokens };
  } catch (e) {
    return { ok: false, note: formatFetchError(e) };
  } finally {
    if (release) await release();
  }
}

type UsageResult =
  | { ok: true; usage: CodexUsage }
  /** `authLikely` = the failure looks like a bad/expired token. */
  | { ok: false; status: number; authLikely: boolean };

async function fetchCodexUsage(
  accessToken: string,
  accountId: string,
): Promise<UsageResult> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      "ChatGPT-Account-ID": accountId,
      "OpenAI-Beta": "codex-1",
      originator: "tokmeter",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      authLikely: res.status === 401 || res.status === 403,
    };
  }
  return { ok: true, usage: (await res.json()) as CodexUsage };
}

function windowFromRate(
  id: string,
  label: string,
  w: RateWindow | null | undefined,
): UsageWindow | null {
  if (!w) return null;
  const resetAtUnix = w.reset_at;
  const resetsAt =
    typeof resetAtUnix === "number"
      ? new Date(
          resetAtUnix < 1e12 ? resetAtUnix * 1000 : resetAtUnix,
        ).toISOString()
      : null;
  const resetsInSeconds =
    typeof w.reset_after_seconds === "number"
      ? w.reset_after_seconds
      : secondsUntil(resetsAt);

  let fullLabel = label;
  if (typeof w.limit_window_seconds === "number") {
    const days = Math.round(w.limit_window_seconds / 86400);
    if (days >= 1) fullLabel = `${label} (${days}d)`;
    else {
      const hours = Math.round(w.limit_window_seconds / 3600);
      if (hours >= 1) fullLabel = `${label} (${hours}h)`;
    }
  }

  return {
    id,
    label: fullLabel,
    usedPercent: w.used_percent ?? null,
    resetsAt,
    resetsInSeconds,
    windowSeconds: w.limit_window_seconds,
  };
}

export class CodexProvider implements Provider {
  readonly name = "codex" as const;

  async fetchUsage(account: AccountConfig): Promise<ProviderSnapshot> {
    const fetchedAt = nowIso();
    try {
      const home = account.codexHome
        ? expandHome(account.codexHome)
        : defaultCodexHome();
      const authPath = join(home, "auth.json");
      if (!(await pathExists(authPath))) {
        throw new Error(`Codex auth not found: ${authPath}`);
      }

      const auth = await readJsonFile<CodexAuth>(authPath);
      let tokens = auth.tokens ?? {};
      if (!tokens.access_token) {
        throw new Error("Codex auth.json missing tokens.access_token");
      }
      if (!tokens.account_id) {
        throw new Error("Codex auth.json missing tokens.account_id");
      }

      let refreshed = false;
      let refreshAttempted = false;
      let refreshNote: string | null = null;

      // Expired token → refresh up front rather than spending a request we
      // know will 401.
      if (isAccessTokenExpired(tokens.access_token) && tokens.refresh_token) {
        refreshAttempted = true;
        const r = await refreshCodexAuth(authPath, auth);
        if (r.ok) {
          tokens = r.tokens;
          refreshed = !r.adopted;
        } else {
          refreshNote = r.note;
        }
      }

      let usageResult = await fetchCodexUsage(
        tokens.access_token!,
        tokens.account_id!,
      );

      // Reactive retry: the token was rejected even though it looked valid —
      // refresh once and try again.
      if (!usageResult.ok && usageResult.authLikely && !refreshAttempted) {
        if (tokens.refresh_token) {
          refreshAttempted = true;
          const r = await refreshCodexAuth(authPath, auth);
          if (r.ok) {
            tokens = r.tokens;
            refreshed = !r.adopted;
            refreshNote = null;
            usageResult = await fetchCodexUsage(
              tokens.access_token!,
              tokens.account_id!,
            );
          } else {
            refreshNote = r.note;
          }
        } else {
          refreshNote = "no refresh token in auth.json — run codex login";
        }
      }

      if (!usageResult.ok) {
        throw new Error(
          refreshNote
            ? `Codex usage API HTTP ${usageResult.status} — ${refreshNote}`
            : `Codex usage API HTTP ${usageResult.status}`,
        );
      }

      const accountId = tokens.account_id!;
      const email = decodeJwtEmail(tokens.id_token) ?? null;
      const usage = usageResult.usage;
      const windows: UsageWindow[] = [];

      const primary = windowFromRate(
        "primary",
        "Primary",
        usage.rate_limit?.primary_window,
      );
      if (primary) windows.push(primary);

      const secondary = windowFromRate(
        "secondary",
        "Secondary",
        usage.rate_limit?.secondary_window,
      );
      if (secondary) windows.push(secondary);

      if (usage.credits) {
        const bal = usage.credits.balance;
        windows.push({
          id: "credits",
          label: "Credits",
          usedPercent: null,
          resetsAt: null,
          extra: {
            balance: bal ?? 0,
            unlimited: usage.credits.unlimited ?? false,
            has_credits: usage.credits.has_credits ?? false,
          },
        });
      }

      const resetCredits = usage.rate_limit_reset_credits?.available_count;
      if (typeof resetCredits === "number" && resetCredits > 0) {
        windows.push({
          id: "reset-credits",
          label: "Rate-limit resets",
          usedPercent: null,
          resetsAt: null,
          extra: { available: resetCredits },
        });
      }

      return {
        provider: "codex",
        accountId: account.id,
        label: account.label,
        ok: true,
        plan: usage.plan_type ?? auth.auth_mode ?? null,
        email: usage.email ?? email,
        source: refreshed ? "auth_file+refreshed" : "auth_file",
        provenance: "official",
        windows,
        extras: {
          auth_mode: auth.auth_mode ?? null,
          chatgpt_account_id: accountId,
          ...(refreshed ? { refreshed: true } : {}),
          ...(refreshNote ? { refresh_note: refreshNote } : {}),
        },
        fetchedAt,
      };
    } catch (e) {
      return {
        provider: "codex",
        accountId: account.id,
        label: account.label,
        ok: false,
        error: formatFetchError(e),
        source: "auth_file",
        provenance: "unknown",
        windows: [],
        fetchedAt,
      };
    }
  }
}

export const codexProvider = new CodexProvider();
