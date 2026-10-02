# Contributing to tokmeter

tokmeter is a single CLI that shows plan quotas and local usage for Claude Code, Codex, Grok, Cursor, and Antigravity.
It reads each tool's own login (keychain / auth files), calls the provider's usage API, and renders session/weekly limits side by side — no cloud, multi-account.
`tokmeter stats` adds machine-local activity (sessions, tokens, models) scanned from each tool's on-disk logs; `--json` feeds the macOS HUD.

**This repo is public — never commit secrets (tokens, auth files, keychain dumps, API responses) or personal info (emails, account IDs, local paths, usage data).**
