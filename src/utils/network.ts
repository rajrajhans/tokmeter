/**
 * Node's Happy Eyeballs (autoSelectFamily) defaults to a ~250ms attempt
 * timeout. On high-latency links (VPN, far region, congested Wi‑Fi) the
 * IPv4 TCP handshake often takes 300–1000ms, so Node abandons IPv4 and
 * fails over to IPv6. Many home networks advertise AAAA but have no
 * working IPv6 route (EHOSTUNREACH) → every `fetch` dies as
 * "TypeError: fetch failed".
 *
 * curl still works because it waits longer. Raise the attempt timeout
 * and prefer IPv4 so quota APIs succeed on the same network.
 */
import dns from "node:dns";
import net from "node:net";

let applied = false;

export function configureNetwork(): void {
  if (applied) return;
  applied = true;

  try {
    dns.setDefaultResultOrder("ipv4first");
  } catch {
    /* older node */
  }

  try {
    // Node 20.11+ / 22: default is 250ms — too aggressive for slow paths.
    if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === "function") {
      net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
    }
  } catch {
    /* ignore */
  }
}

/** Expand undici's opaque "fetch failed" into something actionable. */
export function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [err.message];
  const cause = (err as Error & { cause?: unknown }).cause;

  if (cause && typeof cause === "object") {
    const c = cause as {
      code?: string;
      message?: string;
      errors?: Array<{ code?: string; message?: string; address?: string }>;
    };
    if (c.code) parts.push(c.code);
    if (Array.isArray(c.errors) && c.errors.length > 0) {
      const codes = [
        ...new Set(c.errors.map((e) => e.code).filter(Boolean)),
      ];
      if (codes.length) parts.push(codes.join("/"));
      const sample = c.errors[0];
      if (sample?.address) parts.push(sample.address);
    } else if (c.message && c.message !== err.message) {
      parts.push(c.message);
    }
  }

  return parts.filter(Boolean).join(" · ");
}
