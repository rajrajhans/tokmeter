import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userInfo } from "node:os";
import {
  defaultClaudeKeychainService,
  loadConfig,
  saveConfig,
  upsertAccount,
} from "./config.js";
import {
  configDir,
  configPath,
  pathExists,
  writeJsonFile,
} from "./utils/fs.js";

const execFileAsync = promisify(execFile);

export function claudeCredsDir(): string {
  return join(configDir(), "claude-creds");
}

export function claudeCredsPath(label: string): string {
  const safe = sanitizeLabel(label);
  return join(claudeCredsDir(), `${safe}.json`);
}

export function sanitizeLabel(label: string): string {
  const s = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!s) throw new Error("Label must contain letters or numbers");
  return s;
}

type ClaudeOauth = {
  accessToken?: string;
  refreshToken?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
  expiresAt?: number;
  [key: string]: unknown;
};

type ClaudeCredentials = {
  claudeAiOauth?: ClaudeOauth;
  [key: string]: unknown;
};

function planHint(oauth: ClaudeOauth | undefined): string {
  if (!oauth) return "unknown";
  const sub = oauth.subscriptionType ?? "unknown";
  const tier =
    (typeof oauth.rateLimitTier === "string" && oauth.rateLimitTier) ||
    (typeof oauth["rateLimitTiers"] === "string" &&
      (oauth["rateLimitTiers"] as string)) ||
    "";
  if (tier.includes("20x") || /max_20x/i.test(tier)) return "Max 20x";
  if (tier.includes("5x") || /max_5x/i.test(tier)) return "Max 5x";
  if (sub === "max") return "Max";
  if (sub === "pro") return "Pro";
  return sub;
}

/** Read current Claude Code login (macOS keychain, then ~/.claude/.credentials.json). */
export async function readCurrentClaudeCredentials(
  keychainService = defaultClaudeKeychainService(),
): Promise<{ data: ClaudeCredentials; source: string }> {
  // Prefer keychain on macOS (where Claude Code stores the live session).
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", keychainService, "-w"],
        { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      );
      const data = JSON.parse(stdout.trim()) as ClaudeCredentials;
      if (data?.claudeAiOauth?.accessToken) {
        return { data, source: `keychain:${keychainService}` };
      }
    } catch {
      /* fall through */
    }
  }

  const filePath = join(
    process.env.HOME || userInfo().homedir,
    ".claude",
    ".credentials.json",
  );
  if (await pathExists(filePath)) {
    const { readJsonFile } = await import("./utils/fs.js");
    const data = await readJsonFile<ClaudeCredentials>(filePath);
    if (data?.claudeAiOauth?.accessToken) {
      return { data, source: filePath };
    }
  }

  throw new Error(
    "No Claude Code credentials found. Log in with `claude` first, then re-run.",
  );
}

export type CaptureResult = {
  label: string;
  path: string;
  plan: string;
  source: string;
  registered: boolean;
  accountId: string;
  replaced: boolean;
  /** Another captured label with the same login (if any). */
  duplicateOf?: string;
};

/**
 * Snapshot the currently logged-in Claude Code account under a label.
 * Writes ~/.config/tokmeter/claude-creds/<label>.json and (by default)
 * registers/updates the account in tokmeter config.
 */
export async function captureClaudeAccount(opts: {
  label: string;
  register?: boolean;
  keychainService?: string;
}): Promise<CaptureResult> {
  const label = sanitizeLabel(opts.label);
  const register = opts.register !== false;
  const path = claudeCredsPath(label);

  const { data, source } = await readCurrentClaudeCredentials(
    opts.keychainService,
  );
  const oauth = data.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error("Claude credentials JSON is missing claudeAiOauth.accessToken");
  }

  // Detect if this login was already captured under another label
  // (compare refresh token fingerprints — never log the tokens).
  const refresh = oauth.refreshToken ?? "";
  const refreshFp = refresh ? refresh.slice(-12) : "";
  let duplicateOf: string | undefined;
  if (refreshFp) {
    const slots = await listCapturedClaudeAccounts();
    const { readJsonFile } = await import("./utils/fs.js");
    for (const slot of slots) {
      if (slot.label === label) continue;
      try {
        const other = await readJsonFile<ClaudeCredentials>(slot.path);
        const otherRefresh = other.claudeAiOauth?.refreshToken ?? "";
        if (otherRefresh && otherRefresh.slice(-12) === refreshFp) {
          duplicateOf = slot.label;
          break;
        }
      } catch {
        /* skip unreadable */
      }
    }
  }

  await writeJsonFile(path, data, 0o600);

  let registered = false;
  let replaced = false;
  const accountId = `claude-${label}`;

  if (register) {
    const cfg = await loadConfig();
    // Materialize auto-discover so we don't lose codex/grok defaults.
    if (!(await pathExists(configPath()))) {
      await saveConfig(cfg);
    }

    // Drop ambient keychain auto-account once the user manages explicit slots.
    // Keeps `tokmeter` from showing the same login thrice.
    const filtered = cfg.accounts.filter((a) => a.id !== "claude-default");
    if (filtered.length !== cfg.accounts.length) {
      cfg.accounts = filtered;
      await saveConfig(cfg);
    }

    const existing = cfg.accounts.find((a) => a.id === accountId);
    replaced = Boolean(existing);
    await upsertAccount({
      id: accountId,
      provider: "claude",
      label,
      source: "credentials_file",
      credentialsPath: path,
    });
    registered = true;
  }

  return {
    label,
    path,
    plan: planHint(oauth),
    source,
    registered,
    accountId,
    replaced,
    duplicateOf,
  };
}

export async function listCapturedClaudeAccounts(): Promise<
  { label: string; path: string }[]
> {
  const dir = claudeCredsDir();
  if (!(await pathExists(dir))) return [];
  const names = await readdir(dir);
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => ({
      label: n.replace(/\.json$/, ""),
      path: join(dir, n),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
