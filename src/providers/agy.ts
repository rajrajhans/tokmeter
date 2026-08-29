import type { AccountConfig, ProviderSnapshot } from "../types.js";
import { nowIso } from "../utils/time.js";
import type { Provider } from "./types.js";
import { collectAgyLocalStats } from "../stats/agy-local.js";

export class AgyProvider implements Provider {
  readonly name = "agy" as const;

  async fetchUsage(account: AccountConfig): Promise<ProviderSnapshot> {
    const fetchedAt = nowIso();
    
    const local = await collectAgyLocalStats();
    let sessions = 0;
    if (local && local.lines.length > 0) {
       const match = local.lines[0].value.match(/(\d+)/);
       if (match) sessions = parseInt(match[1], 10);
    }
    
    // Antigravity doesn't expose a public cloud quota API without auth reversing,
    // so we estimate usage based on a local daily session capacity.
    const capacity = 50;
    const pct = Math.min(100, Math.round((sessions / capacity) * 100));
    
    return {
      provider: "agy",
      accountId: account.id,
      label: account.label,
      ok: true,
      plan: "Local",
      email: null,
      source: "local",
      provenance: "local_estimate",
      windows: [
        {
          id: "activity",
          label: "Daily capacity",
          usedPercent: pct,
          resetsAt: null,
        }
      ],
      extras: {},
      fetchedAt,
    };
  }
}

export const agyProvider = new AgyProvider();
