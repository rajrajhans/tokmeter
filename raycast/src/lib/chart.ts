/** Native-size quota dashboard, rendered by AppKit at retina resolution. */
import { redact, usageTone, weeklyFirst, type AccountView, type Row, type UsageView } from "./model";

export const PAGE_W = 720;
const MARGIN = 8;
const GAP = 8;
const CARD_W = (PAGE_W - MARGIN * 2 - GAP) / 2;
type Weight = "regular" | "medium" | "semibold";
export type DrawOp =
  | { op: "text"; x: number; y: number; text: string; size: number; weight: Weight; color: string; alpha: number; align: "left" | "right" | "center" }
  | { op: "round"; x: number; y: number; w: number; h: number; r: number; color: string; alpha: number };
export type Board = { scale: number; width: number; height: number; ops: DrawOp[] };
type Palette = { ink: string; muted: string; card: string; border: string; track: string; ok: string; caution: string; hot: string };

export function accountStatus(account: AccountView): { title: string; hint: string; unavailable: boolean } | undefined {
  const error = account.rows.find(r => r.label === "Couldn't load");
  const warning = account.rows.find(r => r.label === "Note" || r.label === "Saved");
  const message = error?.subtitle ?? warning?.subtitle ?? "";
  if (account.provider === "agy" && /could not load cloud quota/i.test(message))
    return { title: "Quota unavailable", hint: "Cloud usage could not be reached", unavailable: true };
  if (error) {
    if (/429|rate.limit|backing off/i.test(message)) {
      const delay = message.match(/backing off\s+([\d.]+\s*[smh])/i)?.[1];
      return { title: "Temporarily rate limited", hint: delay ? `Try refreshing in ${delay}` : "Try refreshing again shortly", unavailable: true };
    }
    if (/credential|login|log in|sign in|auth/i.test(message))
      return { title: "Sign-in needed", hint: `Reconnect in ${account.providerName === "Claude" ? "Claude Code" : account.providerName}`, unavailable: true };
    return { title: "Couldn’t load usage", hint: "Open account details for help", unavailable: true };
  }
  if (account.saved) return { title: "Saved", hint: account.subtitle ?? "Last available snapshot", unavailable: false };
  if (warning) return { title: "Partial", hint: "Some usage is unavailable", unavailable: false };
  return undefined;
}

export function layoutBoard(view: UsageView | undefined, opts: { failure?: string; theme?: "light" | "dark"; scale?: number } = {}): Board {
  const p: Palette = opts.theme !== "light"
    ? { ink: "#F1F2F3", muted: "#A6AAAF", card: "#27292C", border: "#36393D", track: "#42464A", ok: "#8AD0B4", caution: "#EBC080", hot: "#F18E87" }
    : { ink: "#24282D", muted: "#616871", card: "#F4F5F6", border: "#E0E3E6", track: "#D8DDE1", ok: "#23775B", caution: "#96600F", hot: "#BC413C" };
  const ops: DrawOp[] = [];
  const accounts = view?.accounts ?? [];
  const label = (v: string, x: number, y: number, size = 11, color = p.ink, weight: Weight = "regular", align: "left" | "right" | "center" = "left") => text(ops, v, x, y, size, weight, color, 1, align);
  label("tokmeter", MARGIN, 23, 19, p.ink, "semibold");
  label(opts.failure ? accounts.length ? `Refresh failed · data from ${view?.header}` : "Refresh failed" : view ? `Updated ${view.clock}` : "", PAGE_W - MARGIN, 21, 11, opts.failure ? p.caution : p.muted, "regular", "right");
  if (!accounts.length) {
    round(ops, MARGIN, 48, PAGE_W - MARGIN * 2, 148, 12, p.card);
    label(opts.failure ? "Couldn’t reach tokmeter" : "Your agents, at a glance", 30, 88, 17, p.ink, "semibold");
    label(opts.failure ? "Check the tokmeter path in Extension Preferences, then refresh." : "Sign in to Claude Code, Codex, Grok, Cursor, or Antigravity.", 30, 118, 12, p.muted);
    label(opts.failure ? "Open Actions for preferences and diagnostic details." : "Then refresh with ⌘R to load your connected accounts.", 30, 144, 12, p.muted);
    return { scale: opts.scale ?? 2, width: PAGE_W, height: 218, ops };
  }
  let y = 32;
  for (let i = 0; i < accounts.length; i += 2) {
    const pair = accounts.slice(i, i + 2);
    const height = Math.max(...pair.map(a => 100 + Math.max(0, ...meterSlots(a).map(slot => slot.line)) * 65));
    pair.forEach((a, col) => paintCard(a, MARGIN + col * (CARD_W + GAP), y, height, p, ops, Boolean(opts.failure)));
    y += height + GAP;
  }
  label("All values are % used", MARGIN, y + 7, 10, p.muted);
  round(ops, MARGIN + 119, y - 2, 2, 9, 0, p.muted);
  label("Tick = time elapsed", MARGIN + 127, y + 7, 10, p.muted);
  label("⌘D  Account details", PAGE_W - MARGIN, y + 7, 10, p.muted, "regular", "right");
  return { scale: opts.scale ?? 2, width: PAGE_W, height: y + 14, ops };
}

