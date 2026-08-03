import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LocalStats } from "../types.js";
import { pathExists } from "../utils/fs.js";
import {
  formatTokenCount,
  formatUsd,
  isIsoOnLocalDay,
  localDateKey,
  shortModelName,
  startOfLocalDay,
} from "./format.js";

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/**
 * Machine-local Claude Code activity for today from:
 * - ~/.claude/projects/ (project session jsonl files)
 * - ~/.claude/.statusline-daily-cost.json (estimated $)
 */
export async function collectClaudeLocalStats(): Promise<LocalStats | null> {
  const projects = join(homedir(), ".claude", "projects");
  if (!(await pathExists(projects))) return null;

  const dayStart = startOfLocalDay();
  const mtimeCutoff = dayStart.getTime() - 3_600_000; // include late-night writes
  const models = new Map<string, number>();
  // One API turn is written as multiple assistant JSONL lines (text + tool_use)
  // with the same usage blob — dedupe by requestId / message.id.
  const seenRequests = new Map<
    string,
    { usage: Usage; model?: string; sessionId?: string; out: number }
  >();

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
        // Skip tool-results dumps
        if (ent.name === "tool-results") continue;
        await walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        try {
          const st = await stat(full);
          if (st.mtimeMs < mtimeCutoff) continue;
          const raw = await readFile(full, "utf8");
          for (const line of raw.split("\n")) {
            if (!line.includes('"assistant"')) continue;
            let d: {
              type?: string;
              timestamp?: string;
              sessionId?: string;
              session_id?: string;
              requestId?: string;
              message?: { id?: string; usage?: Usage; model?: string };
              usage?: Usage;
              model?: string;
            };
            try {
              d = JSON.parse(line);
            } catch {
              continue;
            }
            if (d.type !== "assistant") continue;
            if (!d.timestamp || !isIsoOnLocalDay(d.timestamp, dayStart)) continue;
            const u = d.message?.usage ?? d.usage;
            if (!u) continue;
            const key =
              d.requestId ||
              d.message?.id ||
              `${d.sessionId ?? d.session_id ?? full}:${d.timestamp}:${u.output_tokens ?? 0}`;
            const out = u.output_tokens ?? 0;
            const prev = seenRequests.get(key);
            // Keep the line with the largest output_tokens (best streaming snapshot)
            if (!prev || out >= prev.out) {
              seenRequests.set(key, {
                usage: u,
                model: d.message?.model ?? d.model,
                sessionId: d.sessionId ?? d.session_id,
                out,
              });
            }
          }
        } catch {
          /* skip file */
        }
      }
    }
  }

  await walk(projects, 0);

  let messages = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  const sessionIds = new Set<string>();
  for (const row of seenRequests.values()) {
    messages += 1;
    const u = row.usage;
    input += u.input_tokens ?? 0;
    output += u.output_tokens ?? 0;
    cacheRead += u.cache_read_input_tokens ?? 0;
    cacheCreate += u.cache_creation_input_tokens ?? 0;
    if (row.model && row.model !== "<synthetic>") {
      models.set(row.model, (models.get(row.model) ?? 0) + 1);
    }
    if (row.sessionId) sessionIds.add(row.sessionId);
  }

  // Live interactive sessions (pids still running)
  let activeSessions = 0;
  const liveDir = join(homedir(), ".claude", "sessions");
  if (await pathExists(liveDir)) {
    try {
      const ents = await readdir(liveDir);
      for (const name of ents) {
        if (!name.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(liveDir, name), "utf8");
          const j = JSON.parse(raw) as { pid?: number };
          if (typeof j.pid === "number") {
            try {
              process.kill(j.pid, 0);
              activeSessions += 1;
            } catch {
              /* dead pid */
            }
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* ignore */
    }
  }

  let costUsd: number | null = null;
  const costPath = join(homedir(), ".claude", ".statusline-daily-cost.json");
  if (await pathExists(costPath)) {
    try {
      const cost = JSON.parse(await readFile(costPath, "utf8")) as {
        date?: string;
        sessions?: Record<string, number>;
      };
      if (cost.date === localDateKey() && cost.sessions) {
        costUsd = Object.values(cost.sessions).reduce(
          (a, b) => a + (typeof b === "number" ? b : 0),
          0,
        );
      }
    } catch {
      /* ignore */
    }
  }

  if (messages === 0 && costUsd == null) return null;

  const totalTok = input + output + cacheRead + cacheCreate;
  const lines: LocalStats["lines"] = [];

  const bits: string[] = [];
  if (sessionIds.size) bits.push(`${sessionIds.size} sessions`);
  if (messages) bits.push(`${messages} turns`);
  if (totalTok) bits.push(`${formatTokenCount(totalTok)} tok`);
  if (costUsd != null && costUsd > 0) bits.push(formatUsd(costUsd));
  if (bits.length) {
    lines.push({ label: "Today", value: bits.join(" · ") });
  }

  if (input || output || cacheRead) {
    const detail = [
      input ? `in ${formatTokenCount(input)}` : null,
      output ? `out ${formatTokenCount(output)}` : null,
      cacheRead ? `cache ${formatTokenCount(cacheRead)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (detail) lines.push({ label: "Tokens", value: detail });
  }

  if (cacheRead > 0 && input + cacheCreate + cacheRead > 0) {
    const denom = input + cacheCreate + cacheRead;
    lines.push({
      label: "Cache hit",
      value: `${Math.round((cacheRead / denom) * 100)}%`,
    });
  }

  if (activeSessions > 0) {
    lines.push({ label: "Active now", value: String(activeSessions) });
  }

  const top = [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) {
    const total = top.reduce((a, [, n]) => a + n, 0) || 1;
    lines.push({
      label: "Models",
      value: top
        .map(
          ([m, n]) =>
            `${shortModelName(m)} ${Math.round((n / total) * 100)}%`,
        )
        .join(" · "),
    });
  }

  return {
    period: "today",
    source: "local",
    lines,
    raw: {
      messages,
      sessions: sessionIds.size,
      activeSessions,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheCreate,
      costUsd,
      models: Object.fromEntries(models),
    },
  };
}
