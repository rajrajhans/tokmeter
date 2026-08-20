import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AccountConfig, ProviderSnapshot, UsageWindow } from "../types.js";
import {
  cursorKeychainAccount,
  defaultCursorHome,
  defaultCursorKeychainService,
} from "../config.js";
import { pathExists, readJsonFile } from "../utils/fs.js";
import { formatFetchError } from "../utils/network.js";
import { nowIso, secondsUntil } from "../utils/time.js";
import type { Provider } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * cursor-agent talks Connect-RPC to aiserver.v1.DashboardService. The wire
 * format is plain Connect JSON (no protobuf framing), so a bare fetch works:
 * POST <endpoint>/aiserver.v1.DashboardService/<Method> with `{}`.
 */
const DEFAULT_ENDPOINT = "https://api2.cursor.sh";
const SERVICE = "aiserver.v1.DashboardService";

/** Anything above this is Cursor's int32 sentinel for "no cap". */
const UNLIMITED_DOLLARS = 1_000_000;

type PlanUsage = {
  totalSpend?: number;
  includedSpend?: number;
  bonusSpend?: number;
  remaining?: number;
  limit?: number;
  autoSpend?: number;
  apiSpend?: number;
  autoPercentUsed?: number;
  apiPercentUsed?: number;
  totalPercentUsed?: number;
};

type SpendLimitUsage = {
  totalSpend?: number;
  /** cents */
  individualLimit?: number;
  /** dollars (yes — Cursor mixes units here) */
  individualUsed?: number;
  individualRemaining?: number;
  limitType?: string;
};

type CurrentPeriodUsage = {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  planUsage?: PlanUsage;
  spendLimitUsage?: SpendLimitUsage;
  enabled?: boolean;
  displayMessage?: string;
};

type PlanInfoResponse = {
  planInfo?: {
    planName?: string;
    includedAmountCents?: number;
    price?: string;
    billingCycleEnd?: string;
  };
};

type HardLimitResponse = {
  hardLimit?: number;
  noUsageBasedAllowed?: boolean;
};

type CliConfig = {
  authInfo?: { email?: string; userId?: number };
};

function cursorEndpoint(): string {
  const raw = process.env.CURSOR_API_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
  return raw.replace(/\/+$/, "");
}

async function readKeychainSecret(service: string): Promise<string | null> {
  const account = cursorKeychainAccount();
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", service, "-a", account, "-w"],
        { timeout: 8000, maxBuffer: 1024 * 1024 },
      );
      return stdout.trim() || null;
    }
    if (process.platform === "linux") {
      const { stdout } = await execFileAsync(
        "secret-tool",
        ["lookup", "service", service, "account", account],
        { timeout: 8000, maxBuffer: 1024 * 1024 },
      );
      return stdout.trim() || null;
    }
  } catch {
    /* not present / locked */
  }
  return null;
}

/**
 * cursor-agent stores its session JWT in the OS keychain
 * (service `cursor-access-token`, account `cursor-user`). CURSOR_API_KEY wins
 * when set, matching the CLI's own precedence.
 */
export async function resolveCursorToken(
  account?: AccountConfig,
): Promise<string | null> {
  const envKey = process.env.CURSOR_API_KEY?.trim();
  if (envKey) return envKey;
  const service = account?.keychainService ?? defaultCursorKeychainService();
  return readKeychainSecret(service);
}

