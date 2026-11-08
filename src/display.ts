import type { ProviderName, ProviderSnapshot, UsageWindow } from "./types.js";
import { bold, colors, dim, paint } from "./utils/ansi.js";
import {
  formatPercent,
  percentColorCode,
  progressBar,
} from "./utils/progress.js";
import {
  formatHeaderTime,
  formatLastUpdated,
  formatReset,
  WEEK_SECONDS,
  windowElapsedPercent,
} from "./utils/time.js";

const LABEL_WIDTH = 20;

const PROVIDER_TITLES: Record<ProviderName, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  agy: "Antigravity",
};

/** Stable quota rows to reserve while each provider is still in flight. */
const WAITING_WINDOW_LABELS: Record<ProviderName, readonly string[]> = {
  claude: ["Current session", "Weekly · All models", "Usage credits"],
  codex: ["Primary (7d)", "Credits", "Rate-limit resets"],
  grok: ["Identity", "Weekly credits"],
  cursor: ["Included usage", "On-demand spend"],
  agy: [
    "Weekly · Gemini",
    "Session · Gemini",
    "Weekly · Claude",
    "Session · Claude",
  ],
};

/** "$0", "$0.01", "$20" — no trailing ".0" on round dollar caps. */
function usd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return "<$0.01";
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function padLabel(label: string, width = LABEL_WIDTH): string {
  if (label.length >= width) return label.slice(0, width);
  return label + " ".repeat(width - label.length);
}

function colorBar(percent: number | null): string {
  const bar = progressBar(percent, 10);
  return paint(percentColorCode(percent), bar);
}

function providerTitle(s: ProviderSnapshot): string {
  const name = PROVIDER_TITLES[s.provider] ?? s.provider;
  // Prefer plan-looking labels as-is; always show plan badge when present.
  const parts = [name];
  // Avoid "Claude · personal · Ultra" when label is just a slot name —
  // show: Claude · max · Ultra  or  Claude · Ultra if label == plan-ish
  if (s.label) parts.push(s.label);
  if (s.plan && s.plan.toLowerCase() !== s.label.toLowerCase()) {
    parts.push(s.plan);
  }
  // Email stays in JSON / snapshot data, but not in the human title.
  return parts.join(" · ");
}

