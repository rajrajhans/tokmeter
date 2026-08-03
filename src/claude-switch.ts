/**
 * Activate a captured Claude Code login.
 *
 * Snapshots live under ~/.config/tokmeter/claude-creds/. Activating a label
 * writes that OAuth blob into Claude Code's store (keychain on macOS),
 * merging machine-shared fields (mcpOAuth, …) from the *live* credential
 * so MCP logins survive the switch.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userInfo } from "node:os";
import { join } from "node:path";
import { defaultClaudeKeychainService } from "./config.js";
import {
  claudeCredsPath,
  listCapturedClaudeAccounts,
  sanitizeLabel,
} from "./claude-capture.js";
import {
  pathExists,
  readJsonFile,
  writeJsonFile,
} from "./utils/fs.js";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = defaultClaudeKeychainService();
const SECURITY = "/usr/bin/security";

/** Live-owned siblings of claudeAiOauth (keep across account switches). */
const SHARED_CREDENTIAL_KEYS = [
  "mcpOAuth",
  "mcpOAuthClientConfig",
  "mcpXaaIdp",
  "mcpXaaIdpConfig",
  "pluginSecrets",
] as const;

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

function keychainAccount(): string {
  return process.env.USER || userInfo().username;
}

function planHint(oauth: ClaudeOauth | undefined): string {
  if (!oauth) return "unknown";
  const sub = oauth.subscriptionType ?? "unknown";
  const tier =
    (typeof oauth.rateLimitTier === "string" && oauth.rateLimitTier) || "";
  if (tier.includes("20x") || /max_20x/i.test(tier)) return "Max 20x";
  if (tier.includes("5x") || /max_5x/i.test(tier)) return "Max 5x";
  if (sub === "max") return "Max";
  if (sub === "pro") return "Pro";
  return String(sub);
}

function fingerprint(oauth: ClaudeOauth | undefined): string | null {
  const r = oauth?.refreshToken;
  if (typeof r === "string" && r.length >= 12) return r.slice(-12);
  const a = oauth?.accessToken;
  if (typeof a === "string" && a.length >= 12) return a.slice(-12);
  return null;
}

async function readKeychainLive(): Promise<ClaudeCredentials | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      SECURITY,
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout.trim()) as ClaudeCredentials;
  } catch {
    return null;
  }
}

async function writeKeychainLive(data: ClaudeCredentials): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Keychain write is only supported on macOS");
  }
  const payload = JSON.stringify(data);
  const account = keychainAccount();
  // Match Claude Code: update-or-add generic password for this user.
  await execFileAsync(
    SECURITY,
    [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
      payload,
    ],
    { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
  );
}

function credentialsFilePath(): string {
  return join(process.env.HOME || userInfo().homedir, ".claude", ".credentials.json");
}

/** Compose target login with live machine-shared OAuth (mcpOAuth, …). */
export function mergeSharedCredentialFields(
  target: ClaudeCredentials,
  live: ClaudeCredentials | null,
): ClaudeCredentials {
  const composed: ClaudeCredentials = {};
  for (const [k, v] of Object.entries(target)) {
    if ((SHARED_CREDENTIAL_KEYS as readonly string[]).includes(k)) continue;
    composed[k] = v;
  }
  if (live) {
    for (const k of SHARED_CREDENTIAL_KEYS) {
      if (k in live) composed[k] = live[k];
    }
  }
  return composed;
}

export type SwitchResult = {
  label: string;
  plan: string;
  path: string;
  wroteKeychain: boolean;
  wroteFile: boolean;
  preservedSharedKeys: string[];
  note?: string;
};

export async function useClaudeAccount(labelRaw: string): Promise<SwitchResult> {
  const label = sanitizeLabel(labelRaw);
  const path = claudeCredsPath(label);
  if (!(await pathExists(path))) {
    const slots = await listCapturedClaudeAccounts();
    const known = slots.map((s) => s.label).join(", ") || "(none)";
    throw new Error(
      `No captured Claude login “${label}”. Known: ${known}\n` +
        `Capture first: tokmeter save-claude ${label}`,
    );
  }

  const target = await readJsonFile<ClaudeCredentials>(path);
  if (!target?.claudeAiOauth?.accessToken) {
    throw new Error(`Invalid credentials file (missing claudeAiOauth): ${path}`);
  }

  const live = await readKeychainLive();
  // Also try file live for merge source if keychain empty
  let liveForMerge = live;
  if (!liveForMerge) {
    const fp = credentialsFilePath();
    if (await pathExists(fp)) {
      try {
        liveForMerge = await readJsonFile<ClaudeCredentials>(fp);
      } catch {
        liveForMerge = null;
      }
    }
  }

  const composed = mergeSharedCredentialFields(target, liveForMerge);
  const preservedSharedKeys = SHARED_CREDENTIAL_KEYS.filter(
    (k) => liveForMerge && k in liveForMerge,
  );

  let wroteKeychain = false;
  let wroteFile = false;

  if (process.platform === "darwin") {
    await writeKeychainLive(composed);
    wroteKeychain = true;
  }

  // Always keep file in sync (Linux primary; macOS fallback / CLAUDE_CONFIG_DIR users)
  try {
    await writeJsonFile(credentialsFilePath(), composed, 0o600);
    wroteFile = true;
  } catch {
    if (!wroteKeychain) throw new Error("Failed to write Claude credentials file");
  }

  let note: string | undefined;
  if (process.platform === "darwin") {
    note =
      "Claude Code caches the keychain ~30s; new processes pick this up immediately. Restart a running session if it still shows the old account.";
  }

  return {
    label,
    plan: planHint(composed.claudeAiOauth),
    path,
    wroteKeychain,
    wroteFile,
    preservedSharedKeys: [...preservedSharedKeys],
    note,
  };
}

export type ActiveStatus = {
  activeLabel: string | null;
  plan: string | null;
  source: string | null;
  matches: { label: string; plan: string; active: boolean }[];
};

export async function claudeActiveStatus(): Promise<ActiveStatus> {
  let live: ClaudeCredentials | null = await readKeychainLive();
  let source: string | null = live ? `keychain:${KEYCHAIN_SERVICE}` : null;
  if (!live) {
    const fp = credentialsFilePath();
    if (await pathExists(fp)) {
      try {
        live = await readJsonFile<ClaudeCredentials>(fp);
        source = fp;
      } catch {
        live = null;
      }
    }
  }

  const fp = fingerprint(live?.claudeAiOauth ?? undefined);
  const slots = await listCapturedClaudeAccounts();
  const matches: ActiveStatus["matches"] = [];
  let activeLabel: string | null = null;

  for (const slot of slots) {
    try {
      const data = await readJsonFile<ClaudeCredentials>(slot.path);
      const plan = planHint(data.claudeAiOauth);
      const slotFp = fingerprint(data.claudeAiOauth);
      const active = Boolean(fp && slotFp && fp === slotFp);
      if (active) activeLabel = slot.label;
      matches.push({ label: slot.label, plan, active });
    } catch {
      matches.push({ label: slot.label, plan: "?", active: false });
    }
  }

  return {
    activeLabel,
    plan: planHint(live?.claudeAiOauth),
    source,
    matches,
  };
}
