# TokmeterHUD

Native macOS menu bar + floating panel UI for [`tokmeter`](../../README.md).

- Lives in the menu bar (no Dock icon)
- Compact dark panel (~320px) with progress bars for Claude / Codex / Grok
- Auto-refresh via `tokmeter --json` (default 30s; 15 / 30 / 60 / 120)
- **Keep on Top** (floating window level + all Spaces)
- Manual refresh, last-updated time, per-account errors
- Zero external SPM dependencies · macOS 13+

## Requirements

- macOS 13 Ventura or later
- Swift 5.9+ toolchain (Xcode or Command Line Tools)
- `tokmeter` on `PATH`, or set `TOKMETER_BIN`

## Build

```bash
cd macos/TokmeterHUD
swift build -c release
```

If you are inside a **nix / direnv** shell and `swift build` fails with `SwiftShims` / SDK mismatch errors, point at the Apple Command Line Tools SDK:

```bash
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
export PATH="/Library/Developer/CommandLineTools/usr/bin:$PATH"
swift build -c release
```

`./scripts/tokmeter-hud` sets these automatically when needed.

Debug:

```bash
swift build
swift run TokmeterHUD
```

Release binary path:

```
.build/release/TokmeterHUD
```

## Run via helper script

From the repo root:

```bash
./scripts/tokmeter-hud
```

Builds release if needed, then launches the app.

## Install (optional)

Copy the binary somewhere on your `PATH`, or wire it into a LaunchAgent:

```bash
cp .build/release/TokmeterHUD ~/.local/bin/TokmeterHUD
```

Launch at login (example LaunchAgent):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.tokmeter.hud</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.local/bin/TokmeterHUD</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

## Finding `tokmeter`

Resolution order:

1. `TOKMETER_BIN` env var
2. `$HOME/.nix-profile/bin/tokmeter`
3. `/run/current-system/sw/bin/tokmeter`
4. `~/.local/bin`, Homebrew, common monorepo `result/bin` paths
5. `$PATH` / `which tokmeter`

```bash
export TOKMETER_BIN=/path/to/tokmeter
./scripts/tokmeter-hud
```

## UI

Click the menu bar gauge icon to open the panel.

| Control | Action |
|--------|--------|
| ↻ | Refresh now |
| time | Last successful update |
| ⋮ | Keep on Top · refresh interval · Quit |

Colors: green &lt;50% · yellow &lt;80% · red ≥80%. Windows without a percent (credits off, identity, local sessions) show text instead of a bar. Emails are never displayed.

Preferences (Keep on Top, interval) persist in `UserDefaults`.
