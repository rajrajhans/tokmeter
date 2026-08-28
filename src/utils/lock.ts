/**
 * Advisory file lock, matching the `<file>.lock` convention the Grok CLI uses
 * ("<pid>:<unix seconds>").
 *
 * Credential files are shared with the CLI that owns them, and refresh tokens
 * rotate — two processes refreshing at once would invalidate each other's
 * token. Holding this while refreshing keeps that from happening.
 */
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Treat a lock held this long as abandoned. */
const DEFAULT_STALE_MS = 30_000;

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    // Vanished between EEXIST and read — treat as free.
    return true;
  }

  const [pidStr, tsStr] = raw.trim().split(":");
  const pid = Number(pidStr);
  const ts = Number(tsStr);

  if (Number.isFinite(ts) && Date.now() - ts * 1000 > staleMs) return true;
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false; // holder is alive
    } catch (e) {
      // ESRCH = no such process; EPERM means it exists but isn't ours.
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  return false;
}

/**
 * Take `lockPath`, reclaiming it if the holder died or timed out.
 * Throws if a live process holds it. Returns the release function.
 */
export async function acquireLock(
  lockPath: string,
  staleMs = DEFAULT_STALE_MS,
): Promise<() => Promise<void>> {
  const payload = `${process.pid}:${Math.floor(Date.now() / 1000)}`;
  const release = async () => {
    await unlink(lockPath).catch(() => {});
  };

  // The lock may live in a cache dir that doesn't exist on a first run.
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockPath, "wx", 0o600);
      await fh.writeFile(payload, "utf8");
      await fh.close();
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (attempt > 0) break;
      if (!(await isStale(lockPath, staleMs))) break;
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error(`${lockPath} is locked by another process`);
}
