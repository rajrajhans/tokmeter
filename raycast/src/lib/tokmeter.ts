import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePayload, redact, type Payload } from "./model";

const TIMEOUT_MS = 60_000;

export type FetchOutcome =
  | { ok: true; payload: Payload }
  | { ok: false; message: string };

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; message: string };

type RunResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  maxBuffer: boolean;
  missing: boolean;
};

/**
 * Find tokmeter the same way the HUD does: an explicit path, then the usual
 * install locations, then PATH. Raycast's own PATH is too small for Nix and Homebrew.
 */
export function resolveBinary(input: {
  override?: string;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
}): ResolveResult {
  const override = input.override?.trim() ?? "";
  if (override) {
    if (input.exists(override)) return { ok: true, path: override };
    return {
      ok: false,
      message: "tokmeter was not found at the path in preferences.",
    };
  }

  const fromEnv = input.env.TOKMETER_BIN?.trim() ?? "";
  const candidates = [
    fromEnv,
    join(input.home, ".local/bin/tokmeter"),
    join(input.home, ".nix-profile/bin/tokmeter"),
    "/run/current-system/sw/bin/tokmeter",
    "/opt/homebrew/bin/tokmeter",
    "/usr/local/bin/tokmeter",
  ];
  for (const dir of (input.env.PATH ?? "").split(":")) {
    if (dir) candidates.push(join(dir, "tokmeter"));
  }

  const seen = new Set<string>();
  for (const path of candidates) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (input.exists(path)) return { ok: true, path };
  }
  return {
    ok: false,
    message:
      "tokmeter isn't installed. Add it to PATH, or set the binary path in preferences.",
  };
}

export function interpretRun(run: RunResult): FetchOutcome {
  if (run.missing)
    return { ok: false, message: "tokmeter binary could not be started." };
  if (run.maxBuffer)
    return { ok: false, message: "tokmeter output was larger than expected." };
  if (run.killed)
    return { ok: false, message: "tokmeter timed out after 60 seconds." };

  const stdout = run.stdout.trim();
  if (stdout.startsWith("{")) {
    try {
      return { ok: true, payload: parsePayload(stdout) };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "tokmeter returned unexpected JSON";
      return { ok: false, message };
    }
  }

  const detail = redact(
    run.stderr || run.stdout || `tokmeter exited ${run.code}`,
  );
  const line =
    detail
      .split("\n")
      .find((item) => item.trim())
      ?.trim() ?? "tokmeter failed";
  return { ok: false, message: line.slice(0, 240) };
}

export async function fetchTokmeter(
  binaryPath: string,
  includeStats: boolean,
): Promise<Payload> {
  const resolved = resolveBinary({
    override: binaryPath,
    env: process.env,
    home: homedir(),
    exists: canExec,
  });
  if (!resolved.ok) throw new Error(resolved.message);

  const args = includeStats ? ["stats", "--json"] : ["--json"];
  const run = await runBinary(
    resolved.path,
    args,
    childEnv(process.env, homedir()),
  );
  const outcome = interpretRun(run);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.payload;
}

function canExec(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function childEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const prepend = [
    join(home, ".nix-profile/bin"),
    "/run/current-system/sw/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local/bin"),
  ];
  const merged: string[] = [];
  for (const path of [...prepend, ...(env.PATH ?? "").split(":")]) {
    if (path && !merged.includes(path)) merged.push(path);
  }
  return { ...env, PATH: merged.join(":") };
}

function runBinary(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 12 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        const err = error as
          | (NodeJS.ErrnoException & { killed?: boolean; signal?: string })
          | null;
        const message = err?.message ?? "";
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          killed:
            Boolean(err?.killed) ||
            err?.signal === "SIGTERM" ||
            /timed out/i.test(message),
          maxBuffer: /maxBuffer/i.test(message),
          missing: err?.code === "ENOENT",
        });
      },
    );
  });
}
