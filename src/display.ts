import type { ProviderName, ProviderSnapshot, UsageWindow } from "./types.js";
import { bold, colors, dim, paint } from "./utils/ansi.js";
import {
  formatPercent,
  percentColorCode,
  progressBar,
} from "./utils/progress.js";
import { formatHeaderTime, formatReset } from "./utils/time.js";

const LABEL_WIDTH = 20;

const PROVIDER_TITLES: Record<ProviderName, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
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
  // Avoid "Claude · personal · Max 20x" when label is just a slot name —
  // show: Claude · max · Max 20x  or  Claude · Max 20x if label == plan-ish
  if (s.label) parts.push(s.label);
  if (s.plan && s.plan.toLowerCase() !== s.label.toLowerCase()) {
    parts.push(s.plan);
  }
  // Email stays in JSON / snapshot data, but not in the human title.
  return parts.join(" · ");
}

function renderWindowLine(w: UsageWindow): string {
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
  return `│  ${padLabel(w.label)}${bar}  ${pct}${spendPart}${resetPart}`;
}

function renderSnapshot(s: ProviderSnapshot): string[] {
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

  lines.push(`${colors.cyan("┌")} ${bold(title)}`);
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
    lines.push(renderWindowLine(w));
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
  lines.push("│");
  return lines;
}

export function renderHuman(snapshots: ProviderSnapshot[]): string {
  const lines: string[] = [];
  lines.push(bold(`tokmeter · ${formatHeaderTime()}`));
  lines.push("");
  for (const s of snapshots) {
    lines.push(...renderSnapshot(s));
  }
  if (snapshots.length === 0) {
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
