import type { AccountConfig, ProviderSnapshot } from "../types.js";
import { nowIso } from "../utils/time.js";
import type { Provider } from "./types.js";

export class AgyProvider implements Provider {
  readonly name = "agy" as const;

  async fetchUsage(account: AccountConfig): Promise<ProviderSnapshot> {
    const fetchedAt = nowIso();
    
    return {
      provider: "agy",
      accountId: account.id,
      label: account.label,
      ok: true,
      plan: "Local",
      email: null,
      source: "local",
      provenance: "local_estimate",
      windows: [],
      extras: {},
      fetchedAt,
    };
  }
}

export const agyProvider = new AgyProvider();
