import type { AccountConfig, LocalStats, ProviderName, ProviderSnapshot } from "../types.js";
import { collectClaudeLocalStats } from "./claude-local.js";
import { collectCodexLocalStats } from "./codex-local.js";
import { collectCursorLocalStats } from "./cursor-local.js";
import { collectGrokLocalStats } from "./grok-local.js";

/**
 * Attach machine-local activity stats once per provider (first account only)
 * so multi-Claude slots don't print the same today-totals three times.
 */
export async function attachLocalStats(
  snapshots: ProviderSnapshot[],
  accounts: AccountConfig[],
): Promise<ProviderSnapshot[]> {
  const need = new Set(snapshots.map((s) => s.provider));
  const cache = new Map<ProviderName, LocalStats | null>();

  await Promise.all(
    [...need].map(async (provider) => {
      try {
        if (provider === "claude") {
          cache.set(provider, await collectClaudeLocalStats());
        } else if (provider === "codex") {
          const home = accounts.find((a) => a.provider === "codex")?.codexHome;
          cache.set(provider, await collectCodexLocalStats(home));
        } else if (provider === "grok") {
          const home = accounts.find((a) => a.provider === "grok")?.grokHome;
          cache.set(provider, await collectGrokLocalStats(home));
        } else if (provider === "cursor") {
          const acct = accounts.find((a) => a.provider === "cursor");
          cache.set(provider, await collectCursorLocalStats(acct));
        }
      } catch {
        cache.set(provider, null);
      }
    }),
  );

  const attached = new Set<ProviderName>();
  return snapshots.map((s) => {
    if (attached.has(s.provider)) return s;
    const local = cache.get(s.provider);
    if (!local || local.lines.length === 0) return s;
    attached.add(s.provider);
    return { ...s, local };
  });
}
