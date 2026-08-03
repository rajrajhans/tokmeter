/** Format a duration in seconds as a short human string, e.g. "4h 16m". */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const s = Math.floor(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    const remM = m % 60;
    return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
}

/** Seconds until an ISO timestamp (or unix seconds/ms). Negative if past. */
export function secondsUntil(isoOrUnix: string | number | null | undefined): number | null {
  if (isoOrUnix == null) return null;
  let ms: number;
  if (typeof isoOrUnix === "number") {
    // Heuristic: < 1e12 is seconds, else milliseconds
    ms = isoOrUnix < 1e12 ? isoOrUnix * 1000 : isoOrUnix;
  } else {
    ms = Date.parse(isoOrUnix);
    if (Number.isNaN(ms)) return null;
  }
  return Math.round((ms - Date.now()) / 1000);
}

/** Human reset string: "resets in 4h 16m" or "resets Thu 7:30 PM". */
export function formatReset(
  resetsAt: string | null | undefined,
  resetsInSeconds?: number | null,
): string {
  let secs = resetsInSeconds ?? null;
  if (secs == null && resetsAt) secs = secondsUntil(resetsAt);
  if (secs == null) return "";
  if (secs <= 0) return "reset due";

  // Prefer relative under 2 days; absolute weekday for longer windows
  if (secs < 48 * 3600) {
    return `resets in ${formatDuration(secs)}`;
  }
  if (resetsAt) {
    const d = new Date(resetsAt);
    if (!Number.isNaN(d.getTime())) {
      const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
      const time = d.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      return `resets ${weekday} ${time}`;
    }
  }
  return `resets in ${formatDuration(secs)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatHeaderTime(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}`;
}
