# tokmeter for Raycast

Plan quotas for Claude Code, Codex, Grok, Cursor, and Antigravity. Reads the local `tokmeter` CLI; no separate provider login is required.

## Install and use

Install [tokmeter](../README.md#install) and Raycast, then run:

```bash
cd raycast
npm ci
npm run dev
```

Once the build finishes, press **Ctrl+C**. The extension stays installed and works without a running terminal or dev server. Open Raycast and search for **tokmeter** or **Usage**. This is Raycast's documented [local extension workflow](https://developers.raycast.com/basics/create-your-first-extension#use-your-extension).

- **⌘R** refreshes usage.
- **⌘D** opens searchable account details, credits, activity, and diagnostics.
- **⌘K** opens actions, including Copy Summary and Extension Preferences.

Set an alias or hotkey for Usage in Raycast Settings → Extensions for quicker access. To load source changes later, run `npm run dev` again and stop it after the build finishes.

## Dashboard

Weekly quotas use equal-width primary bars; sessions appear smaller. Fable is omitted. The tick marks elapsed time within the quota window. Colors indicate usage: green below 50%, amber below 80%, red from 80%.

Saved snapshots show their age. Connection failures display recovery guidance; full diagnostics are in Account Details. Antigravity's local activity estimate is not shown as a cloud quota. Refresh preserves the current board until new data is ready.

## Preferences

| Preference | Default | Purpose |
| --- | --- | --- |
| tokmeter Path | Automatic | Override the CLI binary path |
| Local Activity | Off | Include sessions and tokens in Account Details |

Binary discovery checks `TOKMETER_BIN`, standard Nix, Homebrew, and local-bin locations, then `PATH`. If discovery fails, set **tokmeter Path** to the result of `command -v tokmeter`. The first refresh may prompt for keychain access through the CLI.

## Development

From the repository root:

```bash
npm run typecheck --prefix raycast
npm run build --prefix raycast
npx tsx --test raycast/src/lib/*.test.ts
npx tsx raycast/scripts/preview.ts
```

The preview script renders synthetic dashboard states in both themes to a temporary directory using the extension's AppKit painter. Build output and dependencies are ignored by Git.
