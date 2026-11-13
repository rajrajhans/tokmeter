import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WEEK_SECONDS,
  parsePayload,
  present,
  accountMarkdown,
  weeklyFirst,
  progressBar,
  redact,
  usageTone,
  windowElapsedPercent,
} from "./model";
import { interpretRun, resolveBinary } from "./tokmeter";

const now = Date.parse("2026-08-03T12:00:00Z");
const jwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

function payload() {
  return {
    fetchedAt: "2026-08-03T12:00:00.000Z",
    accounts: [
      {
        provider: "claude",
        accountId: "acct_SHOULD_NOT_LEAK",
        label: "max",
        ok: true,
        plan: "Ultra",
        email: "secret@example.com",
        provenance: "official",
        windows: [
          {
            id: "session",
            label: "Current session",
            usedPercent: 18,
            resetsAt: new Date(now + (3 * 3600 + 15 * 60) * 1000).toISOString(),
            resetsInSeconds: 3 * 3600 + 15 * 60,
          },
          {
            id: "weekly",
            label: "Weekly · All models",
            usedPercent: 61,
            resetsAt: new Date(
              now + (18 * 3600 + 30 * 60) * 1000,
            ).toISOString(),
            resetsInSeconds: 18 * 3600 + 30 * 60,
            windowSeconds: WEEK_SECONDS,
          },
          {
            id: "weekly:fable",
            label: "Weekly · Fable",
            usedPercent: 6,
            resetsInSeconds: 18 * 3600 + 30 * 60,
            windowSeconds: WEEK_SECONDS,
          },
          {
            id: "credits",
            label: "Usage credits",
            usedPercent: null,
            extra: { status: "off" },
          },
          {
            id: "identity",
            label: "Identity",
            extra: { mode: "oidc", principal: "User" },
          },
        ],
      },
      {
        provider: "claude",
        accountId: "acct_ALSO_HIDDEN",
        label: "pro",
        ok: true,
        plan: "Pro",
        email: "other@example.com",
        windows: [
          {
            id: "session",
            label: "Current session",
            usedPercent: 80,
            resetsInSeconds: 90,
          },
        ],
      },
      {
        provider: "cursor",
        label: "personal",
        ok: true,
        plan: "Pro",
        provenance: "official",
        windows: [
          {
            id: "included",
            label: "Included usage",
            usedPercent: 14.6,
            resetsInSeconds: 5 * 24 * 3600,
            extra: { usedDollars: 2.97, limitDollars: 20 },
          },
          {
            id: "spend",
            label: "On-demand spend",
            usedPercent: null,
            extra: { status: "off" },
          },
        ],
      },
      {
        provider: "codex",
        label: "personal",
        ok: true,
        plan: "plus",
        windows: [
          {
            id: "credits",
            label: "Credits",
            usedPercent: null,
            extra: { balance: 0 },
          },
          {
            id: "reset-credits",
            label: "Rate-limit resets",
            usedPercent: null,
            extra: { available: 2 },
          },
        ],
      },
      {
        provider: "grok",
        label: "personal",
        ok: false,
        error: `auth failed for secret@example.com ${jwt}`,
        windows: [],
      },
      {
        provider: "agy",
        label: "personal",
        ok: true,
        plan: "Cloud",
        extras: {
          warning: "Could not load cloud quota",
          team_id: "team_secret",
        },
        windows: [
          {
            id: "quota",
            label: "Weekly · Gemini",
            usedPercent: 40,
            windowSeconds: WEEK_SECONDS,
            resetsInSeconds: WEEK_SECONDS / 2,
          },
        ],
        local: {
          lines: [{ label: "Today", value: "3 sessions" }],
          raw: { secret: "nope" },
        },
      },
    ],
  };
}

