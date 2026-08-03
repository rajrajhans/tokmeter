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
npm install && npm run build
npm start                          # or: npx tsx src/index.ts
```

## Usage

```bash
tokmeter                           # all accounts
tokmeter --provider claude
tokmeter --json
tokmeter accounts list
```

### Multiple Claude accounts

Claude Code only keeps one live login. Snapshot each:

```bash
tokmeter save-claude max           # while logged into Max
# switch account in Claude Code
tokmeter save-claude pro           # while logged into Pro
tokmeter
```

```bash
tokmeter save-claude list          # ~/.config/tokmeter/claude-creds/
tokmeter claude save work          # alias
```

### Other multi-account

```bash
tokmeter accounts add --provider codex --label work --codex-home ~/.codex-work
tokmeter accounts add --provider grok  --label work --grok-home  ~/.grok-work
tokmeter accounts remove codex-work
```

Config: `~/.config/tokmeter/config.json` (auto-discovers defaults if missing).

## How it works

| Provider | Credentials | Usage |
|----------|-------------|--------|
| **Claude** | Keychain / captured JSON | `GET api.anthropic.com/api/oauth/usage` |
| **Codex** | `~/.codex/auth.json` | `GET chatgpt.com/backend-api/wham/usage` |
| **Grok** | `~/.grok/auth.json` | gRPC-web billing + local session signals |

Fetches run in parallel; one failure doesn’t hide the rest. Tokens never printed. Quota APIs are unofficial — treat as advisory.

## License

MIT
