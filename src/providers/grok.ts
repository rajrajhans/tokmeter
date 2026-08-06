import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AccountConfig, ProviderSnapshot, UsageWindow } from "../types.js";
import { defaultGrokHome } from "../config.js";
import { expandHome, pathExists, readJsonFile } from "../utils/fs.js";
import { formatFetchError } from "../utils/network.js";
import { nowIso, secondsUntil } from "../utils/time.js";
import type { Provider } from "./types.js";

const BILLING_URL =
  "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

type GrokAuthEntry = {
  key?: string;
  email?: string;
  expires_at?: string;
  team_id?: string;
  principal_type?: string;
  auth_mode?: string;
  first_name?: string;
  user_id?: string;
  refresh_token?: string;
};

type GrokAuthFile = Record<string, GrokAuthEntry | unknown>;

type Signals = {
  contextTokensUsed?: number;
  totalTokensBeforeCompaction?: number;
  turnCount?: number;
  primaryModelId?: string;
};

type GrokBilling = {
  usedPercent: number | null;
  periodStart: string | null;
  periodEnd: string | null;
};

function pickAuthEntry(
  data: GrokAuthFile,
): { key: string; entry: GrokAuthEntry } | null {
  // Prefer SuperGrok OIDC entries under https://auth.x.ai::...
  const entries = Object.entries(data).filter(
    ([, v]) => v && typeof v === "object" && "key" in (v as object),
  ) as [string, GrokAuthEntry][];
  if (entries.length === 0) return null;
  const preferred =
    entries.find(([k]) => k.startsWith("https://auth.x.ai")) ?? entries[0];
  return { key: preferred[0], entry: preferred[1] };
}

function readVarint(
  buf: Uint8Array,
  offset: number,
): { value: number; next: number } | null {
  let shift = 0;
  let value = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

/** Extract data frames from application/grpc-web+proto body. */
function grpcWebDataFrames(buf: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const flag = buf[i]!;
    const len =
      ((buf[i + 1]! << 24) |
        (buf[i + 2]! << 16) |
        (buf[i + 3]! << 8) |
        buf[i + 4]!) >>>
      0;
    i += 5;
    if (i + len > buf.length) break;
    const payload = buf.subarray(i, i + len);
    i += len;
    // flag 0 = data, 0x80 = trailer
    if (flag === 0 && payload.length > 0) frames.push(payload);
  }
  return frames;
}

/**
 * Parse GrokBuild GetGrokCreditsConfig response.
 *
 * Observed layout (message field 1 = config):
 *   1.1 fixed32 float  → credit_usage_percent (0–100)
 *   1.4.1 varint       → period start unix seconds
 *   1.5.1 varint       → period end / reset unix seconds
 */
