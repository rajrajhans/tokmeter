import type { ProviderSnapshot, UsageWindow } from "./types.js";
import { bold, colors, dim, paint } from "./utils/ansi.js";
import {
  formatPercent,
  percentColorCode,
  progressBar,
} from "./utils/progress.js";
import { formatHeaderTime, formatReset } from "./utils/time.js";

const LABEL_WIDTH = 20;

function padLabel(label: string, width = LABEL_WIDTH): string {
  if (label.length >= width) return label.slice(0, width);
  return label + " ".repeat(width - label.length);
}

function colorBar(percent: number | null): string {
  const bar = progressBar(percent, 10);
  return paint(percentColorCode(percent), bar);
}

function providerTitle(s: ProviderSnapshot): string {
  const name =
    s.provider === "claude"
      ? "Claude"
      : s.provider === "codex"
        ? "Codex"
        : "Grok";
  const parts = [name, s.label];
  if (s.plan) parts.push(s.plan);
  if (s.email) parts.push(s.email);
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
  const reset = formatReset(w.resetsAt, w.resetsInSeconds ?? null);
  const resetPart = reset ? dim(`  ${reset}`) : "";
  return `│  ${padLabel(w.label)}${bar}  ${pct}${resetPart}`;
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
    lines.push(renderWindowLine(w));
  }
  if (s.extras?.warning) {
    lines.push(`│  ${colors.yellow("warning")}  ${dim(String(s.extras.warning))}`);
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
