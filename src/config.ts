import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { AccountConfig, ProviderName, TokmeterConfig } from "./types.js";
import {
  configPath,
  expandHome,
  pathExists,
  readJsonFile,
  writeJsonFile,
} from "./utils/fs.js";

const execFileAsync = promisify(execFile);

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CREDENTIALS = join(homedir(), ".claude", ".credentials.json");
const DEFAULT_CODEX_HOME = join(homedir(), ".codex");
const DEFAULT_GROK_HOME = join(homedir(), ".grok");
const DEFAULT_CURSOR_HOME = join(homedir(), ".cursor");
const CURSOR_KEYCHAIN_SERVICE = "cursor-access-token";
const CURSOR_KEYCHAIN_ACCOUNT = "cursor-user";

export function defaultClaudeKeychainService(): string {
  return CLAUDE_KEYCHAIN_SERVICE;
}

export function defaultClaudeCredentialsPath(): string {
  return CLAUDE_CREDENTIALS;
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME
    ? expandHome(process.env.CODEX_HOME)
    : DEFAULT_CODEX_HOME;
}

export function defaultGrokHome(): string {
  return process.env.GROK_HOME
    ? expandHome(process.env.GROK_HOME)
    : DEFAULT_GROK_HOME;
}

export function defaultCursorHome(): string {
  return process.env.CURSOR_HOME
    ? expandHome(process.env.CURSOR_HOME)
    : DEFAULT_CURSOR_HOME;
}

export function defaultCursorKeychainService(): string {
  return CURSOR_KEYCHAIN_SERVICE;
}

export function cursorKeychainAccount(): string {
  return CURSOR_KEYCHAIN_ACCOUNT;
}

