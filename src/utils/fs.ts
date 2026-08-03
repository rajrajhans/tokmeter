import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(
  path: string,
  data: unknown,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(path, payload, { encoding: "utf8", mode });
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "tokmeter");
  return join(homedir(), ".config", "tokmeter");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}
