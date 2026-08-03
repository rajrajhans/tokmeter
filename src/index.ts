#!/usr/bin/env node
import {
  addAccount,
  filterAccounts,
  listAccounts,
  loadConfig,
  removeAccount,
} from "./config.js";
import { renderHuman, renderJson } from "./display.js";
import { fetchAllSnapshots } from "./providers/index.js";
import type { ProviderName } from "./types.js";

const PROVIDERS: ProviderName[] = ["claude", "codex", "grok"];

function printHelp(): void {
  console.log(`tokmeter — unified usage for Claude Code, Codex, and Grok

Usage:
  tokmeter [usage] [--provider <name>] [--json]
  tokmeter accounts list
  tokmeter accounts add --provider <name> --label <label> [options]
  tokmeter accounts remove <id>
  tokmeter --help

Options:
  --provider, -p   claude | codex | grok
  --json           machine-readable output
  --help, -h       show this help

accounts add options:
  --credentials-path <path>   Claude credentials JSON
  --codex-home <path>         Codex home (contains auth.json)
  --grok-home <path>          Grok home (contains auth.json)
  --keychain-service <name>   Claude macOS keychain service
  --id <id>                   optional account id

Examples:
  tokmeter
  tokmeter usage --provider claude
  tokmeter --json
  tokmeter accounts add --provider codex --label work --codex-home ~/.codex-work
`);
}

function parseArgs(argv: string[]): {
  command: "usage" | "accounts-list" | "accounts-add" | "accounts-remove" | "help";
  provider?: ProviderName;
  json: boolean;
  removeId?: string;
  add?: {
    provider?: ProviderName;
    label?: string;
    credentialsPath?: string;
    codexHome?: string;
    grokHome?: string;
    keychainService?: string;
    id?: string;
  };
} {
  const args = [...argv];
  let command: "usage" | "accounts-list" | "accounts-add" | "accounts-remove" | "help" =
    "usage";
  let provider: ProviderName | undefined;
  let json = false;
  let removeId: string | undefined;
  const add: {
    provider?: ProviderName;
    label?: string;
    credentialsPath?: string;
    codexHome?: string;
    grokHome?: string;
    keychainService?: string;
    id?: string;
  } = {};

  if (args.length === 0) {
    return { command: "usage", json: false };
  }

  const first = args[0];
  if (first === "usage") {
    args.shift();
    command = "usage";
  } else if (first === "accounts") {
    args.shift();
    const sub = args.shift();
    if (sub === "list") command = "accounts-list";
    else if (sub === "add") command = "accounts-add";
    else if (sub === "remove") {
      command = "accounts-remove";
      removeId = args.shift();
    } else {
      command = "help";
    }
  } else if (first === "help" || first === "--help" || first === "-h") {
    return { command: "help", json: false };
  } else if (!first.startsWith("-")) {
    // unknown top-level → help
    if (first !== "usage") {
      // allow flags only at top level for default usage
    }
  }

  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      command = "help";
    } else if (a === "--provider" || a === "-p") {
      const v = args.shift();
      if (!v || !PROVIDERS.includes(v as ProviderName)) {
        throw new Error(`Invalid --provider (expected ${PROVIDERS.join("|")})`);
      }
      provider = v as ProviderName;
      if (command === "accounts-add") add.provider = provider;
    } else if (a === "--label") {
      add.label = args.shift();
    } else if (a === "--credentials-path") {
      add.credentialsPath = args.shift();
    } else if (a === "--codex-home") {
      add.codexHome = args.shift();
    } else if (a === "--grok-home") {
      add.grokHome = args.shift();
    } else if (a === "--keychain-service") {
      add.keychainService = args.shift();
    } else if (a === "--id") {
      add.id = args.shift();
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    } else if (command === "accounts-remove" && !removeId) {
      removeId = a;
    } else {
      throw new Error(`Unexpected argument: ${a}`);
    }
  }

  return { command, provider, json, removeId, add };
}

