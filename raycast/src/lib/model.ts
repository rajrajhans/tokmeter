/**
 * Turn a `tokmeter --json` payload into one Raycast sheet.
 * Rows match the CLI: every quota, credits, and the last-saved stamp.
 * Emails and account ids are never copied onto the view.
 */

export const WEEK_SECONDS = 7 * 24 * 60 * 60;

export type UsageTone = "ok" | "caution" | "hot" | "neutral";
export type RowIcon = "quota" | "stat" | "note" | "alert" | "person" | "saved";

export type Meta = { title: string; text: string };

export type Row = {
  id: string;
  label: string;
  subtitle?: string;
  resetShort?: string;
  resetText?: string;
  dollars?: string;
  percent: number | null;
  /** How much of a weekly window has already passed, 0–100. */
  elapsed?: number | null;
  pace?: string | null;
  valueTag?: string;
  tone: UsageTone;
  icon: RowIcon;
  markdown: string;
  meta: Meta[];
  copyLine: string;
};

export type AccountView = {
  key: string;
  provider: string;
  providerName: string;
  shortLabel: string;
  title: string;
  subtitle?: string;
  /** Last good usage, served from the CLI's on-disk snapshot. */
  saved?: boolean;
  keywords: string[];
  rows: Row[];
};

export type UsageView = {
  clock: string;
  header: string;
  accounts: AccountView[];
  updatedLabel: string;
  summary: string;
  emptyMessage: string;
};

export type Payload = {
  fetchedAt?: unknown;
  accounts?: unknown;
};

type Window = {
  id?: unknown;
  label?: unknown;
  usedPercent?: unknown;
  resetsAt?: unknown;
  resetsInSeconds?: unknown;
  windowSeconds?: unknown;
  extra?: unknown;
};

type Snapshot = {
  provider?: unknown;
  label?: unknown;
  ok?: unknown;
  error?: unknown;
  plan?: unknown;
  provenance?: unknown;
  windows?: unknown;
  local?: unknown;
  extras?: unknown;
  fetchedAt?: unknown;
  source?: unknown;
  saved?: unknown;
};

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  agy: "Antigravity",
};

