import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAGE_W, accountStatus, dashboardAlt, layoutBoard, type Board, textWidth } from "./chart";
import type { UsageView } from "./model";
function texts(board: Board) { return board.ops.flatMap(op => op.op === "text" ? [op.text] : []); }
const view: UsageView = {
  clock: "16:38",
  header: "2026-08-03 16:38",
  updatedLabel: "Updated 16:38",
  summary: "tokmeter",
  emptyMessage: "No accounts discovered. Sign in to a supported tool, then refresh.",
  accounts: [
    {
      key: "claude:0",
      provider: "claude",
      providerName: "Claude",
      shortLabel: "primary",
      title: "Claude · primary",
      keywords: [],
      rows: [
        {
          id: "e",
          label: "Couldn't load",
          subtitle:
            "OAuth refresh rate-limited (HTTP 429). Backing off 15m. Log into this account in Claude Code, then: tokmeter save-claude <label>",
          percent: null,
          tone: "hot",
          icon: "alert",
          markdown: "",
          meta: [],
          copyLine: "",
        },
      ],
    },
    {
      key: "claude:1",
      provider: "claude",
      providerName: "Claude",
      shortLabel: "secondary",
      title: "Claude · secondary · Max",
      saved: true,
      subtitle: "updated 15:40 · 2h ago",
      keywords: [],
      rows: [
        {
          id: "s",
          label: "Current session",
          subtitle: "resets in 2h 51m",
          resetText: "resets in 2h 51m",
          percent: 13,
          tone: "ok",
          icon: "quota",
          markdown: "",
          meta: [],
          copyLine: "",
        },
        {
          id: "w",
          label: "Weekly · All models",
          subtitle: "47% elapsed · resets Tue 10:30 am",
          resetText: "resets Tue 10:30 am",
          elapsed: 47,
          percent: 63,
          tone: "caution",
          icon: "quota",
          markdown: "",
          meta: [],
          copyLine: "",
        },
        {
          id: "f",
          label: "Weekly · Fable",
          elapsed: 47,
          resetText: "resets Tue 10:30 am",
          percent: 1,
          tone: "ok",
          icon: "quota",
          markdown: "",
          meta: [],
          copyLine: "",
        },
        {
          id: "c",
          label: "Usage credits",
          valueTag: "off",
          percent: null,
          tone: "neutral",
          icon: "note",
          markdown: "",
          meta: [],
          copyLine: "",
        },
        {
          id: "n",
          label: "Saved",
          subtitle: "showing last saved usage — rate limited for secret@example.com",
          percent: null,
          tone: "neutral",
          icon: "saved",
          markdown: "",
          meta: [],
          copyLine: "",
        },
      ],
    },
  ],
};


