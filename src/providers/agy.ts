import type { AccountConfig, ProviderSnapshot, UsageWindow } from "../types.js";
import { nowIso, secondsUntil } from "../utils/time.js";
import type { Provider } from "./types.js";
import { collectAgyLocalStats } from "../stats/agy-local.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathExists } from "../utils/fs.js";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

export class AgyProvider implements Provider {
  readonly name = "agy" as const;

  async fetchUsage(account: AccountConfig): Promise<ProviderSnapshot> {
    const fetchedAt = nowIso();
    const windows: UsageWindow[] = [];
    
    // In strict environments like Nix, `agy` might not be in PATH.
    let agyBin = process.env.AGY_BIN || "agy";
    if (!process.env.AGY_BIN) {
      const commonPaths = [
        "/opt/homebrew/bin/agy",
        "/usr/local/bin/agy",
        join(homedir(), ".local/bin/agy"),
        join(homedir(), "bin/agy"),
      ];
      
      for (const p of commonPaths) {
        if (await pathExists(p)) {
          agyBin = p;
          break;
        }
      }
    }
    
    let fetchError: Error | null = null;
    try {
      const { stdout } = await execFileAsync(agyBin, ["-p", "/usage"], { timeout: 30000 });
      const lines = stdout.trim().split("\n");
      
      for (const line of lines) {
        if (!line) continue;
        const parts = line.split("\t");
        if (parts.length === 4) {
          const group = parts[0]; 
          const metric = parts[1]; 
          const pctStr = parts[2]; 
          const dateStr = parts[3]; 
          
          let usedPercent = null;
          if (pctStr.endsWith("%")) {
            const rem = parseFloat(pctStr.replace("%", ""));
            if (!isNaN(rem)) {
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
      fetchError = e instanceof Error ? e : new Error(String(e));
    }

    const extras: Record<string, unknown> = {};

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
      extras.warning = `Could not load cloud quota: ${fetchError?.message ?? "unknown error"}. Showing local estimate.`;
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
      extras,
      fetchedAt,
    };
  }
}

export const agyProvider = new AgyProvider();