function meterRows(a: AccountView): Row[] { return accountStatus(a)?.unavailable ? [] : weeklyFirst(a.rows).filter(r => r.percent != null && Number.isFinite(r.percent)); }

/** Quota roles, rather than array position, determine visual hierarchy. */
function meterSlots(account: AccountView): { row: Row; secondary: boolean; line: number }[] {
  const rows = meterRows(account);
  const weekly = rows.filter(row => /week|7d/i.test(row.label));
  if (!weekly.length) return rows.map((row, i) => ({ row, secondary: i > 0, line: Math.max(0, i - 1) }));
  const other = rows.filter(row => !weekly.includes(row));
  return [
    ...weekly.map((row, line) => ({ row, secondary: false, line })),
    ...other.map((row, line) => ({ row, secondary: true, line })),
  ];
}

function paintCard(a: AccountView, x: number, y: number, h: number, p: Palette, ops: DrawOp[], retained = false) {
  round(ops, x, y, CARD_W, h, 10, p.border);
  round(ops, x + 1, y + 1, CARD_W - 2, h - 2, 9, p.card);
  const t = (v: string, dx: number, dy: number, size = 11, color = p.ink, weight: Weight = "regular", align: "left" | "right" | "center" = "left") => text(ops, v, x + dx, y + dy, size, weight, color, 1, align);
  const status = accountStatus(a);
  const providerW = textWidth(a.providerName, 13, "semibold");
  t(a.providerName, 14, 21, 13, p.ink, "semibold");
  const rest = a.title.slice(a.providerName.length).replace(/^\s*·\s*/, "");
  const age = a.subtitle?.split(" · ").at(-1);
  const badge = a.saved ? age && /ago$/.test(age) ? `Saved · ${age}` : "Saved" : "Partial";
  const badgeW = status && !status.unavailable ? textWidth(badge, 9) + 16 : 0;
  t(ellipsize(rest, 10, CARD_W - providerW - 38 - badgeW), 22 + providerW, 20, 10, p.muted);
  if (status && !status.unavailable) {
    round(ops, x + CARD_W - badgeW - 12, y + 8, badgeW, 18, 5, p.track, 0.5);
    t(badge, CARD_W - badgeW / 2 - 12, 21, 9, p.caution, "medium", "center");
  }
  const meters = meterRows(a);
  if (status?.unavailable) {
    round(ops, x + 14, y + 42, 3, 38, 1.5, p.caution, 0.7);
    t(ellipsize(status.title, 12, CARD_W - 42), 27, 58, 12, p.ink, "medium");
    t(ellipsize(status.hint, 11, CARD_W - 42), 27, 79, 11, p.muted);
    return;
  }
  if (!meters.length) {
    t("No active quotas", 14, 65, 14, p.ink, "medium");
    const facts = a.rows.filter(r => r.valueTag).map(r => `${r.label} ${r.valueTag}`).join(" · ");
    t(ellipsize(facts || "Open account details for more information", 11, CARD_W - 28), 14, 88, 11, p.muted);
    return;
  }
  // Identical primary widths let weekly quotas be compared across accounts.
  const primaryW = 204;
  const secondaryW = CARD_W - 28 - primaryW - 18;
  meterSlots(a).forEach(({ row: r, secondary, line }) => {
    const cellW = secondary ? secondaryW : primaryW;
    const mx = secondary ? 14 + primaryW + 18 : 14;
    const my = line * 65;
    const value = Math.max(0, Math.round(r.percent!));
    const tone = usageTone(value);
    const color = a.saved || retained ? p.muted : tone === "hot" ? p.hot : tone === "caution" ? p.caution : secondary ? p.muted : p.ok;
    t(ellipsize(quotaLabel(r.label), 10, cellW), mx, 40 + my, 10, p.muted);
    t(value + "%", mx, 69 + my, secondary ? 16 : 23, color, "medium");
    round(ops, x + mx, y + 75 + my, cellW, secondary ? 3 : 4, 2, p.track);
    if (value > 0) round(ops, x + mx, y + 75 + my, cellW * Math.min(value, 100) / 100, secondary ? 3 : 4, 2, color);
    if (r.elapsed != null && Number.isFinite(r.elapsed)) {
      const tick = Math.max(1, Math.min(cellW - 1, cellW * r.elapsed / 100));
      round(ops, x + mx + tick - 1, y + 73 + my, 2, 8, 0.5, p.ink);
    }
    const reset = r.resetText ? r.resetText.replace(/^resets/, "Resets") : "Reset not reported";
    t(ellipsize(reset, secondary ? 9 : 10, cellW), mx, 95 + my, secondary ? 9 : 10, p.muted);
  });
}

