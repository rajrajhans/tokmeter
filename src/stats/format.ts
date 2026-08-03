export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 100) return `$${n.toFixed(1)}`;
  return `$${Math.round(n)}`;
}

export function formatDurationSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0m";
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 48) return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

export function shortModelName(model: string): string {
  // claude-opus-5 → opus · gpt-5.6-sol → 5.6-sol · grok-4.5 → grok-4.5
  let m = model.replace(/^claude-/, "").replace(/^gpt-/, "");
  m = m.replace(/-\d{8}$/, ""); // strip date suffix
  if (m.length > 18) m = m.slice(0, 16) + "…";
  return m;
}

/** Local calendar date YYYY-MM-DD */
export function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

export function startOfLocalDay(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function isIsoOnLocalDay(iso: string, dayStart: Date): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  const end = dayStart.getTime() + 86_400_000;
  return t >= dayStart.getTime() && t < end;
}
