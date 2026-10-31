# tokmeter

One CLI for **Claude Code**, **Codex**, **Grok**, and **Cursor** usage — session/weekly quotas, multi-account, no cloud.

```
tokmeter · 2026-08-03 15:54

┌ Claude · max · Max 20x
│  Current session     ██░░░░░░░░   18%  resets in 3h 15m
│  Weekly · All models ██████░░░░   61% used · 55% elapsed  resets Thu 7:29 pm
│  Weekly · Fable      █░░░░░░░░░    6% used · 55% elapsed  resets Thu 7:30 pm
│  Usage credits       off
│
┌ Claude · pro
│  Current session     ███░░░░░░░   28%  resets in 4h 45m
│  Weekly · All models █░░░░░░░░░   14% used · 89% elapsed  resets in 18h 35m
│  Usage credits       off
│
┌ Codex · personal · plus
│  Primary (7d)        ██████░░░░   61% used · 35% elapsed  resets Sat 5:19 pm
│  Credits             0
│
┌ Grok · personal
│  Identity            oidc · User
│  Weekly credits      ██████░░░░   60% used · 85% elapsed  resets in 24h 26m
│  Local sessions      142 sessions · ~16.3M tokens (30d)
│
┌ Cursor · personal · Pro
│  Included usage      █░░░░░░░░░   15%  $2.97 / $20  resets Tue 10:30 pm
│  On-demand spend     $0 / $20
```

Weekly quota rows show how much of their own quota week has elapsed, calculated
from each row's reset time and full period (seven days unless the provider reports
an exact period). Compare this with the usage percentage to gauge your pace.

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

### Discovery

A provider only appears once its CLI is **installed and signed in** — no error rows or
placeholders for tools you don't have. Cursor, for example, needs a `cursor-agent`
binary on `PATH` *and* a login (`~/.cursor` alone doesn't count; the Cursor IDE creates
it too). The credential probe never reads the secret, so discovery can't trigger a
keychain prompt.

Providers missing from an existing `config.json` are backfilled on each run, so
installing a new agent doesn't require `accounts add`. `accounts remove` on a
provider's last account records it under `dismissed` and stops that backfill.

## How it works

| Provider | Plan quotas | Local activity (today) |
|----------|-------------|------------------------|
| **Claude** | OAuth usage API | `~/.claude/projects` jsonl + daily cost cache |
| **Codex** | ChatGPT `wham/usage` | `~/.codex/sessions/**/rollout-*.jsonl` token_count |
| **Grok** | gRPC-web credits | `~/.grok/sessions/**/signals.json` + active sessions |
| **Cursor** | Connect-RPC `DashboardService` | `~/.cursor/chats/**/meta.json` + `GetAggregatedUsageEvents` |

Local lines (sessions, tokens, models, projects, …) are machine-wide per provider — shown once under the first account of that type. Fetches run in parallel; tokens never printed. Quota APIs are unofficial — treat as advisory.

**Token refresh.** Claude, Codex, and Grok all self-heal an expired access token
rather than telling you to go log in again: tokmeter refreshes proactively when the
stored expiry has passed, and reactively when a quota call comes back unauthorized
(for Grok that's a `200` with an empty body, not a `401`). Rotated credentials are
written back to the CLI's own auth file — `~/.codex/auth.json`, `~/.grok/auth.json`,
the Claude keychain entry — so the provider CLI stays logged in too. Writes are
atomic and taken under an advisory lock (Grok's own `auth.json.lock` convention),
and every other field in those files is preserved verbatim. A rejected refresh
backs off for 10 minutes and surfaces a `run <cli> login` hint instead of retrying
on every render.

**Cursor notes.** Auth is the `cursor-access-token` keychain entry that `cursor-agent
login` writes (`CURSOR_API_KEY` overrides). Cursor meters a monthly *dollar* pool
rather than a rolling token window, so the bar is spend-based and "resets" is the
billing cycle end. Its own `totalPercentUsed` / `displayMessage` fields are computed
against different internal denominators and disagree with each other — tokmeter derives
the bar from `totalSpend / limit` (the set `remaining` agrees with) and prints the
dollars alongside; Cursor's raw fields are preserved under `--json`. Cursor stores no
token counts on disk (transcripts are encrypted), so `stats` token/cost figures come
from its usage API and the `local` block is marked `source: "mixed"`.

## Desktop app (macOS)

Glanceable window (donut rings + thick bars) that polls `tokmeter --json` for plan quotas:

```bash
./scripts/tokmeter-hud
```

Auto-refresh (default 30s), **⌘R** to refresh, optional **Keep on Top**. See [`macos/TokmeterHUD/README.md`](macos/TokmeterHUD/README.md).

## License

MIT
