# TokmeterHUD

Normal macOS **window** app for [`tokmeter`](../../README.md) — move it, resize it, keep it open while you work.

- Standard title bar (close / minimize / resize)
- Appears in the Dock and Cmd-Tab
- Auto-refresh via `tokmeter --json` (default 30s)
- Optional **Keep on Top**
- Compact dark UI for Claude / Codex / Grok usage
- Zero external SPM dependencies · macOS 13+

## Run

```bash
# from repo root
./scripts/tokmeter-hud
```

Or:

```bash
cd macos/TokmeterHUD
export DEVELOPER_DIR=/Library/Developer/CommandLineTools   # if inside nix
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
swift build -c release
.build/release/TokmeterHUD
```

Requires `tokmeter` on `PATH`, or `TOKMETER_BIN=/path/to/tokmeter`.

## Controls

| Control | Action |
|--------|--------|
| **⌘R** / ↻ | Refresh now |
| time | Last successful update |
| **⋯ → Keep on Top** | Float above other windows |
| **⋯ → Refresh Interval** | 15 / 30 / 60 / 120s |
| window chrome | Move, resize, minimize, close (quits app) |

## Install (optional)

```bash
cp .build/release/TokmeterHUD ~/.local/bin/TokmeterHUD
# open from Terminal, Spotlight (if on PATH), or add a Login Item
```

## Finding `tokmeter`

1. `TOKMETER_BIN`
2. `~/.nix-profile/bin/tokmeter`
3. Homebrew / `~/.local/bin` / `$PATH`
