import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LocalStats } from "../types.js";
import { pathExists } from "../utils/fs.js";
import {
  formatTokenCount,
  shortModelName,
  startOfLocalDay,
} from "./format.js";

type TokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

/**
 * Machine-local Codex activity for today from:
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * Uses final (max) total_token_usage per session file.
 */
export async function collectCodexLocalStats(
  codexHome?: string,
): Promise<LocalStats | null> {
  const home = codexHome ?? join(homedir(), ".codex");
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dayDir = join(home, "sessions", String(y), mo, day);
  // Also check UTC date dir if it differs (late evening)
  const utc = new Date();
  const uy = utc.getUTCFullYear();
  const umo = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const uday = String(utc.getUTCDate()).padStart(2, "0");
  const utcDir = join(home, "sessions", String(uy), umo, uday);

  const dirs = new Set([dayDir, utcDir]);
  const models = new Map<string, number>();
  let sessions = 0;
  let input = 0;
  let cached = 0;
  let output = 0;
  let reasoning = 0;
  let total = 0;
  const projects = new Map<string, number>();

  for (const dir of dirs) {
    if (!(await pathExists(dir))) continue;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
      const full = join(dir, ent.name);
      try {
        const raw = await readFile(full, "utf8");
        let finalUsage: TokenUsage | null = null;
        let model: string | null = null;
        let cwd: string | null = null;
        let isSubagent = false;

        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let d: {
            type?: string;
            payload?: {
              type?: string;
              model?: string;
              cwd?: string;
              thread_source?: string;
              source?: unknown;
              info?: {
                total_token_usage?: TokenUsage;
              };
            };
          };
          try {
            d = JSON.parse(line);
          } catch {
            continue;
          }
          if (d.type === "session_meta" && d.payload) {
            const p = d.payload as {
              cwd?: string;
              thread_source?: string;
              source?: { subagent?: unknown };
            };
            if (p.cwd) cwd = p.cwd;
            if (p.thread_source === "subagent" || p.source?.subagent) {
              isSubagent = true;
            }
          }
          if (d.type === "turn_context" && d.payload?.model) {
            model = d.payload.model;
          }
          if (
            d.type === "event_msg" &&
            d.payload?.type === "token_count" &&
            d.payload.info?.total_token_usage
          ) {
            finalUsage = d.payload.info.total_token_usage;
          }
        }

        if (!finalUsage && !model) continue;
        // Count parent user sessions primarily; still include subagents in token sum
        if (!isSubagent) sessions += 1;
        else sessions += 1; // count all rollouts as activity units

        if (finalUsage) {
          input += finalUsage.input_tokens ?? 0;
          cached += finalUsage.cached_input_tokens ?? 0;
          output += finalUsage.output_tokens ?? 0;
          reasoning += finalUsage.reasoning_output_tokens ?? 0;
          total +=
            finalUsage.total_tokens ??
            (finalUsage.input_tokens ?? 0) + (finalUsage.output_tokens ?? 0);
        }
        if (model) models.set(model, (models.get(model) ?? 0) + 1);
        if (cwd) {
          const base = cwd.split("/").filter(Boolean).pop() ?? cwd;
          projects.set(base, (projects.get(base) ?? 0) + 1);
        }
      } catch {
        /* skip */
      }
    }
  }

  // Fallback: scan recent mtime files if day dirs empty
  if (sessions === 0) {
    const sessionsRoot = join(home, "sessions");
    if (await pathExists(sessionsRoot)) {
      const dayStart = startOfLocalDay().getTime();
      await walkRecent(sessionsRoot, dayStart, {
        onSession: (u, m, cwd) => {
          sessions += 1;
          if (u) {
            input += u.input_tokens ?? 0;
            cached += u.cached_input_tokens ?? 0;
            output += u.output_tokens ?? 0;
            reasoning += u.reasoning_output_tokens ?? 0;
            total +=
              u.total_tokens ??
              (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
          }
          if (m) models.set(m, (models.get(m) ?? 0) + 1);
          if (cwd) {
            const base = cwd.split("/").filter(Boolean).pop() ?? cwd;
            projects.set(base, (projects.get(base) ?? 0) + 1);
          }
        },
      });
    }
  }

  if (sessions === 0 && total === 0) return null;

  const lines: LocalStats["lines"] = [];
  const bits = [
    `${sessions} sessions`,
    total ? `${formatTokenCount(total)} tok` : null,
  ].filter(Boolean) as string[];
  lines.push({ label: "Today", value: bits.join(" · ") });

  if (input || output || cached) {
    lines.push({
      label: "Tokens",
      value: [
        input ? `in ${formatTokenCount(input)}` : null,
        cached ? `cache ${formatTokenCount(cached)}` : null,
        output ? `out ${formatTokenCount(output)}` : null,
        reasoning ? `think ${formatTokenCount(reasoning)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  if (input > 0 && cached > 0) {
    const hit = Math.round((cached / input) * 100);
    lines.push({ label: "Cache hit", value: `${hit}%` });
  }

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
    period: "today",
    source: "local",
    lines,
    raw: {
      sessions,
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      reasoningTokens: reasoning,
      totalTokens: total,
      models: Object.fromEntries(models),
      projects: Object.fromEntries(projects),
    },
  };
}

async function walkRecent(
  dir: string,
  mtimeCutoff: number,
  hooks: {
    onSession: (
      usage: TokenUsage | null,
      model: string | null,
      cwd: string | null,
    ) => void;
  },
  depth = 0,
): Promise<void> {
  if (depth > 6) return;
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkRecent(full, mtimeCutoff, hooks, depth + 1);
    } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
      try {
        const st = await stat(full);
        if (st.mtimeMs < mtimeCutoff) continue;
        const raw = await readFile(full, "utf8");
        let finalUsage: TokenUsage | null = null;
        let model: string | null = null;
        let cwd: string | null = null;
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line) as {
              type?: string;
              payload?: {
                type?: string;
                model?: string;
                cwd?: string;
                info?: { total_token_usage?: TokenUsage };
              };
            };
            if (d.type === "session_meta" && d.payload?.cwd) {
              cwd = d.payload.cwd as string;
            }
            if (d.type === "turn_context" && d.payload?.model) {
              model = d.payload.model;
            }
            if (
              d.type === "event_msg" &&
              d.payload?.type === "token_count" &&
              d.payload.info?.total_token_usage
            ) {
              finalUsage = d.payload.info.total_token_usage;
            }
          } catch {
            /* skip line */
          }
        }
        if (finalUsage || model) hooks.onSession(finalUsage, model, cwd);
      } catch {
        /* skip */
      }
    }
  }
}