function parseGrokBillingProtobuf(raw: Uint8Array): GrokBilling {
  const result: GrokBilling = {
    usedPercent: null,
    periodStart: null,
    periodEnd: null,
  };

  // Collect fixed32 floats in [0,100] and unix-ish varints along field paths.
  type Hit = { path: string; kind: "f" | "v"; value: number };
  const hits: Hit[] = [];

  function walk(buf: Uint8Array, path: string, depth: number): void {
    if (depth > 8) return;
    let i = 0;
    while (i < buf.length) {
      const key = readVarint(buf, i);
      if (!key) break;
      const field = key.value >>> 3;
      const wire = key.value & 7;
      i = key.next;
      const p = path ? `${path}.${field}` : String(field);

      if (wire === 0) {
        const v = readVarint(buf, i);
        if (!v) break;
        i = v.next;
        hits.push({ path: p, kind: "v", value: v.value });
      } else if (wire === 1) {
        if (i + 8 > buf.length) break;
        i += 8;
      } else if (wire === 2) {
        const len = readVarint(buf, i);
        if (!len) break;
        i = len.next;
        const chunk = buf.subarray(i, i + len.value);
        i += len.value;
        walk(chunk, p, depth + 1);
      } else if (wire === 5) {
        if (i + 4 > buf.length) break;
        const view = new DataView(buf.buffer, buf.byteOffset + i, 4);
        const f = view.getFloat32(0, true);
        i += 4;
        if (Number.isFinite(f) && f >= 0 && f <= 100) {
          hits.push({ path: p, kind: "f", value: f });
        }
      } else {
        break;
      }
    }
  }

  for (const frame of grpcWebDataFrames(raw)) {
    walk(frame, "", 0);
  }

  // Prefer field path 1.1 for percent (primary credit usage).
  const pctHit =
    hits.find((h) => h.kind === "f" && h.path === "1.1") ??
    hits.find((h) => h.kind === "f" && h.path.endsWith(".1") && h.value > 0) ??
    hits.find((h) => h.kind === "f");
  if (pctHit) result.usedPercent = Math.round(pctHit.value * 10) / 10;

  // Period start/end: 1.4.1 and 1.5.1 (unix seconds ~1.7e9–2.1e9)
  const isUnix = (n: number) => n > 1_700_000_000 && n < 2_100_000_000;
  const startHit =
    hits.find((h) => h.kind === "v" && h.path === "1.4.1" && isUnix(h.value)) ??
    hits.find((h) => h.kind === "v" && h.path.endsWith(".4.1") && isUnix(h.value));
  const endHit =
    hits.find((h) => h.kind === "v" && h.path === "1.5.1" && isUnix(h.value)) ??
    hits.find((h) => h.kind === "v" && h.path.endsWith(".5.1") && isUnix(h.value));

  if (startHit) {
    result.periodStart = new Date(startHit.value * 1000).toISOString();
  }
  if (endHit) {
    result.periodEnd = new Date(endHit.value * 1000).toISOString();
  }

  // Fallback: first two unix varints as start/end
  if (!result.periodEnd) {
    const unixes = hits
      .filter((h) => h.kind === "v" && isUnix(h.value))
      .map((h) => h.value);
    const uniq = [...new Set(unixes)].sort((a, b) => a - b);
    if (uniq.length >= 2) {
      result.periodStart = new Date(uniq[0]! * 1000).toISOString();
      result.periodEnd = new Date(uniq[uniq.length - 1]! * 1000).toISOString();
    } else if (uniq.length === 1) {
      result.periodEnd = new Date(uniq[0]! * 1000).toISOString();
    }
  }

  return result;
}

/**
 * Live Grok Build credits via gRPC-web (same surface CodexBar uses).
 * Auth: OIDC access token from ~/.grok/auth.json (`key` field).
 */
async function fetchGrokBilling(
  accessToken: string,
): Promise<{ ok: true; billing: GrokBilling } | { ok: false; note: string }> {
  try {
    // Empty protobuf message framed as gRPC-web: flag=0, length=0
    const body = new Uint8Array([0, 0, 0, 0, 0]);
    const res = await fetch(BILLING_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/grpc-web+proto",
        Accept: "application/grpc-web+proto",
        "x-grpc-web": "1",
        Origin: "https://grok.com",
        Referer: "https://grok.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body,
    });
    if (!res.ok) {
      return { ok: false, note: `HTTP ${res.status}` };
    }
    const ab = await res.arrayBuffer();
    const raw = new Uint8Array(ab);
    if (raw.length === 0) {
      return { ok: false, note: "empty billing response" };
    }
    // Trailer-only failure?
    const text = new TextDecoder().decode(raw);
    if (text.includes("grpc-status:16") || text.includes("grpc-status:7")) {
      return { ok: false, note: "auth rejected (run grok login)" };
    }
    if (text.includes("grpc-status:") && !text.includes("grpc-status:0")) {
      const m = text.match(/grpc-status:(\d+)/);
      return { ok: false, note: `grpc-status ${m?.[1] ?? "?"}` };
    }
    const billing = parseGrokBillingProtobuf(raw);
    if (billing.usedPercent == null && !billing.periodEnd) {
      return { ok: false, note: "could not parse billing protobuf" };
    }
    return { ok: true, billing };
  } catch (e) {
    return {
      ok: false,
      note: formatFetchError(e),
    };
  }
}