async function cmdUsage(
  provider: ProviderName | undefined,
  json: boolean,
): Promise<number> {
  const cfg = await loadConfig();
  const accounts = filterAccounts(cfg.accounts, provider);
  if (accounts.length === 0) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ fetchedAt: new Date().toISOString(), accounts: [] }, null, 2) +
          "\n",
      );
    } else {
      console.error(
        provider
          ? `No accounts for provider: ${provider}`
          : "No accounts discovered. Sign in to Claude Code / Codex / Grok, or add accounts.",
      );
    }
    return 1;
  }

  const snapshots = await fetchAllSnapshots(accounts);
  if (json) {
    process.stdout.write(renderJson(snapshots));
  } else {
    process.stdout.write(`${renderHuman(snapshots)}\n`);
  }
  return snapshots.every((s) => s.ok) ? 0 : 2;
}

async function cmdAccountsList(json: boolean): Promise<number> {
  const accounts = await listAccounts();
  if (json) {
    process.stdout.write(`${JSON.stringify({ accounts }, null, 2)}\n`);
  } else {
    if (accounts.length === 0) {
      console.log("No accounts configured or discovered.");
      return 0;
    }
    console.log("Accounts:");
    for (const a of accounts) {
      const bits = [
        a.id,
        a.provider,
        a.label,
        a.source ?? "auto",
      ];
      if (a.credentialsPath) bits.push(`creds=${a.credentialsPath}`);
      if (a.codexHome) bits.push(`codexHome=${a.codexHome}`);
      if (a.grokHome) bits.push(`grokHome=${a.grokHome}`);
      console.log(`  ${bits.join("  ·  ")}`);
    }
    console.log(`\nConfig: ~/.config/tokmeter/config.json (auto-discover if missing)`);
  }
  return 0;
}

async function cmdAccountsAdd(add: {
  provider?: ProviderName;
  label?: string;
  credentialsPath?: string;
  codexHome?: string;
  grokHome?: string;
  keychainService?: string;
  id?: string;
}): Promise<number> {
  if (!add.provider || !PROVIDERS.includes(add.provider)) {
    console.error("accounts add requires --provider claude|codex|grok");
    return 1;
  }
  if (!add.label) {
    console.error("accounts add requires --label <name>");
    return 1;
  }
  // Materialize current discovery into config before adding
  const cfg = await loadConfig();
  const { saveConfig } = await import("./config.js");
  await saveConfig(cfg);

  const account = await addAccount({
    provider: add.provider,
    label: add.label,
    credentialsPath: add.credentialsPath,
    codexHome: add.codexHome,
    grokHome: add.grokHome,
    keychainService: add.keychainService,
    id: add.id,
  });
  console.log(`Added account ${account.id} (${account.provider} · ${account.label})`);
  return 0;
}

async function cmdAccountsRemove(id: string | undefined): Promise<number> {
  if (!id) {
    console.error("accounts remove requires <id>");
    return 1;
  }
  // Persist discovered accounts first so remove has something stable
  const cfg = await loadConfig();
  const { saveConfig } = await import("./config.js");
  await saveConfig(cfg);

  const ok = await removeAccount(id);
  if (!ok) {
    console.error(`No account with id: ${id}`);
    return 1;
  }
  console.log(`Removed account ${id}`);
  return 0;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    printHelp();
    process.exitCode = 1;
    return;
  }

  let code = 0;
  switch (parsed.command) {
    case "help":
      printHelp();
      break;
    case "usage":
      code = await cmdUsage(parsed.provider, parsed.json);
      break;
    case "accounts-list":
      code = await cmdAccountsList(parsed.json);
      break;
    case "accounts-add":
      code = await cmdAccountsAdd(parsed.add ?? {});
      break;
    case "accounts-remove":
      code = await cmdAccountsRemove(parsed.removeId);
      break;
  }
  process.exitCode = code;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
