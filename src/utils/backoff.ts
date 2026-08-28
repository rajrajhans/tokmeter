/**
 * Cross-run backoff state for token refresh.
 *
 * Refresh endpoints rate-limit hard, and tokmeter can be invoked once a second
 * by a status bar / HUD. Persisting "don't retry until T" to disk keeps a
 * failing account from burning the whole refresh budget.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathExists, readJsonFile, writeJsonFile } from "./fs.js";

export function cacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return xdg ? join(xdg, "tokmeter") : join(homedir(), ".cache", "tokmeter");
}

type BackoffState = Record<string, { until: number; lastStatus?: number }>;

function statePath(file: string): string {
  return join(cacheRoot(), file);
}

async function readState(file: string): Promise<BackoffState> {
  try {
    const p = statePath(file);
    if (await pathExists(p)) return await readJsonFile<BackoffState>(p);
  } catch {
    /* corrupt or unreadable → treat as empty */
  }
  return {};
}

async function writeState(file: string, state: BackoffState): Promise<void> {
  await writeJsonFile(statePath(file), state);
}

/** Epoch ms until which `key` is backed off, or null if it may be retried. */
export async function isBackedOff(
  file: string,
  key: string,
): Promise<number | null> {
  const state = await readState(file);
  const until = state[key]?.until ?? 0;
  return until > Date.now() ? until : null;
}

export async function markBackoff(
  file: string,
  key: string,
  durationMs: number,
  lastStatus?: number,
): Promise<void> {
  const state = await readState(file);
  state[key] = { until: Date.now() + durationMs, lastStatus };
  await writeState(file, state);
}

export async function clearBackoff(file: string, key: string): Promise<void> {
  const state = await readState(file);
  if (state[key]) {
    delete state[key];
    await writeState(file, state);
  }
}
