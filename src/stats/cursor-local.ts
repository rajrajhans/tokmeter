import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AccountConfig, LocalStats } from "../types.js";
import { defaultCursorHome } from "../config.js";
import { cursorRpc, resolveCursorToken } from "../providers/cursor.js";
import { pathExists, readJsonFile } from "../utils/fs.js";
import {
  formatTokenCount,
  formatUsd,
  shortModelName,
  startOfLocalDay,
} from "./format.js";

/** ~/.cursor/chats/<workspaceHash>/<chatId>/meta.json */
type ChatMeta = {
  createdAtMs?: number;
  updatedAtMs?: number;
  cwd?: string;
  title?: string;
  hasConversation?: boolean;
};

type Aggregation = {
  modelIntent?: string;
  inputTokens?: string | number;
  outputTokens?: string | number;
  cacheWriteTokens?: string | number;
  cacheReadTokens?: string | number;
  totalCents?: number;
};

type AggregatedUsage = {
  aggregations?: Aggregation[];
  totalInputTokens?: string | number;
  totalOutputTokens?: string | number;
  totalCacheWriteTokens?: string | number;
  totalCacheReadTokens?: string | number;
  totalCostCents?: number;
};

/** Connect serializes int64 as a JSON string. */
function int64(v: string | number | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function totalTokens(a: AggregatedUsage | Aggregation): number {
  const src = a as Record<string, string | number | undefined>;
  return (
    int64(src.totalInputTokens ?? src.inputTokens) +
    int64(src.totalOutputTokens ?? src.outputTokens) +
    int64(src.totalCacheWriteTokens ?? src.cacheWriteTokens) +
    int64(src.totalCacheReadTokens ?? src.cacheReadTokens)
  );
}

type ChatScan = {
  today: number;
  d30: number;
  projects: Map<string, number>;
};

/**
 * Cursor keeps chat transcripts encrypted (key lives in each chat's meta.json)
 * and records no token counts on disk — so sessions/projects come from the
 * chat directory and token/cost numbers come from Cursor's usage API.
 */
async function scanChats(home: string): Promise<ChatScan> {
  const scan: ChatScan = { today: 0, d30: 0, projects: new Map() };
  const chatsRoot = join(home, "chats");
  if (!(await pathExists(chatsRoot))) return scan;

  const dayStart = startOfLocalDay().getTime();
  const day30 = Date.now() - 30 * 86_400_000;

  let workspaces: string[];
  try {
    workspaces = (await readdir(chatsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return scan;
  }

  for (const ws of workspaces) {
    let chats: string[];
    try {
      chats = (await readdir(join(chatsRoot, ws), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const chat of chats) {
      const metaPath = join(chatsRoot, ws, chat, "meta.json");
      try {
        const meta = await readJsonFile<ChatMeta>(metaPath);
        if (meta.hasConversation === false) continue;

        const at = meta.updatedAtMs ?? meta.createdAtMs;
        if (typeof at !== "number" || at < day30) continue;

        scan.d30 += 1;
        if (at >= dayStart) scan.today += 1;

        if (meta.cwd) {
          const base = meta.cwd.split("/").filter(Boolean).pop() ?? meta.cwd;
          scan.projects.set(base, (scan.projects.get(base) ?? 0) + 1);
        }
      } catch {
        /* skip unreadable chat */
      }
    }
  }

  return scan;
}

export async function collectCursorLocalStats(
  account?: AccountConfig,
): Promise<LocalStats | null> {
  const home = account?.cursorHome ?? defaultCursorHome();
  const token = await resolveCursorToken(account);

  const now = Date.now();
  const dayStart = startOfLocalDay().getTime();

  const [chats, d30, today] = await Promise.all([
    scanChats(home),
    token
      ? cursorRpc<AggregatedUsage>("GetAggregatedUsageEvents", token, {
          teamId: 0,
          startDate: String(now - 30 * 86_400_000),
          endDate: String(now),
        }).catch(() => null)
      : Promise.resolve(null),
    token
      ? cursorRpc<AggregatedUsage>("GetAggregatedUsageEvents", token, {
          teamId: 0,
          startDate: String(dayStart),
          endDate: String(now),
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const lines: LocalStats["lines"] = [];

  const todayTokens = today ? totalTokens(today) : 0;
  const todayCost = today ? (today.totalCostCents ?? 0) / 100 : 0;
  if (chats.today > 0 || todayTokens > 0) {
    lines.push({
      label: "Today",
      value: [
        `${chats.today} ${chats.today === 1 ? "chat" : "chats"}`,
        todayTokens ? `~${formatTokenCount(todayTokens)} tok` : null,
        todayCost > 0 ? formatUsd(todayCost) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  const d30Tokens = d30 ? totalTokens(d30) : 0;
  const d30Cost = d30 ? (d30.totalCostCents ?? 0) / 100 : 0;
  if (chats.d30 > 0 || d30Tokens > 0) {
    lines.push({
      label: "30d",
      value: [
        `${chats.d30} ${chats.d30 === 1 ? "chat" : "chats"}`,
        d30Tokens ? `~${formatTokenCount(d30Tokens)} tok` : null,
        d30Cost > 0 ? formatUsd(d30Cost) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  const byModel = (d30?.aggregations ?? [])
    .map((a) => ({
      model: a.modelIntent || "unknown",
      tokens: totalTokens(a),
    }))
    .filter((m) => m.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);
  if (byModel.length) {
    lines.push({
      label: "Models",
      value: byModel
        .map((m) => `${shortModelName(m.model)} ${formatTokenCount(m.tokens)}`)
        .join(" · "),
    });
  }

  const topProjects = [...chats.projects.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (topProjects.length) {
    lines.push({
      label: "Projects",
      value: topProjects.map(([p, n]) => `${p}×${n}`).join(" · "),
    });
  }

  if (lines.length === 0) return null;

  return {
    period: "today+30d",
    source: "mixed",
    lines,
    raw: {
      todayChats: chats.today,
      todayTokens,
      todayCostUsd: todayCost,
      d30Chats: chats.d30,
      d30Tokens,
      d30CostUsd: d30Cost,
      d30ByModel: Object.fromEntries(byModel.map((m) => [m.model, m.tokens])),
      projects: Object.fromEntries(chats.projects),
    },
  };
}