describe("usage view", () => {
  const view = present(payload(), now);
  const claude = view.accounts[0];
  const weekly = claude?.rows.find(
    (row) => row.label === "Weekly · All models",
  );

  it("names accounts the way the CLI does and drops identity", () => {
    assert.equal(claude?.title, "Claude · max · Ultra");
    assert.equal(view.accounts[2]?.title, "Cursor · personal · Pro");
    const blob = JSON.stringify(view);
    assert.equal(blob.includes("secret@example.com"), false);
    assert.equal(blob.includes("acct_SHOULD_NOT_LEAK"), false);
    assert.equal(blob.includes("acct_ALSO_HIDDEN"), false);
    assert.equal(blob.includes(jwt), false);
    assert.equal(blob.includes("team_secret"), false);
    assert.equal(
      claude?.rows.find((row) => row.label === "Identity")?.valueTag,
      "oidc · User",
    );
    assert.equal(
      claude?.rows.find((row) => row.label === "Usage credits")?.valueTag,
      "off",
    );
    assert.equal(view.accounts[2]?.rows[1]?.label, "On-demand spend");
    assert.equal(view.accounts[2]?.rows[1]?.valueTag, "off");
  });

  it("colors thresholds the same way as the CLI", () => {
    assert.equal(usageTone(49), "ok");
    assert.equal(usageTone(50), "caution");
    assert.equal(usageTone(79.9), "caution");
    assert.equal(usageTone(80), "hot");
    assert.equal(weekly?.tone, "caution");
    assert.equal(view.accounts[1]?.rows[0]?.tone, "hot");
  });

  it("shows weekly pace and a short reset", () => {
    assert.ok(weekly);
    assert.equal(weekly.subtitle, "89% elapsed · resets in 18h 30m");
    assert.equal(weekly.resetShort, "18h 30m");
    assert.equal(weekly.resetText, "resets in 18h 30m");
    assert.equal(
      weekly.meta.find((item) => item.title === "Pace")?.text,
      "Slower than this window",
    );
    assert.match(weekly.markdown, /61%/);
    assert.match(weekly.markdown, /Slower than this window/);
  });

  it("keeps session resets under two days relative", () => {
    const session = claude?.rows[0];
    assert.equal(session?.label, "Current session");
    assert.equal(session?.resetText, "resets in 3h 15m");
    assert.equal(session?.subtitle, "resets in 3h 15m");
  });

  it("spells out cursor dollars and hides a spent-off cap", () => {
    const included = view.accounts[2]?.rows[0];
    assert.equal(included?.subtitle, "$2.97 / $20 · resets in 5d");
    assert.equal(Math.round(included?.percent ?? -1), 15);
    assert.equal(view.accounts[2]?.rows.length, 2);
  });

  it("shows a zero credit balance the way the CLI does", () => {
    const codex = view.accounts[3];
    assert.equal(codex?.rows.length, 2);
    assert.equal(codex?.rows[0]?.label, "Credits");
    assert.equal(codex?.rows[0]?.valueTag, "0");
    assert.equal(codex?.rows[1]?.label, "Rate-limit resets");
    assert.equal(codex?.rows[1]?.valueTag, "2");
  });

  it("redacts a failed account", () => {
    const grok = view.accounts[4];
    assert.equal(grok?.rows[0]?.label, "Couldn't load");
    assert.match(grok?.rows[0]?.subtitle ?? "", /auth failed/);
    assert.doesNotMatch(grok?.rows[0]?.subtitle ?? "", /@/);
    assert.doesNotMatch(grok?.rows[0]?.subtitle ?? "", /eyJ/);
  });

  it("shows a warning, a quota, and local activity", () => {
    const agy = view.accounts[5];
    assert.equal(agy?.title, "Antigravity · personal · Cloud");
    assert.equal(agy?.subtitle, undefined);
    assert.equal(agy?.rows[0]?.label, "Weekly · Gemini");
    assert.equal(agy?.rows[1]?.label, "Today");
    assert.equal(agy?.rows[1]?.subtitle, "3 sessions");
    assert.equal(agy?.rows[2]?.label, "Note");
    assert.equal(agy?.rows[2]?.subtitle, "Could not load cloud quota");
    assert.match(agy?.rows[1]?.markdown ?? "", /Not a plan quota/);
  });

  it("lists every provider on the one sheet", () => {
    assert.deepEqual(
      view.accounts.map((account) => account.provider),
      ["claude", "claude", "cursor", "codex", "grok", "agy"],
    );
    assert.match(view.summary, /^tokmeter · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(view.summary, /Weekly · All models/);
    assert.match(view.summary, /Usage credits/);
    assert.doesNotMatch(view.summary, /secret@example.com/);
  });

  it("shows the last saved snapshot the way the CLI does", () => {
    const savedAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const view = present(
      {
        fetchedAt: "2026-08-03T12:00:00.000Z",
        accounts: [
          {
            provider: "claude",
            label: "primary",
            ok: true,
            provenance: "partial",
            source: "keychain+stale",
            fetchedAt: savedAt,
            extras: {
              warning: "showing last saved usage — rate limited",
            },
            windows: [
              {
                id: "session",
                label: "Current session",
                usedPercent: 10,
                resetsInSeconds: 3600,
              },
            ],
          },
        ],
      },
      now,
    );
    const account = view.accounts[0];
    assert.match(account?.subtitle ?? "", /^updated .+ · 2h ago$/);
    assert.equal(account?.rows[0]?.label, "Current session");
    assert.equal(account?.rows[1]?.label, "Saved");
    assert.match(account?.rows[1]?.subtitle ?? "", /last saved usage/);
  });
});

describe("pace math", () => {
  it("measures how much of the window has elapsed", () => {
    const elapsed = windowElapsedPercent(
      WEEK_SECONDS,
      null,
      WEEK_SECONDS / 2,
      now,
    );
    assert.equal(elapsed, 50);
  });

  it("draws a clamped bar", () => {
    assert.equal(progressBar(0, 10), "░░░░░░░░░░");
    assert.equal(progressBar(50, 10), "█████░░░░░");
    assert.equal(progressBar(100, 10), "██████████");
    assert.equal(progressBar(140, 4), "████");
  });
});

describe("payload safety", () => {
  it("strips identity before the value can be cached", () => {
    const raw = JSON.stringify(payload());
    const parsed = parsePayload(raw);
    const blob = JSON.stringify(parsed);
    assert.equal(blob.includes("secret@example.com"), false);
    assert.equal(blob.includes("acct_SHOULD_NOT_LEAK"), false);
    assert.equal(blob.includes("team_secret"), false);
    assert.equal(blob.includes('"raw"'), false);
    assert.match(blob, /Weekly · All models/);
    assert.match(blob, /Could not load cloud quota/);
  });

  it("keeps a saved timestamp and drops the source string", () => {
    const parsed = parsePayload(
      JSON.stringify({
        fetchedAt: "2026-08-03T12:00:00.000Z",
        accounts: [
          {
            provider: "claude",
            accountId: "acct_SHOULD_NOT_LEAK",
            label: "primary",
            ok: true,
            source: "keychain+stale",
            provenance: "partial",
            fetchedAt: "2026-08-03T10:00:00.000Z",
            email: "secret@example.com",
            windows: [],
            extras: { warning: "showing last saved usage — slow" },
          },
        ],
      }),
    );
    const blob = JSON.stringify(parsed);
    assert.equal(blob.includes("acct_SHOULD_NOT_LEAK"), false);
    assert.equal(blob.includes("secret@example.com"), false);
    assert.equal(blob.includes("keychain+stale"), false);
    assert.match(blob, /2026-08-03T10:00:00.000Z/);
    assert.match(blob, /"saved":true/);
  });

  it("accepts a partial failure exit when stdout is JSON", () => {
    const outcome = interpretRun({
      stdout: JSON.stringify({
        fetchedAt: "2026-08-03T12:00:00.000Z",
        accounts: [],
      }),
      stderr: "one account failed",
      code: 2,
      killed: false,
      maxBuffer: false,
      missing: false,
    });
    assert.equal(outcome.ok, true);
  });

  it("redacts secrets in stderr and prefers a timeout over a partial body", () => {
    const leaked = interpretRun({
      stdout: "not json",
      stderr: `\u001b[31mfailed for secret@example.com ${jwt}\u001b[0m`,
      code: 1,
      killed: false,
      maxBuffer: false,
      missing: false,
    });
    assert.equal(leaked.ok, false);
    if (!leaked.ok) {
      assert.match(leaked.message, /failed/);
      assert.doesNotMatch(leaked.message, /@/);
      assert.doesNotMatch(leaked.message, /eyJ/);
    }

    const timedOut = interpretRun({
      stdout: "{",
      stderr: "",
      code: 1,
      killed: true,
      maxBuffer: false,
      missing: false,
    });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) assert.match(timedOut.message, /timed out/);
  });

  it("redacts standalone text", () => {
    assert.equal(redact(`see ${jwt} and a@b.co`), "see … and …");
  });
});

