# tokmeter

Unified terminal usage meter for **Claude Code**, **OpenAI Codex**, and **Grok** — multi-account aware, zero runtime dependencies, TypeScript.

```
tokmeter · 2026-08-03 15:30

┌ Claude · personal · Max 20x
│  Current session     ████░░░░░░  10%   resets in 4h 16m
│  Weekly · All models ██████░░░░  60%   resets Thu 7:30 PM
│  Weekly · Fable      █░░░░░░░░░   6%   resets Thu 7:30 PM
│  Usage credits       off
│
┌ Codex · personal · plus · mail@...
│  Primary (7d)        ██████░░░░  61%   resets in 5d 2h
│  Credits             0
│
┌ Grok · personal · eonicrj@...
│  Identity            oidc · User
│  Local sessions      12 sessions · ~45k tokens (30d)
│  Live billing        unavailable (...)
```

## Why

Each coding agent stores credentials and exposes usage differently:

| Tool   | Auth store | Usage source |
|--------|------------|--------------|
| Claude Code | macOS Keychain `Claude Code-credentials` (or `~/.claude/.credentials.json`) | Official OAuth usage API |
| Codex  | `~/.codex/auth.json` | ChatGPT `wham/usage` backend |
| Grok   | `~/.grok/auth.json` | Identity always; live billing best-effort; local session estimates |

tokmeter normalizes these into one view so you can see rate-limit headroom before starting work.

## Install / run (Nix flake)

### Dev (live sources against this checkout)

```bash
cd tokmeter
direnv allow          # or: nix develop
# if you still see /nix/store/... EACCES:  direnv reload

tokmeter              # rebuilds src/ via esbuild → runs it (no npm)
tokmeter --json
tokmeter accounts list
```

The dev shell puts a `tokmeter` wrapper on `PATH` that:

1. Finds your **writable git checkout** (never `/nix/store/...-source`)
2. Bundles `src/` with **esbuild** into `~/.cache/tokmeter-dev/`
3. Runs that bundle with node

**No `npm install` is required** for the flake/dev path. (npm is only if you choose to use `npx tsx` outside Nix.)

### Release binary from this flake

```bash
# one-shot, no install
nix run .

# install into your profile (then `tokmeter` anywhere)
nix profile install .

# build store path only
nix build .
./result/bin/tokmeter
```

### Without Nix

```bash
npm install
npx tsx src/index.ts          # dev
npm run build && npm start    # compiled
```

## Usage

```bash
tokmeter                              # all discovered accounts
tokmeter usage --provider claude
tokmeter usage --json
tokmeter accounts list
tokmeter accounts add --provider codex --label work --codex-home ~/.codex-work
tokmeter accounts add --provider claude --label work \
  --credentials-path ~/.claude-work/.credentials.json
tokmeter accounts add --provider grok --label work --grok-home ~/.grok-work
tokmeter accounts remove codex-work
tokmeter --help
```

## Multi-account config

Path: `~/.config/tokmeter/config.json`

If missing, tokmeter **auto-discovers** one default account per provider from standard locations.

```json
{
  "accounts": [
    {
      "id": "claude-default",
      "provider": "claude",
      "label": "personal",
      "source": "auto"
    },
    {
      "id": "codex-work",
      "provider": "codex",
      "label": "work",
      "source": "auth_file",
      "codexHome": "/Users/you/.codex-work"
    }
  ]
}
```

Optional fields per account:

- `credentialsPath` — Claude credentials JSON
- `keychainService` — Claude keychain service name (default `Claude Code-credentials`)
- `codexHome` — directory containing Codex `auth.json`
- `grokHome` — directory containing Grok `auth.json`
- `source` — `auto` | `keychain` | `credentials_file` | `auth_file`

## Architecture

```
src/
  index.ts              CLI entry / arg parsing
  types.ts              AccountConfig, ProviderSnapshot, UsageWindow
  config.ts             load/save ~/.config/tokmeter/config.json + discovery
  display.ts            human + JSON renderers
  providers/
    claude.ts           keychain/file creds, OAuth refresh, usage API
    codex.ts            auth.json → wham/usage
    grok.ts             auth.json identity + local signals + optional billing RPC
  utils/
    time.ts progress.ts fs.ts ansi.ts
```

Each provider returns a `ProviderSnapshot`. Failures are per-account (`ok: false`); others still render. Fetches run in parallel via `Promise.allSettled`.

### Claude