export function providerName(provider: string): string {
  if (PROVIDER_NAMES[provider]) return PROVIDER_NAMES[provider];
  if (!provider) return "Account";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function usageTone(percent: number | null): UsageTone {
  if (percent == null || !Number.isFinite(percent)) return "neutral";
  if (percent < 50) return "ok";
  if (percent < 80) return "caution";
  return "hot";
}

/** Mirrors `src/utils/progress.ts`. */
export function progressBar(percent: number | null, width = 24): string {
  if (percent == null || !Number.isFinite(percent) || width <= 0) {
    return "░".repeat(Math.max(0, width));
  }
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/** Mirrors `src/utils/time.ts`. `now` is epoch ms. */
export function windowElapsedPercent(
  windowSeconds: number,
  resetsAt: string | null,
  resetsInSeconds: number | null,
  now: number,
): number | null {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
  const remaining = Number.isFinite(resetMs)
    ? (resetMs - now) / 1000
    : resetsInSeconds;
  if (remaining == null || !Number.isFinite(remaining)) return null;
  return Math.max(0, Math.min(100, (1 - remaining / windowSeconds) * 100));
}

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

export function formatReset(
  resetsAt: string | null,
  resetsInSeconds: number | null,
  now: number,
): string {
  let secs = resetsInSeconds;
  if (secs == null && resetsAt) {
    const ms = Date.parse(resetsAt);
    secs = Number.isFinite(ms) ? Math.round((ms - now) / 1000) : null;
  }
  if (secs == null || !Number.isFinite(secs)) return "";
  if (secs <= 0) return "reset due";
  if (secs < 48 * 3600) return `resets in ${formatDuration(secs)}`;
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

export function redact(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "…")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "…")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function parsePayload(text: string): Payload {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("tokmeter returned invalid JSON");
  }
  if (
    !isRecord(data) ||
    typeof data.fetchedAt !== "string" ||
    !Array.isArray(data.accounts)
  ) {
    throw new Error("tokmeter returned unexpected JSON");
  }
  return sanitizePayload({
    fetchedAt: data.fetchedAt,
    accounts: data.accounts.filter(isRecord),
  });
}

/** Drop identity fields before the payload is cached or rendered. */
export function sanitizePayload(payload: {
  fetchedAt: string;
  accounts: Record<string, unknown>[];
}): Payload {
  return {
    fetchedAt: payload.fetchedAt,
    accounts: payload.accounts.map((account) => ({
      provider: account.provider,
      label: account.label,
      ok: account.ok,
      error:
        typeof account.error === "string" ? redact(account.error) : undefined,
      plan: account.plan,
      provenance: account.provenance,
      fetchedAt:
        typeof account.fetchedAt === "string" ? account.fetchedAt : undefined,
      saved: accountIsSaved(account) || undefined,
      windows: account.windows,
      local: sanitizeLocal(account.local),
      extras: sanitizeExtras(account.extras),
    })),
  };
}

export function present(payload: Payload, now = Date.now()): UsageView {
  const fetchedAt =
    typeof payload.fetchedAt === "string" ? payload.fetchedAt : "";
  const when = fetchedAt ? new Date(fetchedAt) : new Date(now);
  const header = formatHeader(
    Number.isNaN(when.getTime()) ? new Date(now) : when,
  );
  const clock = formatClock(
    Number.isNaN(when.getTime()) ? new Date(now) : when,
  );
  const rawAccounts = Array.isArray(payload.accounts)
    ? payload.accounts.filter(isRecord)
    : [];
  const accounts = rawAccounts.map((snapshot, index) =>
    toAccount(snapshot, index, now),
  );
  const summary = formatSummary(header, accounts);
  const emptyMessage = rawAccounts.length
    ? "Nothing is metering right now."
    : "No accounts discovered. Sign in to a supported tool, then refresh.";

  return {
    clock,
    header,
    accounts,
    updatedLabel: `Updated ${clock}`,
    summary,
    emptyMessage,
  };
}

function toAccount(
  snapshot: Snapshot,
  index: number,
  now: number,
): AccountView {
  const provider =
    typeof snapshot.provider === "string" ? snapshot.provider : "";
  const name = providerName(provider);
  const label = typeof snapshot.label === "string" ? snapshot.label : "";
  const plan = typeof snapshot.plan === "string" ? snapshot.plan : "";
  const title = displayTitle(name, label, plan);
  const warning = warningText(snapshot.extras);
  const saved = accountIsSaved(snapshot);
  const fetchedAt =
    typeof snapshot.fetchedAt === "string" ? snapshot.fetchedAt : null;
  const updated =
    snapshot.ok === false ? null : formatLastUpdated(fetchedAt, now);
  const provenance = provenanceLabel(snapshot.provenance);
  const account: AccountView = {
    key: `${provider || "account"}:${index}`,
    provider,
    providerName: name,
    shortLabel: label,
    title,
    subtitle: updated ?? (saved && !warning ? "Saved" : undefined),
    saved: saved || undefined,
    keywords: [name, provider, label, plan, title].filter(Boolean),
    rows: [],
  };

  if (snapshot.ok === false) {
    const message = redact(
      typeof snapshot.error === "string"
        ? snapshot.error
        : "Couldn't load this account",
    );
    account.rows.push(
      noteRow(account, 0, {
        label: "Couldn't load",
        text: message || "Couldn't load this account",
        icon: "alert",
        tone: "hot",
      }),
    );
    return account;
  }

  const windows = Array.isArray(snapshot.windows)
    ? snapshot.windows.filter(isRecord)
    : [];
  let rowIndex = 0;
  for (const window of windows) {
    if (/fable/i.test(String(window.label ?? "")) || /fable/i.test(String(window.id ?? ""))) continue;
    // The CLI fallback divides local sessions by an arbitrary capacity. It is not a plan quota.
    if (provider === "agy" && window.id === "activity" && /could not load cloud quota/i.test(warning ?? "")) continue;
    const row = toWindowRow(account, window, rowIndex, now, provenance);
    if (row) {
      account.rows.push(row);
      rowIndex += 1;
    }
  }

  const localLines = localStatLines(snapshot.local);
  if (localLines.length) {
    for (const line of localLines) {
      account.rows.push(statRow(account, rowIndex, line.label, line.value));
      rowIndex += 1;
    }
  }

  if (warning) {
    account.rows.push(
      noteRow(account, rowIndex, {
        label: saved ? "Saved" : "Note",
        text: warning,
        icon: saved ? "saved" : "note",
        tone: "neutral",
      }),
    );
    rowIndex += 1;
  }

  if (account.rows.length === 0) {
    account.rows.push(
      noteRow(account, 0, {
        label: "No active quotas",
        text: "Nothing to meter for this account.",
        icon: "note",
        tone: "neutral",
      }),
    );
  }

  uniquifyLabels(account.rows);
  account.keywords.push(...account.rows.map((row) => row.label));
  return account;
}

function toWindowRow(
  account: AccountView,
  window: Window,
  index: number,
  now: number,
  provenance: string | null,
): Row | null {
  const id = typeof window.id === "string" ? window.id : "";
  // Grok's coarse local window is replaced by richer on-disk lines when present.
  if (id === "local") return null;

  const label =
    typeof window.label === "string" && window.label ? window.label : "Quota";
  const extra = isRecord(window.extra) ? window.extra : {};
  const percent = finiteNumber(window.usedPercent);
  const resetsAt = typeof window.resetsAt === "string" ? window.resetsAt : null;
  const resetsInSeconds = finiteNumber(window.resetsInSeconds);
  const windowSeconds = finiteNumber(window.windowSeconds);
  const weekly = windowSeconds === WEEK_SECONDS || /^Weekly\b/i.test(label);
  const elapsed = weekly
    ? windowElapsedPercent(
        windowSeconds ?? WEEK_SECONDS,
        resetsAt,
        resetsInSeconds,
        now,
      )
    : null;
  const resetText = formatReset(resetsAt, resetsInSeconds, now);
  const elapsedText =
    elapsed == null ? undefined : `${Math.round(elapsed)}% elapsed`;

  if (id === "identity") {
    const text = identityText(extra);
    if (!text) return null;
    return simpleRow(account, index, {
      label,
      valueTag: text,
      icon: "person",
      tone: "neutral",
    });
  }

  if (id === "credits" || id === "reset-credits") {
    const credit = creditValue(extra);
    if (credit) {
      return simpleRow(account, index, {
        label,
        valueTag: credit,
        icon: "note",
        tone: "neutral",
      });
    }
  }

  if (id === "spend") {
    const spend = spendPhrase(extra);
    if (spend) {
      return simpleRow(account, index, {
        label,
        valueTag: spend,
        icon: "note",
        tone: "neutral",
      });
    }
  }

  if (id === "activity" && percent == null) {
    const status =
      typeof extra.status === "string" && extra.status
        ? redact(extra.status)
        : "unknown";
    return simpleRow(account, index, {
      label,
      valueTag: status,
      icon: "stat",
      tone: "neutral",
    });
  }

  if (id === "billing" && extra.status === "unavailable") {
    const note = redact(
      typeof extra.note === "string" && extra.note ? extra.note : "unavailable",
    );
    return simpleRow(account, index, {
      label,
      subtitle: note,
      valueTag: "unavailable",
      icon: "alert",
      tone: "hot",
    });
  }

  if (id === "billing" && percent == null && extra.status === "received") {
    return simpleRow(account, index, {
      label,
      valueTag: "received",
      icon: "note",
      tone: "neutral",
    });
  }

  const dollars = dollarPhrase(extra);
  if (percent == null && !dollars && !resetText) return null;

  const tone = usageTone(percent);
  const subtitle = joinBits([dollars, elapsedText, resetText || undefined]);
  const pace = paceLabel(percent, elapsed);
  const meta: Meta[] = [];
  if (percent != null)
    meta.push({ title: "Used", text: `${Math.round(percent)}%` });
  if (elapsed != null)
    meta.push({ title: "Elapsed", text: `${Math.round(elapsed)}%` });
  if (pace) meta.push({ title: "Pace", text: pace });
  if (resetText) meta.push({ title: "Resets", text: resetText });
  if (dollars) meta.push({ title: "Spend", text: dollars });
  if (provenance) meta.push({ title: "Quota", text: provenance });

  const markdown = quotaMarkdown({
    percent,
    label,
    elapsed,
    pace,
    resetText,
    dollars,
  });
  const copyBits = [
    percent != null ? `${Math.round(percent)}%` : "—",
    dollars ?? null,
    elapsedText ?? null,
    resetText || null,
  ].filter((bit): bit is string => Boolean(bit));

  return {
    id: `${account.key}:${index}`,
    label,
    subtitle,
    resetShort: shortenReset(resetText),
    resetText: resetText || undefined,
    dollars,
    percent,
    elapsed,
    pace,
    valueTag: percent == null ? "—" : undefined,
    tone,
    icon: "quota",
    markdown,
    meta,
    copyLine: `${account.title} · ${label}  ${copyBits.join("  ")}`.trim(),
  };
}

function simpleRow(
  account: AccountView,
  index: number,
  input: {
    label: string;
    subtitle?: string;
    valueTag?: string;
    icon: RowIcon;
    tone: UsageTone;
  },
): Row {
  const bits = [input.valueTag, input.subtitle].filter((bit): bit is string =>
    Boolean(bit),
  );
  return {
    id: `${account.key}:${index}`,
    label: input.label,
    subtitle: input.subtitle,
    percent: null,
    valueTag: input.valueTag,
    tone: input.tone,
    icon: input.icon,
    markdown: `# ${escapeMd(input.label)}\n\n${escapeMd(bits.join(" · ") || "—")}`,
    meta: [
      { title: "Account", text: account.title },
      ...(input.valueTag ? [{ title: "Value", text: input.valueTag }] : []),
      ...(input.subtitle ? [{ title: "Note", text: input.subtitle }] : []),
    ],
    copyLine: `${account.title} · ${input.label}  ${bits.join("  ")}`.trim(),
  };
}

function noteRow(
  account: AccountView,
  index: number,
  input: { label: string; text: string; icon: RowIcon; tone: UsageTone },
): Row {
  const text = redact(input.text);
  return {
    id: `${account.key}:${index}`,
    label: input.label,
    subtitle: text,
    percent: null,
    tone: input.tone,
    icon: input.icon,
    markdown: `# ${input.label}\n\n${text}`,
    meta: [
      { title: "Account", text: account.title },
      { title: "Note", text: text },
    ],
    copyLine: `${account.title} · ${input.label}  ${text}`,
  };
}

function statRow(
  account: AccountView,
  index: number,
  label: string,
  value: string,
): Row {
  const text = redact(value);
  return {
    id: `${account.key}:stat:${index}`,
    label,
    subtitle: text,
    percent: null,
    tone: "neutral",
    icon: "stat",
    markdown: `# ${escapeMd(label)}\n\n${escapeMd(text)}\n\nOn-disk activity. Not a plan quota.`,
    meta: [
      { title: "Activity", text: text },
      { title: "Source", text: "On this Mac" },
    ],
    copyLine: `${account.title} · ${label}  ${text}`,
  };
}

function quotaMarkdown(input: {
  percent: number | null;
  label: string;
  elapsed: number | null;
  pace: string | null;
  resetText: string;
  dollars?: string;
}): string {
  const hero =
    input.percent != null ? `${Math.round(input.percent)}%` : (input.dollars ?? "—");
  const lines = [`# ${escapeMd(hero)}`, "", escapeMd(input.label)];
  if (input.percent != null) {
    lines.push("", "```", progressBar(input.percent), "```");
  }
  if (input.pace && input.elapsed != null) {
    lines.push(
      "",
      `${input.pace}. ${Math.round(input.elapsed)}% of this window has elapsed.`,
    );
  }
  if (input.dollars && input.percent != null) lines.push("", input.dollars);
  if (input.resetText) lines.push("", input.resetText);
  return lines.join("\n");
}

function paceLabel(used: number | null, elapsed: number | null): string | null {
  if (used == null || elapsed == null) return null;
  const delta = used - elapsed;
  if (delta > 10) return "Faster than this window";
  if (delta < -10) return "Slower than this window";
  return "In line with this window";
}

function dollarPhrase(extra: Record<string, unknown>): string | undefined {
  const used = finiteNumber(extra.usedDollars);
  const limit = finiteNumber(extra.limitDollars);
  if (extra.unlimited === true && used != null)
    return `${usd(used)} · unlimited`;
  if (extra.status === "unlimited" && used != null)
    return `${usd(used)} · unlimited`;
  if (used != null && limit != null) return `${usd(used)} / ${usd(limit)}`;
  return undefined;
}

function spendPhrase(extra: Record<string, unknown>): string | undefined {
  const status = typeof extra.status === "string" ? extra.status : "";
  if (status === "off") return "off";
  if (extra.unlimited === true || status === "unlimited") {
    const used = finiteNumber(extra.usedDollars);
    return used == null ? "unlimited" : `${usd(used)} · unlimited`;
  }
  return dollarPhrase(extra);
}

/** Mirrors the CLI credit line, including an explicit off or zero. */
function creditValue(extra: Record<string, unknown>): string | undefined {
  if (extra.status === "off") return "off";
  if (extra.unlimited === true) return "unlimited";
  if ("balance" in extra) {
    if (extra.balance == null || extra.balance === "") return "0";
    return redact(String(extra.balance));
  }
  if ("available" in extra && extra.available != null && extra.available !== "")
    return redact(String(extra.available));
  return undefined;
}

function identityText(extra: Record<string, unknown>): string | undefined {
  const mode = typeof extra.mode === "string" ? redact(extra.mode) : "";
  const principal =
    typeof extra.principal === "string" ? redact(extra.principal) : "";
  const text = [mode, principal].filter(Boolean).join(" · ");
  return text || undefined;
}

function joinBits(parts: (string | undefined)[]): string | undefined {
  const bits = parts.filter((part): part is string => Boolean(part));
  return bits.length ? bits.join(" · ") : undefined;
}

function accountIsSaved(account: {
  provenance?: unknown;
  source?: unknown;
  saved?: unknown;
  extras?: unknown;
}): boolean {
  if (account.saved === true) return true;
  if (account.provenance === "partial") return true;
  if (typeof account.source === "string" && account.source.includes("+stale"))
    return true;
  const warning = warningText(account.extras);
  return Boolean(warning && /last saved/i.test(warning));
}

/** Mirrors `src/utils/time.ts`. Null until the snapshot is 15 minutes old. */
export function formatLastUpdated(
  fetchedAt: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!fetchedAt) return null;
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return null;
  const ageMs = now - at;
  if (ageMs < 15 * 60_000) return null;
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.toDateString() === new Date(now).toDateString();
  const when = sameDay
    ? hhmm
    : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hhmm}`;
  const ago = formatDuration(Math.floor(ageMs / 60_000) * 60);
  return `updated ${when} · ${ago} ago`;
}

function shortenReset(resetText: string): string | undefined {
  if (!resetText) return undefined;
  if (resetText === "reset due") return "due";
  if (resetText.startsWith("resets in "))
    return resetText.slice("resets in ".length);
  if (resetText.startsWith("resets ")) return resetText.slice("resets ".length);
  return resetText;
}

function formatSummary(header: string, accounts: AccountView[]): string {
  const lines = [`tokmeter · ${header}`, ""];
  if (accounts.length === 0) {
    lines.push("No accounts discovered.");
    return lines.join("\n");
  }
  for (const account of accounts) {
    lines.push(account.title);
    if (account.subtitle) lines.push(`  ${account.subtitle}`);
    const width = Math.max(12, ...account.rows.map((row) => row.label.length));
    for (const row of weeklyFirst(account.rows)) {
      const bits = [
        row.percent != null ? `${Math.round(row.percent)}%` : null,
        row.percent != null ? null : (row.valueTag ?? null),
        row.subtitle && row.subtitle !== row.valueTag ? row.subtitle : null,
        row.subtitle ? null : (row.resetText ?? null),
      ].filter(
        (bit, index, all): bit is string =>
          Boolean(bit) && all.indexOf(bit) === index,
      );
      lines.push(`  ${row.label.padEnd(width)}  ${bits.join("  ")}`.trimEnd());
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function displayTitle(name: string, label: string, plan: string): string {
  const parts = [name];
  if (label) parts.push(label);
  if (plan && plan.toLowerCase() !== label.toLowerCase()) parts.push(plan);
  return parts.join(" · ");
}

function warningText(extras: unknown): string | undefined {
  if (!isRecord(extras) || typeof extras.warning !== "string") return undefined;
  const text = redact(extras.warning);
  return text || undefined;
}

function provenanceLabel(value: unknown): string | null {
  switch (value) {
    case "official":
      return "Official";
    case "local_estimate":
      return "Local estimate";
    case "partial":
      return "Partial";
    case "unknown":
      return null;
    default:
      return null;
  }
}

function sanitizeLocal(
  local: unknown,
): { lines: { label: string; value: string }[] } | undefined {
  const lines = localStatLines(local);
  return lines.length ? { lines } : undefined;
}

function sanitizeExtras(extras: unknown): { warning: string } | undefined {
  if (!isRecord(extras) || typeof extras.warning !== "string") return undefined;
  const warning = redact(extras.warning);
  return warning ? { warning } : undefined;
}

function localStatLines(local: unknown): { label: string; value: string }[] {
  if (!isRecord(local) || !Array.isArray(local.lines)) return [];
  const lines: { label: string; value: string }[] = [];
  for (const line of local.lines) {
    if (
      !isRecord(line) ||
      typeof line.label !== "string" ||
      typeof line.value !== "string"
    )
      continue;
    if (!line.label.trim() || !line.value.trim()) continue;
    lines.push({ label: line.label, value: line.value });
  }
  return lines;
}

function uniquifyLabels(rows: Row[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const count = seen.get(row.label) ?? 0;
    seen.set(row.label, count + 1);
    if (count === 0) continue;
    const next = `${row.label} (${count + 1})`;
    row.copyLine = row.copyLine.replace(`· ${row.label}`, `· ${next}`);
    row.markdown = row.markdown.replace(row.label, next);
    row.label = next;
  }
}

function usd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return "<$0.01";
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function finiteNumber(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
}

function formatHeader(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day} ${formatClock(d)}`;
}

