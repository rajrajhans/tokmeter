import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LocalStats } from "../types.js";
import { pathExists, readJsonFile } from "../utils/fs.js";
import {
  formatDurationSeconds,
  formatTokenCount,
  shortModelName,
  startOfLocalDay,
} from "./format.js";

type Signals = {
  turnCount?: number;
  toolCallCount?: number;
  contextTokensUsed?: number;
  totalTokensBeforeCompaction?: number;
  contextWindowUsage?: number;
  sessionDurationSeconds?: number;
  agentLinesAdded?: number;
  agentLinesRemoved?: number;
  agentFilesTouched?: number;
  errorCount?: number;
  modelsUsed?: string[];
  primaryModelId?: string;
  gitCommitCount?: number;
  avgTimeToFirstTokenMs?: number;
};

type Summary = {
  session_kind?: string;
  last_active_at?: string;
  updated_at?: string;
  info?: { cwd?: string };
  current_model_id?: string;
};

/**
 * Machine-local Grok Build activity:
 * - today from signals.json (+ summary.json when present)
 * - active sessions from active_sessions.json
 * - 30d rollup (lighter than full walk of chat history)
 */
export async function collectGrokLocalStats(
  grokHome?: string,
): Promise<LocalStats | null> {
  const home = grokHome ?? join(homedir(), ".grok");
  const sessionsRoot = join(home, "sessions");
  if (!(await pathExists(sessionsRoot))) return null;

  const dayStart = startOfLocalDay().getTime();
  const day30 = Date.now() - 30 * 86_400_000;

  let todaySessions = 0;
  let todayTurns = 0;
  let todayTools = 0;
  let todayDuration = 0;
  let todayLinesAdd = 0;
  let todayLinesRem = 0;
  let todayFiles = 0;
  let todayErrors = 0;
  let todayCtxTok = 0;
  let d30Sessions = 0;
  let d30CtxTok = 0;
  const models = new Map<string, number>();
  const projects = new Map<string, number>();
  let active = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile() && ent.name === "signals.json") {
        try {
          const st = await stat(full);
          if (st.mtimeMs < day30) continue;

          let isSubagent = false;
          let cwd: string | null = null;
          let activeAt = st.mtimeMs;
          // summary.json is a sibling of signals.json
          const sumPath = join(full, "..", "summary.json");
          if (await pathExists(sumPath)) {
            try {
              const sum = await readJsonFile<Summary>(sumPath);
              if (sum.session_kind === "subagent") isSubagent = true;
              cwd = sum.info?.cwd ?? null;
              const ts = sum.last_active_at ?? sum.updated_at;
              if (ts) {
                const t = Date.parse(ts);
                if (Number.isFinite(t)) activeAt = t;
              }
            } catch {
              /* ignore */
            }
          }

          const sig = JSON.parse(await readFile(full, "utf8")) as Signals;
          const ctx = Math.max(
            sig.contextTokensUsed ?? 0,
            sig.totalTokensBeforeCompaction ?? 0,
          );

          d30Sessions += 1;
          d30CtxTok += ctx;

          const model = sig.primaryModelId ?? sig.modelsUsed?.[0];
          if (model) models.set(model, (models.get(model) ?? 0) + 1);

          if (cwd) {
            const base = cwd.split("/").filter(Boolean).pop() ?? cwd;
            projects.set(base, (projects.get(base) ?? 0) + 1);
          }

          if (!isSubagent && activeAt >= dayStart) {
            todaySessions += 1;
            todayTurns += sig.turnCount ?? 0;
            todayTools += sig.toolCallCount ?? 0;
            todayDuration += sig.sessionDurationSeconds ?? 0;
            todayLinesAdd += sig.agentLinesAdded ?? 0;
            todayLinesRem += sig.agentLinesRemoved ?? 0;
            todayFiles += sig.agentFilesTouched ?? 0;
            todayErrors += sig.errorCount ?? 0;
            todayCtxTok += ctx;
          }
        } catch {
          /* skip */
        }
      }
    }
  }

  await walk(sessionsRoot, 0);

  const activePath = join(home, "active_sessions.json");
  if (await pathExists(activePath)) {
    try {
      const list = JSON.parse(await readFile(activePath, "utf8")) as unknown[];
      if (Array.isArray(list)) active = list.length;
    } catch {
      /* ignore */
    }
  }

  if (d30Sessions === 0 && active === 0) return null;

  const lines: LocalStats["lines"] = [];

  if (todaySessions > 0 || todayTurns > 0) {
    lines.push({
      label: "Today",
      value: [
        `${todaySessions} sessions`,
        todayTurns ? `${todayTurns} turns` : null,
        todayTools ? `${todayTools} tools` : null,
        todayDuration ? formatDurationSeconds(todayDuration) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  if (todayCtxTok > 0) {
    lines.push({
      label: "Context",
      value: `~${formatTokenCount(todayCtxTok)} tok (approx, not billed)`,
    });
  }

  if (todayLinesAdd || todayLinesRem || todayFiles) {
    lines.push({
      label: "Code",
      value: [
        todayLinesAdd || todayLinesRem
          ? `+${todayLinesAdd} / −${todayLinesRem} lines`
          : null,
        todayFiles ? `${todayFiles} files` : null,
        todayErrors ? `${todayErrors} err` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  if (active > 0) {
    lines.push({ label: "Active now", value: String(active) });
  }

  lines.push({
    label: "30d",
    value: `${d30Sessions} sessions · ~${formatTokenCount(d30CtxTok)} ctx tok`,
  });

  const topM = [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topM.length) {
    lines.push({
      label: "Models",
      value: topM.map(([m, n]) => `${shortModelName(m)}×${n}`).join(" · "),
    });
  }

  const topP = [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topP.length) {
    lines.push({
      label: "Projects",
      value: topP.map(([p, n]) => `${p}×${n}`).join(" · "),
    });
  }

  return {
    period: "today+30d",
    source: "local",
    lines,
    raw: {
      todaySessions,
      todayTurns,
      todayTools,
      todayDurationSeconds: todayDuration,
      todayContextTokens: todayCtxTok,
      d30Sessions,
      d30ContextTokens: d30CtxTok,
      activeSessions: active,
      models: Object.fromEntries(models),
      projects: Object.fromEntries(projects),
    },
  };
}
