import type { AccountConfig, LocalStats, ProviderName } from "../types.js";
import { collectClaudeLocalStats } from "./claude-local.js";
import { collectCodexLocalStats } from "./codex-local.js";
import { collectCursorLocalStats } from "./cursor-local.js";
import { collectGrokLocalStats } from "./grok-local.js";
import { collectAgyLocalStats } from "./agy-local.js";

/**
 * Machine-local activity for one provider. Scans on-disk JSONL / signals —
 * `accounts` only supplies the per-provider home overrides.
 */
export async function collectLocalStatsFor(
  provider: ProviderName,
  accounts: AccountConfig[],
): Promise<LocalStats | null> {
  try {
    if (provider === "claude") return await collectClaudeLocalStats();
    if (provider === "codex") {
      const home = accounts.find((a) => a.provider === "codex")?.codexHome;
      return await collectCodexLocalStats(home);
    }
    if (provider === "grok") {
      const home = accounts.find((a) => a.provider === "grok")?.grokHome;
      return await collectGrokLocalStats(home);
    }
    if (provider === "cursor") {
      const acct = accounts.find((a) => a.provider === "cursor");
      return await collectCursorLocalStats(acct);
    }
    if (provider === "agy") return await collectAgyLocalStats();
  } catch {
    return null;
  }
  return null;
}

/**
 * Index of the account that "owns" each provider's local stats — the first one
 * in list order, so multi-Claude slots don't print the same today-totals three
 * times.
 */
export function localStatsOwners(
  accounts: AccountConfig[],
): Map<ProviderName, number> {
  const owners = new Map<ProviderName, number>();
  accounts.forEach((a, i) => {
    if (!owners.has(a.provider)) owners.set(a.provider, i);
  });
  return owners;
}
