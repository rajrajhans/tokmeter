import type { AccountConfig, ProviderName, ProviderSnapshot } from "../types.js";
import { attachLocalStats } from "../stats/index.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { cursorProvider } from "./cursor.js";
import { grokProvider } from "./grok.js";
import { agyProvider } from "./agy.js";
import type { Provider } from "./types.js";

const providers: Record<ProviderName, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
  grok: grokProvider,
  cursor: cursorProvider,
  agy: agyProvider,
};

export function getProvider(name: string): Provider | undefined {
  return Object.hasOwn(providers, name)
    ? providers[name as ProviderName]
    : undefined;
}

export type FetchSnapshotsOptions = {
  /** Scan local JSONL / signals for activity lines (used by `tokmeter stats`). */
  includeLocal?: boolean;
};

export async function fetchAllSnapshots(
  accounts: AccountConfig[],
  opts: FetchSnapshotsOptions = {},
): Promise<ProviderSnapshot[]> {
  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const p = getProvider(account.provider);
      if (!p) {
        throw new Error(
          `Unknown provider "${account.provider}" (account ${account.id})`,
        );
      }
      return p.fetchUsage(account);
    }),
  );

  const snapshots = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const account = accounts[i];
    return {
      provider: account.provider,
      accountId: account.id,
      label: account.label,
      ok: false,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      source: "unknown",
      provenance: "unknown" as const,
      windows: [],
      fetchedAt: new Date().toISOString(),
    };
  });

  if (opts.includeLocal) {
    return attachLocalStats(snapshots, accounts);
  }
  return snapshots;
}

export { claudeProvider, codexProvider, cursorProvider, grokProvider, agyProvider };