describe("dashboard", () => {
  it("fits six three-quota accounts within the Raycast viewport", () => {
    const board = layoutBoard({ ...view, accounts: Array.from({ length: 6 }, (_, i) => ({ ...view.accounts[1], key: String(i) })) });
    assert.ok(board.height <= 370);
    for (const op of board.ops) {
      if (op.op === "round") {
        assert.ok(op.x >= 0 && op.x + op.w <= PAGE_W);
        assert.ok(op.y >= 0 && op.y + op.h <= board.height);
      } else {
        const w = textWidth(op.text, op.size, op.weight);
        const left = op.align === "right" ? op.x - w : op.align === "center" ? op.x - w / 2 : op.x;
        assert.ok(left >= 0 && left + w <= PAGE_W + 1, op.text);
      }
    }
  });
  it("shows units, reset times, and the meaning of elapsed markers", () => {
    const text = texts(layoutBoard(view)).join(" ");
    assert.match(text, /13%/);
    assert.match(text, /Resets in 2h 51m/);
    assert.match(text, /Time elapsed|time elapsed/);
    assert.match(text, /Saved/);
    assert.doesNotMatch(text, /secret@example.com|OAuth|HTTP|Offline/);
  });
  it("never presents Antigravity's fabricated local capacity as a cloud limit", () => {
    const account = { ...view.accounts[1], provider: "agy", saved: false, rows: [
      { ...view.accounts[1].rows[0], percent: 100 },
      { ...view.accounts[1].rows[4], label: "Note", subtitle: "Could not load cloud quota. Showing local estimate." },
    ] };
    assert.equal(accountStatus(account)?.unavailable, true);
    const text = texts(layoutBoard({ ...view, accounts: [account] })).join(" ");
    assert.match(text, /Quota unavailable/);
    assert.doesNotMatch(text, /100%/);
  });
  it("extends the board instead of dropping unusually many quotas", () => {
    const account = { ...view.accounts[1], rows: Array.from({ length: 10 }, (_, i) => ({ ...view.accounts[1].rows[0], id: String(i), percent: i + 1 })) };
    const board = layoutBoard({ ...view, accounts: [account] });
    assert.equal(texts(board).filter(t => /^\d+%$/.test(t)).length, 10);
    for (const op of board.ops) if (op.op === "round") assert.ok(op.y + op.h <= board.height);
  });
  it("separates rate limits, sign-in failures, and generic failures", () => {
    assert.equal(accountStatus(view.accounts[0])?.title, "Temporarily rate limited");
    const account = { ...view.accounts[0], rows: [{ ...view.accounts[0].rows[0], subtitle: "Credentials not found" }] };
    assert.equal(accountStatus(account)?.title, "Sign-in needed");
    account.rows[0].subtitle = "Unexpected provider response";
    assert.equal(accountStatus(account)?.title, "Couldn’t load usage");
  });
  it("offers useful empty and failed states", () => {
    assert.match(texts(layoutBoard({ ...view, accounts: [] })).join(" "), /Sign in/);
    assert.match(texts(layoutBoard(undefined, { failure: "missing binary" })).join(" "), /Extension Preferences/);
  });
});


it("describes empty, failed, and stale dashboards accurately to screen readers", () => {
  assert.match(dashboardAlt(), /Loading/);
  assert.match(dashboardAlt({ ...view, accounts: [] }), /No accounts connected/);
  assert.doesNotMatch(dashboardAlt({ ...view, accounts: [] }), /Loading/);
  assert.match(dashboardAlt(undefined, "Binary missing"), /Could not reach tokmeter/);
  assert.match(dashboardAlt(view, "Refresh failed"), /previous data from/);
  assert.match(dashboardAlt(view), /saved snapshot.*2h ago/);
  assert.doesNotMatch(dashboardAlt(view), /Fable/);
});

it("uses the same primary bar width regardless of secondary quotas", () => {
  const one = { ...view.accounts[1], saved: false, rows: [view.accounts[1].rows[1]] };
  const two = { ...one, rows: [view.accounts[1].rows[0], view.accounts[1].rows[1]] };
  const board = layoutBoard({ ...view, accounts: [one, two] });
  const primaryTracks = board.ops.filter(op => op.op === "round" && op.h === 4 && op.color === "#42464A");
  assert.equal(primaryTracks.length, 2);
  assert.ok(primaryTracks.every(op => op.op === "round" && op.w === 204));
});

it("keeps every weekly quota primary and warns about exhausted secondary sessions", () => {
  const base = view.accounts[1];
  const account = { ...base, saved: false, rows: [
    { ...base.rows[0], label: "Session", percent: 100 },
    { ...base.rows[1], label: "Weekly · Gemini", percent: 40 },
    { ...base.rows[1], label: "Weekly · Claude", percent: 60 },
  ] };
  const board = layoutBoard({ ...view, accounts: [account] });
  const numbers = board.ops.filter(op => op.op === "text" && /^\d+%$/.test(op.text));
  const session = numbers.find(op => op.op === "text" && op.text === "100%");
  const weekly = numbers.filter(op => op.op === "text" && op.text !== "100%");
  assert.ok(session?.op === "text" && session.size === 16 && session.color === "#F18E87");
  assert.ok(weekly.every(op => op.op === "text" && op.size === 23));
  assert.equal(weekly[0].x, weekly[1].x);
  assert.ok(weekly[0].y !== weekly[1].y);
});