describe("binary resolution", () => {
  const home = "/Users/someone";
  const nix = `${home}/.nix-profile/bin/tokmeter`;

  it("uses an explicit path and does not search past a missing one", () => {
    const found = resolveBinary({
      override: "/opt/tokmeter",
      env: { TOKMETER_BIN: nix },
      home,
      exists: (path) => path === "/opt/tokmeter",
    });
    assert.deepEqual(found, { ok: true, path: "/opt/tokmeter" });

    const missing = resolveBinary({
      override: "/opt/missing",
      env: { TOKMETER_BIN: nix },
      home,
      exists: (path) => path === nix,
    });
    assert.equal(missing.ok, false);
  });

  it("prefers TOKMETER_BIN, then the usual installs, then PATH", () => {
    const fromEnv = resolveBinary({
      env: { TOKMETER_BIN: "/custom/tokmeter", PATH: "/usr/bin" },
      home,
      exists: (path) => path === "/custom/tokmeter",
    });
    assert.deepEqual(fromEnv, { ok: true, path: "/custom/tokmeter" });

    const fromNix = resolveBinary({
      env: { PATH: "/usr/bin" },
      home,
      exists: (path) => path === nix,
    });
    assert.deepEqual(fromNix, { ok: true, path: nix });

    const fromPath = resolveBinary({
      env: { PATH: "/opt/bin" },
      home,
      exists: (path) => path === "/opt/bin/tokmeter",
    });
    assert.deepEqual(fromPath, { ok: true, path: "/opt/bin/tokmeter" });
  });

  it("says when nothing is installed", () => {
    const missing = resolveBinary({
      env: { PATH: "/usr/bin" },
      home,
      exists: () => false,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.message, /isn't installed/);
  });
});

it("does not copy an invented Antigravity capacity into the UI or summary", () => {
  const view = present({
    fetchedAt: new Date(now).toISOString(),
    accounts: [{
      provider: "agy", label: "personal", ok: true,
      windows: [{ id: "activity", label: "Daily capacity", usedPercent: 100 }],
      extras: { warning: "Could not load cloud quota. Showing local estimate." },
    }],
  }, now);
  assert.ok(view.accounts[0].rows.every(row => row.percent === null));
  assert.doesNotMatch(view.summary, /100%|Daily capacity/);
  assert.match(view.summary, /Could not load cloud quota/);
});

it("includes quota and activity labels in native account search", () => {
  const view = present(payload(), now);
  assert.ok(view.accounts[0].keywords.includes("Weekly · All models"));
  assert.ok(view.accounts[5].keywords.includes("Today"));
});


it("prioritizes weekly comparison and removes Fable from all Raycast content", () => {
  const view = present(payload(), now);
  const account = view.accounts[0];
  assert.ok(account.rows.every(row => !/fable/i.test(row.label)));
  assert.doesNotMatch(view.summary, /fable/i);
  assert.equal(weeklyFirst(account.rows)[0].label, "Weekly · All models");
  const detail = accountMarkdown(account);
  assert.ok(detail.indexOf("Weekly · All models") < detail.indexOf("Current session"));
  assert.match(detail, /61% used/);
  assert.match(detail, /[█░]{20}/);
  assert.doesNotMatch(detail, /\x60\x60\x60|Fable/);
});