async function walkSignals(
  sessionsRoot: string,
  sinceMs: number,
): Promise<{ sessions: number; tokens: number; models: Set<string> }> {
  const result = { sessions: 0, tokens: 0, models: new Set<string>() };
  if (!(await pathExists(sessionsRoot))) return result;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile() && ent.name === "signals.json") {
        try {
          const st = await stat(full);
          if (st.mtimeMs < sinceMs) continue;
          const sig = await readJsonFile<Signals>(full);
          result.sessions += 1;
          const approx = Math.max(
            sig.contextTokensUsed ?? 0,
            sig.totalTokensBeforeCompaction ?? 0,
          );
          result.tokens += approx;
          if (sig.primaryModelId) result.models.add(sig.primaryModelId);
        } catch {
          /* skip */
        }
      }
    }
  }

  await walk(sessionsRoot, 0);
  return result;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function windowLabelFromPeriod(
  start: string | null,
  end: string | null,
): string {
  if (!start || !end) return "Credits";
  const ms =
    new Date(end).getTime() - new Date(start).getTime();
  const days = ms / 86_400_000;
  if (days >= 25 && days <= 35) return "Monthly credits";
  if (days >= 5 && days <= 10) return "Weekly credits";
  return "Credits";
}

export class GrokProvider implements Provider {
  readonly name = "grok" as const;

  async fetchUsage(account: AccountConfig): Promise<ProviderSnapshot> {
    const fetchedAt = nowIso();
    try {
      const home = account.grokHome
        ? expandHome(account.grokHome)
        : defaultGrokHome();
      const authPath = join(home, "auth.json");
      if (!(await pathExists(authPath))) {
        throw new Error(`Grok auth not found: ${authPath}`);
      }

      const authFile = await readJsonFile<GrokAuthFile>(authPath);
      const picked = pickAuthEntry(authFile);
      if (!picked) {
        throw new Error("Grok auth.json has no OIDC entries");
      }
      const entry = picked.entry;
      if (!entry.key) {
        throw new Error("Grok auth entry missing access token (key)");
      }

      // Expire check (informational; still try request)
      const expired =
        entry.expires_at && new Date(entry.expires_at).getTime() < Date.now();

      const since = Date.now() - 30 * 24 * 3600 * 1000;
      const local = await walkSignals(join(home, "sessions"), since);

      const windows: UsageWindow[] = [];
      const extras: Record<string, unknown> = {
        auth_mode: entry.auth_mode ?? null,
        principal_type: entry.principal_type ?? null,
        team_id: entry.team_id ?? null,
        expires_at: entry.expires_at ?? null,
        oidc_entry: picked.key,
      };

      windows.push({
        id: "identity",
        label: "Identity",
        usedPercent: null,
        resetsAt: null,
        extra: {
          mode: entry.auth_mode ?? "oidc",
          principal: entry.principal_type ?? "User",
        },
      });

      let provenance: ProviderSnapshot["provenance"] = "local_estimate";
      let source = "auth_file+local";

      const billingResult = await fetchGrokBilling(entry.key);
      if (billingResult.ok) {
        const b = billingResult.billing;
        const label = windowLabelFromPeriod(b.periodStart, b.periodEnd);
        windows.push({
          id: "credits",
          label,
          usedPercent: b.usedPercent,
          resetsAt: b.periodEnd,
          resetsInSeconds: secondsUntil(b.periodEnd),
          extra: {
            periodStart: b.periodStart,
            periodEnd: b.periodEnd,
          },
        });
        provenance = "official";
        source = "grpc-web+local";
        extras.billing = b;
      } else {
        windows.push({
          id: "billing",
          label: "Live billing",
          usedPercent: null,
          resetsAt: null,
          extra: {
            status: "unavailable",
            note: expired
              ? `token expired — run grok login (${billingResult.note})`
              : billingResult.note,
          },
        });
        extras.billing_note = billingResult.note;
      }

      windows.push({
        id: "local",
        label: "Local sessions",
        usedPercent: null,
        resetsAt: null,
        extra: {
          sessions: local.sessions,
          tokensApprox: local.tokens,
          tokensLabel: formatTokens(local.tokens),
          models: [...local.models],
          windowDays: 30,
        },
      });

      return {
        provider: "grok",
        accountId: account.id,
        label: account.label,
        ok: true,
        plan: null,
        email: entry.email ?? null,
        source,
        provenance,
        windows,
        extras,
        fetchedAt,
      };
    } catch (e) {
      return {
        provider: "grok",
        accountId: account.id,
        label: account.label,
        ok: false,
        error: formatFetchError(e),
        source: "auth_file",
        provenance: "unknown",
        windows: [],
        fetchedAt,
      };
    }
  }
}

export const grokProvider = new GrokProvider();
