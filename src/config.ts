import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, ProviderName, TokmeterConfig } from "./types.js";
import {
  configPath,
  expandHome,
  pathExists,
  readJsonFile,
  writeJsonFile,
} from "./utils/fs.js";

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CREDENTIALS = join(homedir(), ".claude", ".credentials.json");
const DEFAULT_CODEX_HOME = join(homedir(), ".codex");
const DEFAULT_GROK_HOME = join(homedir(), ".grok");

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

  return accounts;
}

export async function loadConfig(): Promise<TokmeterConfig> {
  const path = configPath();
  if (await pathExists(path)) {
    try {
      const raw = await readJsonFile<TokmeterConfig>(path);
      if (raw && Array.isArray(raw.accounts)) {
        return {
          accounts: raw.accounts.map(normalizeAccount),
        };
      }
    } catch {
      // fall through to auto-discover
    }
  }
  return { accounts: await discoverDefaults() };
}

function normalizeAccount(a: AccountConfig): AccountConfig {
  return {
    ...a,
    credentialsPath: a.credentialsPath
      ? expandHome(a.credentialsPath)
      : undefined,
    codexHome: a.codexHome ? expandHome(a.codexHome) : undefined,
    grokHome: a.grokHome ? expandHome(a.grokHome) : undefined,
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

  const account: AccountConfig = normalizeAccount({
    id,
    provider: opts.provider,
    label: opts.label,
    source: opts.source ?? "auto",
    credentialsPath: opts.credentialsPath,
    codexHome: opts.codexHome,
    grokHome: opts.grokHome,
    keychainService: opts.keychainService,
  });

  cfg.accounts.push(account);
  await saveConfig(cfg);
  return account;
}

export async function removeAccount(id: string): Promise<boolean> {
  const cfg = await loadConfig();
  // Materialize auto-discover into a real config if needed
  const before = cfg.accounts.length;
  cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
  if (cfg.accounts.length === before) return false;
  await saveConfig(cfg);
  return true;
}

export function filterAccounts(
  accounts: AccountConfig[],
  provider?: ProviderName,
): AccountConfig[] {
  if (!provider) return accounts;
  return accounts.filter((a) => a.provider === provider);
}