1. Read credentials from keychain (macOS) or file.
2. If `expiresAt` is near/past, `POST` refresh with public Claude Code `client_id`, write rotated tokens back to the same store.
3. `GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`.
4. Map `limits[]` (session / weekly_all / weekly_scoped) and credits/spend into windows.

### Codex

1. Read `~/.codex/auth.json` (`tokens.access_token`, `tokens.account_id`).
2. `GET https://chatgpt.com/backend-api/wham/usage` with `ChatGPT-Account-Id`.
3. Map primary/secondary rate windows + credits.

### Grok

1. Always show identity from `auth.json` (email, principal, auth mode). **Never print tokens.**
2. Live credits via gRPC-web `POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` (empty protobuf frame + OIDC bearer) — same path CodexBar uses. Parses credit % + period start/end from the response.
3. Always also scan `~/.grok/sessions/**/signals.json` (last 30 days) for local session/token activity (`local_estimate`).
4. If billing fails (expired token → `grok login`), identity + local stats still show.

## Security

- Tokens are only used in outbound `Authorization` headers.
- stdout/stderr never include access tokens, refresh tokens, or keychain blobs.
- Config and credential write-backs use mode `0600` where applicable.
- Prefer reading the same stores the official CLIs use rather than asking you to paste secrets.

## Research notes (OSS landscape)

We surveyed existing open-source tools before building. Two different problems dominate the space:

| Problem | What users want | Best existing tools |
|---------|-----------------|---------------------|
| **Historical token/cost analytics** | Daily/weekly spend from local JSONL | [ccusage](https://github.com/ccusage/ccusage) (~18k★), [tokscale](https://github.com/junhoyeo/tokscale) |
| **Live subscription quota** | Session % / weekly % / reset countdown | [CodexBar](https://github.com/steipete/CodexBar) (~20k★), [claude-monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor), [wakamex/ccusage](https://github.com/wakamex/ccusage) |

### What we borrowed

| Source | What we took |
|--------|----------------|
| **wakamex/ccusage** + **CodexBar Claude docs** | `GET api.anthropic.com/api/oauth/usage` + `anthropic-beta: oauth-2025-04-20`, `limits[]` parsing (session / weekly_all / weekly_scoped → Fable), OAuth refresh with Claude Code `client_id` |
| **CodexBar codex docs** + community gists | `GET chatgpt.com/backend-api/wham/usage` with Codex `auth.json` tokens + `ChatGPT-Account-Id` |
| **CodexBar grok docs** | `~/.grok/auth.json` identity, `grok agent stdio` → `x.ai/billing` (often missing), local `signals.json` fallback |
| **claude-monitor** | Provenance labels (`official` / `local_estimate` / `partial`); never present estimates as official plan quota |
| **caut / CodexBar** | Multi-account registry, provider trait pattern, partial failure isolation |

### What we improved / scoped differently

- **Focused** on the three tools people juggle most (Claude Code + Codex + Grok), not 30–60 providers.
- **CLI-first, cross-platform** — no macOS menu-bar requirement.
- **Multi-account as a core feature** via `~/.config/tokmeter/config.json` (not an afterthought).
- **Quota-first** (what the UIs show: % used + resets), not only historical cost from logs.
- **Zero runtime deps**, TypeScript, Nix flake for system tooling.

### Provider data sources (cheat sheet)

```
Claude  keychain "Claude Code-credentials" | ~/.claude/.credentials.json
        GET https://api.anthropic.com/api/oauth/usage
        Header: anthropic-beta: oauth-2025-04-20

Codex   ~/.codex/auth.json  (or $CODEX_HOME)
        GET https://chatgpt.com/backend-api/wham/usage

Grok    ~/.grok/auth.json  (or $GROK_HOME)
        identity always · billing via grok agent stdio (best-effort)
        local: ~/.grok/sessions/**/signals.json
```

tokmeter’s niche: **one CLI, three providers, multi-account, official quotas when available, graceful local fallbacks, agent-friendly `--json`**.

## Development

```bash
npm run dev          # tsx src/index.ts
npm run typecheck
npm run build
```

Node **20+** (flake pins **22**). Runtime dependency count: **0** (only `typescript` / `tsx` / `@types/node` as devDependencies).

## Caveats

- Claude keychain write-back requires macOS `security` and permission to update the item; on failure, the refreshed token is used for the current process only and a warning is shown.
- Codex tokens expire; re-login with the Codex CLI if usage returns HTTP 401.
- Grok local token totals are rough (per-session context peaks), not billed units.
- These usage APIs are unofficial and may change; treat output as advisory.

## License

MIT
