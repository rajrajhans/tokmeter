export type ProviderName = "claude" | "codex" | "grok";

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
  /** Override macOS keychain service name for Claude */
  keychainService?: string;
};

export type TokmeterConfig = {
  accounts: AccountConfig[];
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
  extras?: Record<string, unknown>;
  fetchedAt: string;
};
