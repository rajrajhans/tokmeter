import type { AccountConfig, ProviderSnapshot } from "../types.js";

export interface Provider {
  readonly name: "claude" | "codex" | "grok";
  fetchUsage(account: AccountConfig): Promise<ProviderSnapshot>;
}
