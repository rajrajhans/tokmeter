import type { AccountConfig, ProviderName, ProviderSnapshot } from "../types.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { grokProvider } from "./grok.js";
import type { Provider } from "./types.js";

const providers: Record<ProviderName, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
  grok: grokProvider,
};

export function getProvider(name: ProviderName): Provider {
  return providers[name];
}

export async function fetchAllSnapshots(
  accounts: AccountConfig[],
): Promise<ProviderSnapshot[]> {
  const results = await Promise.allSettled(
    accounts.map((account) => {
      const p = getProvider(account.provider);
      return p.fetchUsage(account);
    }),
  );

  return results.map((r, i) => {
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
}

export { claudeProvider, codexProvider, grokProvider };
