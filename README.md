# tokmeter

One CLI for **Claude Code**, **Codex**, and **Grok** usage — session/weekly quotas, multi-account, no cloud.

```
tokmeter · 2026-08-03 15:54

┌ Claude · max · Max 20x
│  Current session     ██░░░░░░░░   18%  resets in 3h 15m
│  Weekly · All models ██████░░░░   61%  resets Thu 7:29 pm
│  Weekly · Fable      █░░░░░░░░░    6%  resets Thu 7:30 pm
│  Usage credits       off
│
┌ Claude · pro
│  Current session     ███░░░░░░░   28%  resets in 4h 45m
│  Weekly · All models █░░░░░░░░░   14%  resets in 18h 35m
│  Usage credits       off
│
┌ Codex · personal · plus
│  Primary (7d)        ██████░░░░   61%  resets Sat 5:19 pm
│  Credits             0
│
┌ Grok · personal
│  Identity            oidc · User
│  Weekly credits      ██████░░░░   60%  resets in 24h 26m
│  Local sessions      142 sessions · ~16.3M tokens (30d)
```

## Install

```bash
# Nix (recommended)
nix run .                          # one-shot
nix profile install .              # install to PATH
direnv allow                       # or: nix develop → live `tokmeter` from src/

# npm
npm install && npm run build && npm start
```

## Usage

```bash
tokmeter                           # plan quotas (concise)
tokmeter stats                     # + local activity (tokens, sessions, models)
tokmeter --provider claude
tokmeter stats --json
tokmeter accounts list
```

### Claude multi-account (meter + switch)

Claude Code only keeps one live login. Snapshot each account, then switch without `/login`:

```bash
tokmeter save-claude max           # while logged into Max
# switch account in Claude Code once, then:
tokmeter save-claude pro

tokmeter use-claude max            # activate Max (keychain swap)
tokmeter use-claude pro            # activate Pro
tokmeter claude status             # which slot is live
```

Aliases: `tokmeter claude switch max`, `tokmeter claude use pro`, `tokmeter claude list`.

Switching writes the captured OAuth blob into Claude Code’s store and keeps live machine-shared fields (`mcpOAuth`, …) so MCP logins survive. On macOS, a running Claude session may take ~30s to notice (keychain cache); new processes pick it up immediately.

### Other multi-account

```bash
tokmeter accounts add --provider codex --label work --codex-home ~/.codex-work
tokmeter accounts add --provider grok  --label work --grok-home  ~/.grok-work
```

Config: `~/.config/tokmeter/config.json` (auto-discovers defaults if missing).

## How it works

| Provider | Plan quotas | Local activity (today) |
|----------|-------------|------------------------|
| **Claude** | OAuth usage API | `~/.claude/projects` jsonl + daily cost cache |
| **Codex** | ChatGPT `wham/usage` | `~/.codex/sessions/**/rollout-*.jsonl` token_count |
| **Grok** | gRPC-web credits | `~/.grok/sessions/**/signals.json` + active sessions |

Local lines (sessions, tokens, models, projects, …) are machine-wide per provider — shown once under the first account of that type. Fetches run in parallel; tokens never printed. Quota APIs are unofficial — treat as advisory.

## Desktop app (macOS)

Glanceable window (donut rings + thick bars) that polls `tokmeter --json` for plan quotas:

```bash
./scripts/tokmeter-hud
```

Auto-refresh (default 30s), **⌘R** to refresh, optional **Keep on Top**. See [`macos/TokmeterHUD/README.md`](macos/TokmeterHUD/README.md).

## License

MIT
