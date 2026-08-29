import type { AccountConfig, ProviderSnapshot, UsageWindow } from "../types.js";
import { nowIso, secondsUntil } from "../utils/time.js";
import type { Provider } from "./types.js";
import { collectAgyLocalStats } from "../stats/agy-local.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class AgyProvider implements Provider {
  readonly name = "agy" as const;

  async fetchUsage(account: AccountConfig): Promise<ProviderSnapshot> {
    const fetchedAt = nowIso();
    const windows: UsageWindow[] = [];
    
    try {
      // The agy CLI can print quota info non-interactively using `-p /usage`.
      // It returns tab-separated lines: Group \t Metric \t Remaining% \t ResetISO
      const { stdout } = await execFileAsync("agy", ["-p", "/usage"], { timeout: 10000 });
      const lines = stdout.trim().split("\n");
      
      for (const line of lines) {
        if (!line) continue;
        const parts = line.split("\t");
        if (parts.length === 4) {
          const group = parts[0]; // e.g. "Gemini Models"
          const metric = parts[1]; // e.g. "Weekly Limit Remaining"
          const pctStr = parts[2]; // e.g. "98%"
          const dateStr = parts[3]; // e.g. "2026-09-05T13:14:01Z"
          
          let usedPercent = null;
          if (pctStr.endsWith("%")) {
            const rem = parseFloat(pctStr.replace("%", ""));
            if (!isNaN(rem)) {
              // agy outputs *remaining* quota (e.g. 98%), tokmeter renders *used* quota (e.g. 2%).
              usedPercent = 100 - rem;
            }
          }
          
          let resetsInSeconds = null;
          let resetsAt = null;
          if (dateStr) {
             resetsAt = dateStr;
             const diff = secondsUntil(dateStr);
             if (diff !== undefined) resetsInSeconds = diff;
          }
          
          // Map long metrics to concise tokmeter labels
          let baseLabel = metric;
          if (metric.includes("Weekly")) baseLabel = "Weekly";
          else if (metric.includes("Five Hour")) baseLabel = "Session";
          
          let label = baseLabel;
          if (group.toLowerCase().includes("gemini")) {
             label += " · Gemini";
          } else if (group.toLowerCase().includes("claude")) {
             label += " · Claude";
          }

          windows.push({
            id: `quota-${group}-${metric}`.replace(/\s+/g, '-').toLowerCase(),
            label: label,
            usedPercent,
            resetsAt,
            resetsInSeconds,
          });
        }
      }
    } catch (e) {
      // ignore, fallback to basic
    }

    // fallback if no quota found
    if (windows.length === 0) {
      const local = await collectAgyLocalStats();
      let sessions = 0;
      if (local && local.lines.length > 0) {
         const match = local.lines[0].value.match(/(\d+)/);
         if (match) sessions = parseInt(match[1], 10);
      }
      const capacity = 50;
      const pct = Math.min(100, Math.round((sessions / capacity) * 100));
      windows.push({
        id: "activity",
        label: "Daily capacity",
        usedPercent: pct,
        resetsAt: null,
      });
    }

    return {
      provider: "agy",
      accountId: account.id,
      label: account.label,
      ok: true,
      plan: "Cloud",
      email: null,
      source: "api",
      provenance: "official",
      windows,
      extras: {},
      fetchedAt,
    };
  }
}

export const agyProvider = new AgyProvider();