export async function cursorRpc<T>(
  method: string,
  token: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${cursorEndpoint()}/${SERVICE}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "connect-protocol-version": "1",
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "tokmeter",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Cursor auth rejected (HTTP ${res.status}) — run: cursor-agent login`,
    );
  }
  if (!res.ok) {
    throw new Error(`Cursor ${method} HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Connect encodes int64 as a JSON string; everything else arrives as number. */
function toMillis(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** Best-effort email without spending an extra GetMe round-trip. */
async function readCliEmail(home: string): Promise<string | null> {
  const path = join(home, "cli-config.json");
  if (!(await pathExists(path))) return null;
  try {
    const cfg = await readJsonFile<CliConfig>(path);
    return cfg.authInfo?.email ?? null;
  } catch {
    return null;
  }
}

/** Never let an optional side-call sink the whole snapshot. */
async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export class CursorProvider implements Provider {
  readonly name = "cursor" as const;

  async fetchUsage(account: AccountConfig): Promise<ProviderSnapshot> {
    const fetchedAt = nowIso();
    try {
      const token = await resolveCursorToken(account);
      if (!token) {
        throw new Error(
          "Cursor credentials not found — run: cursor-agent login (or set CURSOR_API_KEY)",
        );
      }

      const home = account.cursorHome ?? defaultCursorHome();
      const [usage, plan, hard, email] = await Promise.all([
        cursorRpc<CurrentPeriodUsage>("GetCurrentPeriodUsage", token),
        optional(cursorRpc<PlanInfoResponse>("GetPlanInfo", token)),
        optional(cursorRpc<HardLimitResponse>("GetHardLimit", token)),
        readCliEmail(home),
      ]);

      const windows: UsageWindow[] = [];
      const pu = usage.planUsage;

      // Cursor meters a monthly dollar pool, not a rolling token window. Its
      // own *PercentUsed fields are fractions of internal auto/api sub-budgets
      // and don't reconcile with totalSpend/limit — derive the bar from cents
      // so it matches the dollar figures, and keep the raw fields in --json.
      const limitCents =
        pu?.limit ?? plan?.planInfo?.includedAmountCents ?? null;
      const spentCents = pu?.totalSpend ?? null;
      const usedPercent =
        limitCents != null && limitCents > 0 && spentCents != null
          ? Math.min(100, Math.max(0, (spentCents / limitCents) * 100))
          : null;

      const cycleEndMs =
        toMillis(usage.billingCycleEnd) ??
        toMillis(plan?.planInfo?.billingCycleEnd);
      const resetsAt = cycleEndMs ? new Date(cycleEndMs).toISOString() : null;

      windows.push({
        id: "included",
        label: "Included usage",
        usedPercent,
        resetsAt,
        resetsInSeconds: secondsUntil(resetsAt),
        extra: {
          usedDollars: spentCents != null ? spentCents / 100 : null,
          limitDollars: limitCents != null ? limitCents / 100 : null,
          autoSpendCents: pu?.autoSpend ?? null,
          apiSpendCents: pu?.apiSpend ?? null,
          bonusSpendCents: pu?.bonusSpend ?? null,
          // Cursor's own numbers, verbatim — see note above.
          cursorAutoPercentUsed: pu?.autoPercentUsed ?? null,
          cursorApiPercentUsed: pu?.apiPercentUsed ?? null,
          cursorTotalPercentUsed: pu?.totalPercentUsed ?? null,
        },
      });

      // On-demand (usage-based) spend beyond the included pool.
      const sl = usage.spendLimitUsage;
      const usedDollars = sl?.individualUsed ?? 0;
      const capDollars =
        typeof sl?.individualLimit === "number"
          ? sl.individualLimit / 100
          : typeof hard?.hardLimit === "number"
            ? hard.hardLimit
            : null;

      const spendExtra: Record<string, unknown> =
        hard?.noUsageBasedAllowed || capDollars == null || capDollars <= 0
          ? { status: "off" }
          : capDollars >= UNLIMITED_DOLLARS
            ? { status: "unlimited", usedDollars }
            : {
                status: "on",
                usedDollars,
                limitDollars: capDollars,
                limitType: sl?.limitType ?? "user",
              };

      windows.push({
        id: "spend",
        label: "On-demand spend",
        usedPercent: null,
        resetsAt: null,
        extra: spendExtra,
      });

      return {
        provider: "cursor",
        accountId: account.id,
        label: account.label,
        ok: true,
        plan: plan?.planInfo?.planName ?? null,
        email,
        source: "keychain",
        provenance: "official",
        windows,
        extras: {
          billingCycleStart: toMillis(usage.billingCycleStart),
          billingCycleEnd: cycleEndMs,
          planPrice: plan?.planInfo?.price ?? null,
          displayMessage: usage.displayMessage ?? null,
        },
        fetchedAt,
      };
    } catch (e) {
      return {
        provider: "cursor",
        accountId: account.id,
        label: account.label,
        ok: false,
        error: formatFetchError(e),
        source: "keychain",
        provenance: "unknown",
        windows: [],
        fetchedAt,
      };
    }
  }
}

export const cursorProvider = new CursorProvider();
