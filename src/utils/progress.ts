/** Build a Unicode block progress bar. */
export function progressBar(
  percent: number | null | undefined,
  width = 10,
): string {
  if (percent == null || !Number.isFinite(percent)) {
    return "░".repeat(width);
  }
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

export function percentColorCode(percent: number | null | undefined): number {
  if (percent == null || !Number.isFinite(percent)) return 245; // gray
  if (percent < 50) return 46; // green
  if (percent < 80) return 226; // yellow
  return 196; // red
}

export function formatPercent(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent)) return "  —";
  const n = Math.round(percent);
  return `${String(n).padStart(3)}%`;
}
