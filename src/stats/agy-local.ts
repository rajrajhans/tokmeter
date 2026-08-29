import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LocalStats } from "../types.js";
import { pathExists } from "../utils/fs.js";

export async function collectAgyLocalStats(): Promise<LocalStats | null> {
  const agyBrain = join(homedir(), ".gemini", "antigravity-cli", "brain");
  if (!(await pathExists(agyBrain))) return null;

  let sessions = 0;

  try {
    const ents = await readdir(agyBrain, { withFileTypes: true });
    for (const ent of ents) {
      if (ent.isDirectory()) {
        const transcriptPath = join(agyBrain, ent.name, ".system_generated", "logs", "transcript.jsonl");
        if (await pathExists(transcriptPath)) {
          sessions += 1;
        }
      }
    }
  } catch {
    // ignore
  }

  if (sessions === 0) return null;

  return {
    period: "all_time",
    source: "local",
    lines: [
      { label: "Local sessions", value: `${sessions} sessions` }
    ]
  };
}