function renderWindowLine(w: UsageWindow, now: number): string {
  // Special non-percent windows
  if (w.id === "credits" || w.id === "reset-credits") {
    if (w.extra?.status === "off") {
      return `│  ${padLabel(w.label)}${dim("off")}`;
    }
    if (w.extra && "balance" in w.extra) {
      const bal = w.extra.balance;
      const unlimited = w.extra.unlimited;
      const text = unlimited ? "unlimited" : String(bal ?? 0);
      return `│  ${padLabel(w.label)}${colors.cyan(text)}`;
    }
    if (w.extra && "available" in w.extra) {
      return `│  ${padLabel(w.label)}${colors.cyan(String(w.extra.available))}`;
    }
    if (w.usedPercent != null) {
      // fall through to percent rendering
    } else if (w.extra?.status === "off") {
      return `│  ${padLabel(w.label)}${dim("off")}`;
    }
  }

  // Cursor's usage-based spend cap: dollars, not a rolling window.
  if (w.id === "spend") {
    const status = String(w.extra?.status ?? "off");
    if (status === "off") {
      return `│  ${padLabel(w.label)}${dim("off")}`;
    }
    const used = usd(Number(w.extra?.usedDollars ?? 0));
    if (status === "unlimited") {
      return `│  ${padLabel(w.label)}${colors.cyan(`${used} · unlimited`)}`;
    }
    const limit = usd(Number(w.extra?.limitDollars ?? 0));
    return `│  ${padLabel(w.label)}${colors.cyan(`${used} / ${limit}`)}`;
  }

  if (w.id === "identity") {
    const mode = String(w.extra?.mode ?? "oidc");
    const principal = String(w.extra?.principal ?? "User");
    return `│  ${padLabel(w.label)}${colors.cyan(`${mode} · ${principal}`)}`;
  }

  if (w.id === "activity" && w.usedPercent == null) {
    const status = String(w.extra?.status ?? "unknown");
    return `│  ${padLabel(w.label)}${colors.cyan(status)}`;
  }

  if (w.id === "local") {
    const sessions = w.extra?.sessions ?? 0;
    const tokensLabel = w.extra?.tokensLabel ?? "0";
    const days = w.extra?.windowDays ?? 30;
    return `│  ${padLabel(w.label)}${colors.cyan(
      `${sessions} sessions · ~${tokensLabel} tokens (${days}d)`,
    )}`;
  }

  if (w.id === "billing") {
    if (w.extra?.status === "unavailable") {
      const note = String(w.extra.note ?? "unavailable");
      return `│  ${padLabel(w.label)}${dim(`unavailable (${note})`)}`;
    }
    if (w.usedPercent == null && w.extra?.status === "received") {
      return `│  ${padLabel(w.label)}${colors.cyan("received (see --json)")}`;
    }
  }

  if (w.usedPercent == null && !w.resetsAt) {
    // Generic extras-only line
    if (w.extra && Object.keys(w.extra).length > 0) {
      return `│  ${padLabel(w.label)}${dim(JSON.stringify(w.extra))}`;
    }
  }

  const bar = colorBar(w.usedPercent);
  const pct = paint(
    percentColorCode(w.usedPercent),
    formatPercent(w.usedPercent),
  );
  // Dollar-metered windows (Cursor) spell out the spend — a bare percentage
  // hides which pool it's a percentage of.
  const used = w.extra?.usedDollars;
  const limit = w.extra?.limitDollars;
  const spendPart =
    typeof used === "number" && typeof limit === "number"
      ? dim(`  ${usd(used)} / ${usd(limit)}`)
      : "";

  const reset = formatReset(w.resetsAt, w.resetsInSeconds ?? null);
  const resetPart = reset ? dim(`  ${reset}`) : "";
  const weekly = w.windowSeconds === WEEK_SECONDS || /^Weekly\b/i.test(w.label);
  const elapsed = weekly
    ? windowElapsedPercent(
        w.windowSeconds ?? WEEK_SECONDS,
        w.resetsAt,
        w.resetsInSeconds,
        now,
      )
    : null;
  const elapsedPart = elapsed == null
    ? ""
    : ` used${dim(` · ${Math.round(elapsed)}% elapsed`)}`;
  return `│  ${padLabel(w.label)}${bar}  ${pct}${elapsedPart}${spendPart}${resetPart}`;
}

function renderSnapshot(s: ProviderSnapshot, now: number): string[] {
  const lines: string[] = [];
  const title = providerTitle(s);

  if (!s.ok) {
    lines.push(`${colors.red("┌")} ${bold(title)}`);
    lines.push(
      `│  ${colors.red("error")}  ${dim(s.error ?? "unknown error")}`,
    );
    lines.push("│");
    return lines;
  }

  const updated = formatLastUpdated(s.fetchedAt, now);
  lines.push(
    `${colors.cyan("┌")} ${bold(title)}${updated ? `  ${dim(updated)}` : ""}`,
  );
  for (const w of s.windows) {
    // Skip Grok's coarse "Local sessions" window when we have richer local stats
    if (
      s.provider === "grok" &&
      w.id === "local" &&
      s.local &&
      s.local.lines.length > 0
    ) {
      continue;
    }
    lines.push(renderWindowLine(w, now));
  }
  if (s.local?.lines?.length) {
    for (const line of s.local.lines) {
      lines.push(
        `│  ${padLabel(line.label)}${colors.cyan(line.value)}`,
      );
    }
  }
  if (s.extras?.warning) {
    lines.push(
      `│  ${colors.yellow("note")}  ${dim(String(s.extras.warning))}`,
    );
  }
  if (s.extras?.rehydrated) {
    lines.push(
      `│  ${dim(`refreshed slot from live Claude Code (${String(s.extras.rehydratedPlan ?? "")})`)}`,
    );
  }
  if (s.extras?.refreshed) {
    lines.push(`│  ${dim("renewed access token via OIDC refresh")}`);
  }
  lines.push("│");
  return lines;
}