export function quotaLabel(label: string): string {
  return label.replace(/^Current session$/i, "Session").replace(/^Weekly · All models$/i, "Weekly").replace(/^Weekly credits$/i, "Weekly").replace(/^Primary \(7d\)$/i, "Weekly").replace(/^Weekly · (.+)$/i, "$1 · week");
}
function round(ops: DrawOp[], x: number, y: number, w: number, h: number, r: number, color: string, alpha = 1) { ops.push({ op: "round", x, y, w, h, r, color, alpha }); }
function text(ops: DrawOp[], value: string, x: number, y: number, size: number, weight: Weight, color: string, alpha: number, align: "left" | "right" | "center" = "left") {
  const clean = redact(value); if (clean) ops.push({ op: "text", x, y, text: clean, size, weight, color, alpha, align });
}
type FontWeight = "regular" | "medium" | "semibold";

// SF Pro advances at 13px, in tenths of a point. Index 0 is U+0020.
// The last four entries are · … – —.
const ADVANCE_13: Record<FontWeight, readonly number[]> = {
  regular: [36,40,61,81,81,120,92,38,49,49,61,81,38,61,38,39,81,60,78,81,83,80,82,73,82,82,38,38,81,81,81,66,119,87,85,92,94,77,74,96,96,34,69,85,73,113,96,100,82,100,84,82,82,95,87,125,87,84,85,49,39,49,81,75,64,71,79,72,79,74,46,78,76,31,31,70,32,112,75,76,79,78,49,67,46,75,70,100,67,70,69,49,33,49,81,38,104,75,113],
  medium: [35,42,66,83,83,125,93,40,51,51,61,83,40,61,40,40,84,62,80,83,85,82,84,75,85,84,40,40,83,83,83,68,119,90,86,94,95,78,75,97,98,36,72,87,74,114,97,100,84,100,86,84,83,96,89,127,90,87,86,51,40,51,83,77,64,73,81,73,81,75,48,80,78,33,33,73,34,115,77,77,80,80,51,69,49,77,72,103,70,72,71,51,35,51,83,40,111,77,114],
  semibold: [34,43,69,85,85,129,94,42,53,53,62,85,42,62,42,41,86,63,81,84,86,83,86,76,87,86,42,42,85,85,85,70,119,92,88,94,95,79,76,97,99,38,74,89,75,116,98,101,85,101,88,85,84,97,91,128,92,89,86,53,41,53,85,79,64,74,82,74,82,76,50,81,79,35,35,75,36,117,79,78,82,82,53,71,51,79,73,106,72,74,72,53,36,53,85,42,116,79,116],
};

const EXTRA_INDEX: Record<string, number> = { "·": 95, "…": 96, "–": 97, "—": 98 };

export function textWidth(value: string, size: number, weight: FontWeight = "regular"): number {
  const table = ADVANCE_13[weight];
  const scale = size / 13;
  let width = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const index = code >= 32 && code <= 126 ? code - 32 : EXTRA_INDEX[ch];
    const tenths = index == null ? undefined : table[index];
    width += tenths == null ? size * 0.52 : (tenths / 10) * scale;
  }
  return width;
}

function ellipsize(value: string, size: number, max: number, weight: FontWeight = "regular"): string {
  if (textWidth(value, size, weight) <= max) return value;
  let out = value;
  while (out.length > 1 && textWidth(`${out}…`, size, weight) > max) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}


export function dashboardAlt(view?: UsageView, failure?: string): string {
  let summary: string;
  if (!view?.accounts.length) {
    summary = failure ? "Could not reach tokmeter. " + failure : view
      ? "No accounts connected. Sign in to a supported coding tool, then refresh with Command R."
      : "Loading plan usage.";
  } else {
    summary = (failure ? `Refresh failed. Showing previous data from ${view.header}. ` : "") + view.accounts.map(account => {
      const status = accountStatus(account);
      if (status?.unavailable) return account.title + ": " + status.title + ". " + status.hint;
      const stamp = account.saved ? " (saved snapshot, " + (account.subtitle ?? "age unavailable") + ")" : "";
      return account.title + stamp + ": " + meterRows(account).map(r => r.label + " " + Math.round(r.percent!) + "% used, " + (r.resetText ?? "reset not reported")).join("; ");
    }).join(". ");
  }
  return redact(summary + ". Command D opens searchable account details.").replace(/[\[\]\\\n\r]/g, " ");
}