async function canReadClaudeKeychain(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("security", [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-w",
    ], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `cursor-agent` actually on this machine? Cursor's `~/.cursor` is shared
 * with the IDE, so the directory alone proves nothing — look for the binary.
 */
async function cursorAgentInstalled(): Promise<boolean> {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  // Installs that a non-interactive PATH often misses.
  const extra = [
    join(homedir(), ".local", "bin"),
    join(DEFAULT_CURSOR_HOME, "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];

  const candidates = [...new Set([...dirs, ...extra])].flatMap((dir) =>
    exts.map((ext) => join(dir, `cursor-agent${ext}`)),
  );
  const hits = await Promise.all(candidates.map(pathExists));
  return hits.some(Boolean);
}

/**
 * Presence check only — deliberately does NOT read the secret (`security -w`),
 * so discovery never trips a keychain-access prompt.
 */
async function cursorHasCredentials(): Promise<boolean> {
  if (process.env.CURSOR_API_KEY?.trim()) return true;
  try {
    if (process.platform === "darwin") {
      await execFileAsync(
        "security",
        [
          "find-generic-password",
          "-s",
          CURSOR_KEYCHAIN_SERVICE,
          "-a",
          CURSOR_KEYCHAIN_ACCOUNT,
        ],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      return true;
    }
    if (process.platform === "linux") {
      const { stdout } = await execFileAsync(
        "secret-tool",
        [
          "lookup",
          "service",
          CURSOR_KEYCHAIN_SERVICE,
          "account",
          CURSOR_KEYCHAIN_ACCOUNT,
        ],
        { timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      return stdout.trim().length > 0;
    }
  } catch {
    /* not installed / not logged in */
  }
  return false;
}

async function discoverDefaults(): Promise<AccountConfig[]> {
  const accounts: AccountConfig[] = [];

  const hasKeychain = await canReadClaudeKeychain();
  const hasCredFile = await pathExists(CLAUDE_CREDENTIALS);
  if (hasKeychain || hasCredFile) {
    accounts.push({
      id: "claude-default",
      provider: "claude",
      label: "personal",
      source: "auto",
    });
  }

  const codexAuth = join(defaultCodexHome(), "auth.json");
  if (await pathExists(codexAuth)) {
    accounts.push({
      id: "codex-default",
      provider: "codex",
      label: "personal",
      source: "auto",
      codexHome: defaultCodexHome(),
    });
  }

  const grokAuth = join(defaultGrokHome(), "auth.json");
  if (await pathExists(grokAuth)) {
    accounts.push({
      id: "grok-default",
      provider: "grok",
      label: "personal",
      source: "auto",
      grokHome: defaultGrokHome(),
    });
  }

  // Cursor only counts as present when cursor-agent is installed AND signed in.
  // Either one missing → no account → nothing renders. No error row, no
  // placeholder: users without cursor-agent never see it at all.
  if ((await cursorAgentInstalled()) && (await cursorHasCredentials())) {
    accounts.push({
      id: "cursor-default",
      provider: "cursor",
      label: "personal",
      source: "keychain",
      cursorHome: defaultCursorHome(),
    });
  }

  return accounts;
}

export async function loadConfig(): Promise<TokmeterConfig> {
  const path = configPath();
  if (await pathExists(path)) {
    try {
      const raw = await readJsonFile<TokmeterConfig>(path);
      if (raw && Array.isArray(raw.accounts)) {
        const accounts = raw.accounts.map(normalizeAccount);
        const dismissed = Array.isArray(raw.dismissed) ? raw.dismissed : [];
        return {
          accounts: [
            ...accounts,
            ...(await backfillDiscovered(accounts, dismissed)),
          ],
          dismissed,
        };
      }
    } catch {
      // fall through to auto-discover
    }
  }
  return { accounts: await discoverDefaults() };
}

/**
 * A saved config predates every CLI installed after it. Rather than make users
 * run `accounts add` when they pick up a new agent, discover providers the
 * config has no account for at all — minus any they explicitly removed.
 * Purely in-memory: nothing is written until the user runs an accounts command.
 */
async function backfillDiscovered(
  existing: AccountConfig[],
  dismissed: ProviderName[],
): Promise<AccountConfig[]> {
  const known = new Set(existing.map((a) => a.provider));
  const skip = new Set(dismissed);
  const discovered = await discoverDefaults();
  return discovered.filter(
    (a) => !known.has(a.provider) && !skip.has(a.provider),
  );
}

function normalizeAccount(a: AccountConfig): AccountConfig {
  return {
    ...a,
    credentialsPath: a.credentialsPath
      ? expandHome(a.credentialsPath)
      : undefined,
    codexHome: a.codexHome ? expandHome(a.codexHome) : undefined,
    grokHome: a.grokHome ? expandHome(a.grokHome) : undefined,
    cursorHome: a.cursorHome ? expandHome(a.cursorHome) : undefined,
  };
}

export async function saveConfig(config: TokmeterConfig): Promise<void> {
  await writeJsonFile(configPath(), config);
}

export async function listAccounts(): Promise<AccountConfig[]> {
  const cfg = await loadConfig();
  return cfg.accounts;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export async function addAccount(opts: {
  provider: ProviderName;
  label: string;
  credentialsPath?: string;
  codexHome?: string;
  grokHome?: string;
  cursorHome?: string;
  keychainService?: string;
  source?: AccountConfig["source"];
  id?: string;
}): Promise<AccountConfig> {
  const cfg = await loadConfig();
  // If we were auto-discovered, persist those first so we don't lose them
  if (!(await pathExists(configPath()))) {
    // keep discovered accounts
  }

  const id =
    opts.id ??
    `${opts.provider}-${slug(opts.label) || "account"}`;

  if (cfg.accounts.some((a) => a.id === id)) {
    throw new Error(`Account id already exists: ${id}`);
  }

  const inferredSource: AccountConfig["source"] =
    opts.source ??
    (opts.credentialsPath
      ? "credentials_file"
      : opts.keychainService || opts.provider === "cursor"
        ? "keychain"
        : opts.codexHome || opts.grokHome
          ? "auth_file"
          : "auto");

  const account: AccountConfig = normalizeAccount({
    id,
    provider: opts.provider,
    label: opts.label,
    source: inferredSource,
    credentialsPath: opts.credentialsPath,
    codexHome: opts.codexHome,
    grokHome: opts.grokHome,
    cursorHome: opts.cursorHome,
    keychainService: opts.keychainService,
  });

  // Adding a provider back clears an earlier `accounts remove` dismissal.
  cfg.dismissed = cfg.dismissed?.filter((p) => p !== opts.provider);

  cfg.accounts.push(account);
  await saveConfig(cfg);
  return account;
}

export async function removeAccount(id: string): Promise<boolean> {
  const cfg = await loadConfig();
  // Materialize auto-discover into a real config if needed
  const removed = cfg.accounts.find((a) => a.id === id);
  if (!removed) return false;
  cfg.accounts = cfg.accounts.filter((a) => a.id !== id);

  // Removing a provider's last account means "stop showing this" — record it
  // so auto-discovery doesn't hand it straight back on the next run.
  if (!cfg.accounts.some((a) => a.provider === removed.provider)) {
    cfg.dismissed = [
      ...new Set([...(cfg.dismissed ?? []), removed.provider]),
    ];
  }

  await saveConfig(cfg);
  return true;
}

/** Insert or replace an account by id. */
export async function upsertAccount(
  account: AccountConfig,
): Promise<{ account: AccountConfig; replaced: boolean }> {
  const cfg = await loadConfig();
  const normalized = normalizeAccount(account);
  const idx = cfg.accounts.findIndex((a) => a.id === normalized.id);
  const replaced = idx >= 0;
  if (replaced) {
    cfg.accounts[idx] = normalized;
  } else {
    cfg.accounts.push(normalized);
  }
  await saveConfig(cfg);
  return { account: normalized, replaced };
}

export function filterAccounts(
  accounts: AccountConfig[],
  provider?: ProviderName,
): AccountConfig[] {
  if (!provider) return accounts;
  return accounts.filter((a) => a.provider === provider);
}
