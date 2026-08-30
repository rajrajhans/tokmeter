import type { AccountConfig, ProviderName, ProviderSnapshot } from "../types.js";
import { collectLocalStatsFor, localStatsOwners } from "../stats/index.js";
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

export const MAX_ATTEMPTS = 3;
/** Delay before attempt 2 and 3. Kept short — a retry must not feel like a hang. */
const RETRY_DELAYS_MS = [600, 1500];
/**
 * Stop retrying an account that has already spent this long. Without it a
 * provider that fails on its own 30s timeout would triple the whole run.
 */
const RETRY_BUDGET_MS = 20_000;

/**
 * Failures that another attempt cannot fix — bad/expired credentials, or a
 * rate-limit we are already backing off from (see utils/backoff.ts). Retrying
 * these burns the refresh budget and makes the wait longer for no reason.
 */
const TERMINAL_ERROR =
  /\b(400|401|403|404|429)\b|rate.?limit|backing off|unauthor|forbidden|credential|expired|refresh token|log ?in|sign ?in|not found|no such file|unknown provider/i;

/** Failures that are usually the network having a bad moment. */
const TRANSIENT_ERROR =
  /fetch failed|socket hang up|network|timed? ?out|timeout|abort|\bHTTP 5\d\d\b|E(CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH|NOTFOUND|PIPE|AI_AGAIN)|UND_ERR/i;

export function isRetryableError(message: string | undefined): boolean {
  if (!message) return false;
  if (TERMINAL_ERROR.test(message)) return false;
  return TRANSIENT_ERROR.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorSnapshot(
  account: AccountConfig,
  error: string,
): ProviderSnapshot {
  return {
    provider: account.provider,
    accountId: account.id,
    label: account.label,
    ok: false,
    error,
    source: "unknown",
    provenance: "unknown",
    windows: [],
    fetchedAt: new Date().toISOString(),
  };
}

export type RetryInfo = {
  /** The attempt about to start (2-based — attempt 1 already failed). */
  attempt: number;
  maxAttempts: number;
  reason: string;
  delayMs: number;
};

export type FetchSnapshotsOptions = {
  /** Scan local JSONL / signals for activity lines (used by `tokmeter stats`). */
  includeLocal?: boolean;
  /** Called during the backoff wait, so a live UI can say why it is still spinning. */
  onRetry?: (index: number, info: RetryInfo) => void;
  /** Called when a retry attempt actually starts (i.e. the wait is over). */
  onAttempt?: (index: number, attempt: number, maxAttempts: number) => void;
  /** Called as soon as one account is fully resolved, in completion order. */
  onSettled?: (index: number, snapshot: ProviderSnapshot) => void;
};

async function fetchOnce(account: AccountConfig): Promise<ProviderSnapshot> {
  const p = getProvider(account.provider);
  if (!p) {
    return errorSnapshot(
      account,
      `Unknown provider "${account.provider}" (account ${account.id})`,
    );
  }
  try {
    return await p.fetchUsage(account);
  } catch (e) {
    return errorSnapshot(account, e instanceof Error ? e.message : String(e));
  }
}

async function fetchWithRetry(
  account: AccountConfig,
  index: number,
  opts: FetchSnapshotsOptions,
): Promise<ProviderSnapshot> {
  const startedAt = Date.now();
  let last = await fetchOnce(account);

  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    if (last.ok) return last;
    const delayMs = RETRY_DELAYS_MS[attempt - 2];
    if (delayMs == null) break;
    if (!isRetryableError(last.error)) break;
    if (Date.now() - startedAt > RETRY_BUDGET_MS) break;

    opts.onRetry?.(index, {
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      reason: last.error ?? "unknown error",
      delayMs,
    });
    await sleep(delayMs);
    opts.onAttempt?.(index, attempt, MAX_ATTEMPTS);
    last = await fetchOnce(account);
  }

  return last;
}

/**
 * Resolve every account concurrently, reporting each one the moment it lands.
 *
 * The returned array stays in `accounts` order regardless of who finishes
 * first; `onSettled` is what fires in completion order.
 */
export async function fetchSnapshots(
  accounts: AccountConfig[],
  opts: FetchSnapshotsOptions = {},
): Promise<ProviderSnapshot[]> {
  const owners = opts.includeLocal
    ? localStatsOwners(accounts)
    : new Map<ProviderName, number>();

  return Promise.all(
    accounts.map(async (account, index) => {
      // Local scans are disk-bound and independent of the quota API, so run
      // them alongside the fetch rather than after every account has landed.
      const localPromise =
        owners.get(account.provider) === index
          ? collectLocalStatsFor(account.provider, accounts)
          : Promise.resolve(null);

      const [snapshot, local] = await Promise.all([
        fetchWithRetry(account, index, opts),
        localPromise,
      ]);

      const resolved =
        local && local.lines.length > 0 ? { ...snapshot, local } : snapshot;
      opts.onSettled?.(index, resolved);
      return resolved;
    }),
  );
}

export { claudeProvider, codexProvider, cursorProvider, grokProvider, agyProvider };
