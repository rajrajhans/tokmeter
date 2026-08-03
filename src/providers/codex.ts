import { join } from "node:path";
import type { AccountConfig, ProviderSnapshot, UsageWindow } from "../types.js";
import { defaultCodexHome } from "../config.js";
import { expandHome, pathExists, readJsonFile } from "../utils/fs.js";
import { nowIso, secondsUntil } from "../utils/time.js";
import type { Provider } from "./types.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

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

function decodeJwtEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
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
      const accessToken = auth.tokens?.access_token;
      const accountId = auth.tokens?.account_id;
      if (!accessToken) {
        throw new Error("Codex auth.json missing tokens.access_token");
      }
      if (!accountId) {
        throw new Error("Codex auth.json missing tokens.account_id");
      }

      const email =
        decodeJwtEmail(auth.tokens?.id_token) ?? null;

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
        throw new Error(`Codex usage API HTTP ${res.status}`);
      }

      const usage = (await res.json()) as CodexUsage;
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
        source: "auth_file",
        provenance: "official",
        windows,
        extras: {
          auth_mode: auth.auth_mode ?? null,
          chatgpt_account_id: accountId,
        },
        fetchedAt,
      };
    } catch (e) {
      return {
        provider: "codex",
        accountId: account.id,
        label: account.label,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        source: "auth_file",
        provenance: "unknown",
        windows: [],
        fetchedAt,
      };
    }
  }
}

export const codexProvider = new CodexProvider();