function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_[\]]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Weekly is always first; non-weekly meters remain secondary. */
export function weeklyFirst(rows: Row[]): Row[] {
  const rank = (row: Row) => /weekly|week|7d/i.test(row.label) ? 0 : row.percent != null ? 1 : 2;
  return rows.filter(row => !/fable/i.test(row.label)).slice().sort((a, b) => rank(a) - rank(b));
}

/** Native detail content; all sections scroll together. */
export function accountMarkdown(account: AccountView): string {
  const lines = ["## " + escapeMd(account.title)];
  if (account.subtitle) lines.push(escapeMd(account.subtitle));
  for (const row of weeklyFirst(account.rows).filter(row => row.icon !== "person")) {
    lines.push("### " + escapeMd(row.label));
    if (row.percent != null) {
      lines.push("**" + Math.round(row.percent) + "% used**" + (row.elapsed != null ? " · " + Math.round(row.elapsed) + "% of window elapsed" : ""));
      lines.push("`" + progressBar(row.percent, 20) + "`");
      if (row.resetText) lines.push(escapeMd(row.resetText.replace(/^resets/, "Resets")));
      if (row.dollars) lines.push(escapeMd(row.dollars));
    } else {
      lines.push(escapeMd([row.valueTag, row.subtitle].filter(Boolean).join(" · ") || "Not reported"));
    }
  }
  return lines.join("\n\n");
}
