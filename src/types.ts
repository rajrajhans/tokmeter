export type ProviderName = "claude" | "codex" | "grok" | "cursor";

export type AccountSource =
  | "auto"
  | "keychain"
  | "credentials_file"
  | "auth_file";

export type AccountConfig = {
  id: string;
  provider: ProviderName;
  label: string;
  source?: AccountSource;
  /** Override path for Claude credentials JSON */
  credentialsPath?: string;
  /** Override CODEX_HOME for this account */
  codexHome?: string;
  /** Override GROK_HOME for this account */
  grokHome?: string;
  /** Override CURSOR_HOME for this account */
  cursorHome?: string;
  /** Override keychain service name (Claude credentials blob / Cursor access token) */
  keychainService?: string;
};

export type TokmeterConfig = {
  accounts: AccountConfig[];
  /**
   * Providers the user explicitly removed. Auto-discovery backfills providers
   * missing from `accounts` (so a newly-installed CLI shows up without
   * `accounts add`) — this list is what makes `accounts remove` stick.
   */
  dismissed?: ProviderName[];
};

export type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  resetsInSeconds?: number | null;
  extra?: Record<string, unknown>;
};

export type Provenance =
  | "official"
  | "local_estimate"
  | "partial"
  | "unknown";

/** Machine-local activity stats (from JSONL / signals — not plan quotas). */
export type LocalStatsLine = {
  label: string;
  value: string;
};

export type LocalStats = {
  period: string;
  /** "local" = on-disk logs only; "mixed" = on-disk sessions + provider usage API. */
  source: "local" | "mixed";
  lines: LocalStatsLine[];
  raw?: Record<string, unknown>;
};

export type ProviderSnapshot = {
  provider: ProviderName;
  accountId: string;
  label: string;
  ok: boolean;
  error?: string;
  plan?: string | null;
  email?: string | null;
  source: string;
  provenance: Provenance;
  windows: UsageWindow[];
  /** Local activity (tokens today, models, …) — often machine-wide per provider. */
  local?: LocalStats | null;
  extras?: Record<string, unknown>;
  fetchedAt: string;
};
