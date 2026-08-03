const enabled =
  process.env.NO_COLOR == null &&
  process.stdout.isTTY === true &&
  process.env.TERM !== "dumb";

export function paint(code: number, text: string): string {
  if (!enabled) return text;
  return `\x1b[38;5;${code}m${text}\x1b[0m`;
}

export function bold(text: string): string {
  if (!enabled) return text;
  return `\x1b[1m${text}\x1b[0m`;
}

export function dim(text: string): string {
  if (!enabled) return text;
  return `\x1b[2m${text}\x1b[0m`;
}

export function reset(): string {
  return enabled ? "\x1b[0m" : "";
}

export const colors = {
  green: (t: string) => paint(46, t),
  yellow: (t: string) => paint(226, t),
  red: (t: string) => paint(196, t),
  cyan: (t: string) => paint(51, t),
  blue: (t: string) => paint(39, t),
  magenta: (t: string) => paint(201, t),
  gray: (t: string) => paint(245, t),
  white: (t: string) => paint(255, t),
};
