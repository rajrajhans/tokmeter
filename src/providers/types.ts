import type { AccountConfig, ProviderName, ProviderSnapshot } from "../types.js";

export interface Provider {
  readonly name: ProviderName;
  fetchUsage(account: AccountConfig): Promise<ProviderSnapshot>;
}