export function renderHuman(
  snapshots: ProviderSnapshot[],
  headerAt = new Date(),
): string {
  const lines: string[] = [];
  lines.push(bold(`tokmeter · ${formatHeaderTime(headerAt)}`));
  lines.push("");
  const now = Date.now();
  for (const s of snapshots) {
    lines.push(...renderSnapshot(s, now));
  }
  if (snapshots.length === 0) {
    lines.push(dim("No accounts configured. Run: tokmeter accounts list"));
  }
  return lines.join("\n");
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** "3.2s" while it still feels like seconds, "1m 04s" once it doesn't. */
function formatElapsed(ms: number): string {
  const secs = Math.max(0, ms) / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Where one account is in its fetch, for the live view. */
export type FetchStatus =
  | { phase: "pending"; startedAt: number; attempt: number; maxAttempts: number }
  | {
      phase: "retrying";
      startedAt: number;
      attempt: number;
      maxAttempts: number;
      reason: string;
    }
  | { phase: "done"; snapshot: ProviderSnapshot };

export type LiveEntry = {
  provider: ProviderName;
  label: string;
  status: FetchStatus;
};

function renderWaiting(
  entry: LiveEntry,
  status: Exclude<FetchStatus, { phase: "done" }>,
  frame: number,
  now: number,
): string[] {
  const name = PROVIDER_TITLES[entry.provider] ?? entry.provider;
  const title = [name, entry.label].filter(Boolean).join(" · ");
  const spin = SPINNER[frame % SPINNER.length];
  const elapsed = formatElapsed(now - status.startedAt).padStart(6);
  const labels = [...WAITING_WINDOW_LABELS[entry.provider]];

  // Max currently has one extra scoped weekly pool. The account label is the
  // only plan information available before the provider response arrives.
  if (entry.provider === "claude" && /(^|\W)max(\W|$)/i.test(entry.label)) {
    labels.splice(2, 0, "Weekly · Fable");
  }

  let statusPart = "";
  if (status.phase === "retrying") {
    statusPart = dim(
      `  retry ${status.attempt}/${status.maxAttempts}: ${truncate(status.reason, 44)}`,
    );
  } else if (status.attempt > 1) {
    statusPart = dim(`  attempt ${status.attempt}/${status.maxAttempts}`);
  }

  const lines = [`${colors.gray("┌")} ${bold(title)}`];
  for (const [index, label] of labels.entries()) {
    const detail = index === 0 ? statusPart : "";
    lines.push(
      `│  ${padLabel(label)}${colors.yellow(spin)} ${dim(elapsed)}${detail}`,
    );
  }
  lines.push("│");
  return lines;
}

/**
 * Same layout as `renderHuman`, except the value/bar area of accounts still in
 * flight shows a spinner + elapsed counter. Their expected rows are painted up
 * front, so resolved accounts do not push the providers below them around.
 */
export function renderLive(
  entries: LiveEntry[],
  opts: { frame: number; now: number; headerAt: Date },
): string {
  const lines: string[] = [];
  lines.push(bold(`tokmeter · ${formatHeaderTime(opts.headerAt)}`));
  lines.push("");
  for (const entry of entries) {
    if (entry.status.phase === "done") {
      lines.push(...renderSnapshot(entry.status.snapshot, opts.now));
    } else {
      lines.push(...renderWaiting(entry, entry.status, opts.frame, opts.now));
    }
  }
  if (entries.length === 0) {
    lines.push(dim("No accounts configured. Run: tokmeter accounts list"));
  }
  return lines.join("\n");
}

export function renderJson(snapshots: ProviderSnapshot[]): string {
  return `${JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      accounts: snapshots,
    },
    null,
    2,
  )}\n`;
}
