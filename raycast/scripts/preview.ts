/** Synthetic data only. Run from the repo root: npx tsx raycast/scripts/preview.ts */
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { layoutBoard } from "../src/lib/chart";
import { present, WEEK_SECONDS } from "../src/lib/model";

const now = Date.parse("2026-08-03T12:00:00Z");
const quota = (id: string, label: string, usedPercent: number, resetsInSeconds: number, weekly = false) => ({ id, label, usedPercent, resetsInSeconds, windowSeconds: weekly ? WEEK_SECONDS : undefined });
export const demoPayload = {
  fetchedAt: new Date(now).toISOString(),
  accounts: [
    { provider: "claude", label: "primary", ok: false, error: "OAuth refresh rate-limited (HTTP 429). Backing off 15m.", windows: [] },
    { provider: "claude", label: "secondary", plan: "Max", ok: true, windows: [quota("session", "Current session", 12, 10260), quota("weekly", "Weekly · All models", 67, 302400, true), quota("fable", "Weekly · Fable", 1, 302400, true)] },
    { provider: "codex", label: "personal", plan: "Pro", ok: true, windows: [quota("primary", "Primary (7d)", 26, 259200, true), { id: "credits", label: "Credits", extra: { balance: 0 } }] },
    { provider: "grok", label: "personal", ok: true, windows: [quota("weekly", "Weekly credits", 26, 259200, true)] },
    { provider: "cursor", label: "personal", ok: false, error: "Cursor credentials not found — run: cursor-agent login", windows: [] },
    { provider: "agy", label: "personal", plan: "Cloud", ok: true, extras: { warning: "Could not load cloud quota: spawn agy ENOENT. Showing local estimate." }, windows: [quota("activity", "Daily capacity", 100, 0)] },
  ],
};
const out = process.argv[2] || "/tmp/tokmeter-design";
mkdirSync(out, { recursive: true });

const healthy = structuredClone(demoPayload);
healthy.accounts[0] = { provider: "claude", label: "primary", plan: "Pro", ok: true, windows: [quota("session", "Current session", 83, 3240), quota("weekly", "Weekly · All models", 92, 86400, true)] };
healthy.accounts[4] = { provider: "cursor", label: "personal", plan: "Pro", ok: true, windows: [quota("included", "Included usage", 38, 864000)] };
healthy.accounts[5] = { provider: "agy", label: "personal", plan: "Cloud", ok: true, windows: [quota("weekly", "Weekly · Gemini", 17, 172800, true)] };
const saved = structuredClone(healthy) as { fetchedAt: string; accounts: Record<string, unknown>[] };
saved.accounts[1] = { ...saved.accounts[1], label: "a-long-account-name-for-layout-review", saved: true, fetchedAt: new Date(now - 7200000).toISOString(), extras: { warning: "Showing last saved usage" } };
const scenarios = [
  { name: "dashboard", payload: demoPayload },
  { name: "healthy", payload: healthy },
  { name: "saved", payload: saved, failure: "Synthetic refresh failure" },
  { name: "empty", payload: { ...demoPayload, accounts: [] } },
  { name: "failure", payload: { ...demoPayload, accounts: [] }, failure: "Synthetic binary error" },
];
for (const scenario of scenarios) for (const theme of ["dark", "light"] as const) {
  const view = present(scenario.payload, now);
  const spec = layoutBoard(view, { theme, failure: scenario.failure });
  // Only the preview has a canvas; the extension image stays transparent.
  spec.ops.unshift({ op: "round", x: 0, y: 0, w: spec.width, h: spec.height, r: 0, color: theme === "dark" ? "#1C1D1F" : "#FFFFFF", alpha: 1 });
  const file = join(out, scenario.name + "-" + theme);
  writeFileSync(file + ".json", JSON.stringify(spec));
  execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "raycast/assets/draw.js", file + ".json", file + ".png"]);
  console.log(file + ".png (" + spec.width + " × " + spec.height + ")");
}
