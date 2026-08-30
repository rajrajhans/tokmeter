/**
 * Live usage view.
 *
 * Providers do not cost the same: the Antigravity provider shells out to the
 * `agy` CLI and routinely takes ~12s, while the rest land inside a second.
 * Waiting for all of them before printing anything made the whole CLI feel as
 * slow as its slowest account. Instead, paint every account's slot up front and
 * let each box fill itself in as its fetch resolves — the process still exits
 * only once every account has settled.
 */
import {
  type FetchStatus,
  type LiveEntry,
  renderHuman,
  renderLive,
} from "./display.js";
import { MAX_ATTEMPTS, fetchSnapshots } from "./providers/index.js";
import type { AccountConfig, ProviderSnapshot } from "./types.js";
import { LiveRegion } from "./utils/live-region.js";

const FRAME_MS = 80;

/** Live redraw needs a real terminal to move the cursor around in. */
export function liveSupported(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.TOKMETER_NO_LIVE) return false;
  if (process.env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

export type LiveOptions = {
  includeLocal?: boolean;
  /** Applied to each snapshot before it is rendered (e.g. concise mode). */
  transform?: (snapshot: ProviderSnapshot) => ProviderSnapshot;
};

export async function fetchAndRenderLive(
  accounts: AccountConfig[],
  opts: LiveOptions = {},
): Promise<ProviderSnapshot[]> {
  const region = new LiveRegion();
  const startedAt = Date.now();
  // Frozen so the header does not tick over a minute boundary mid-run.
  const headerAt = new Date();

  const statuses: FetchStatus[] = accounts.map(() => ({
    phase: "pending",
    startedAt,
    attempt: 1,
    maxAttempts: MAX_ATTEMPTS,
  }));

  const entries = (): LiveEntry[] =>
    accounts.map((a, i) => ({
      provider: a.provider,
      label: a.label,
      status: statuses[i],
    }));

  let frame = 0;
  const draw = (): void => {
    region.update(renderLive(entries(), { frame, now: Date.now(), headerAt }));
  };

  // Paint before awaiting anything, so the layout is on screen immediately.
  draw();

  const timer = setInterval(() => {
    frame += 1;
    draw();
  }, FRAME_MS);

  const onInterrupt = (): void => {
    clearInterval(timer);
    region.abort();
    process.exit(130);
  };
  process.on("SIGINT", onInterrupt);

  let snapshots: ProviderSnapshot[];
  try {
    snapshots = await fetchSnapshots(accounts, {
      includeLocal: opts.includeLocal,
      onRetry: (index, info) => {
        statuses[index] = {
          phase: "retrying",
          // Keep counting from the first attempt — the user cares how long
          // they have been waiting, not how long this attempt has run.
          startedAt,
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          reason: info.reason,
        };
        draw();
      },
      onAttempt: (index, attempt, maxAttempts) => {
        statuses[index] = { phase: "pending", startedAt, attempt, maxAttempts };
        draw();
      },
      onSettled: (index, snapshot) => {
        statuses[index] = {
          phase: "done",
          snapshot: opts.transform ? opts.transform(snapshot) : snapshot,
        };
        draw();
      },
    });
  } finally {
    clearInterval(timer);
    process.off("SIGINT", onInterrupt);
  }

  const finalSnapshots = opts.transform
    ? snapshots.map(opts.transform)
    : snapshots;
  region.finish(renderHuman(finalSnapshots, headerAt));
  return finalSnapshots;
}
