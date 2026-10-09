import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The workflow runtime refuses private addresses unless allowed (its egress
 * policy); loopback is always allowed by the engine's matrix. A model server
 * on the local network (Ollama on another machine) needs its own entry — a
 * single-address range for the endpoint's host when it is a private literal.
 */
export function privateHostAllow(endpoint: string): string | null {
  let host: string;
  try {
    host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  const kind = isIP(host);
  if (kind === 4) return isPrivateAddress(host) && !host.startsWith("127.") ? `${host}/32` : null;
  if (kind === 6) {
    const lower = host.toLowerCase();
    if (lower === "::1") return null;
    return isPrivateAddress(lower) ? `${host}/128` : null;
  }
  return null;
}

/**
 * One address on a network of your own: this computer, the local network (10/8, 172.16/12, 192.168/16), a VPN such
 * as Tailscale (100.64.0.0/10, never routed on the internet), link-local, or private and link-local IPv6.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254);
  }
  if (kind === 6) {
    if (ip === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip); // unique local, link-local
  }
  return false;
}

type ResolveAll = (host: string) => Promise<Array<{ address: string }>>;
const resolveAll: ResolveAll = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Whether a model server is on a network of your own, by address or by name: a LAN name (nas.local), a VPN's
 * (Tailscale's MagicDNS, gpu-box.tailnet.ts.net). A name is resolved once, when it is chosen, and counts only when
 * every address it resolves to is private.
 */
export async function resolvesPrivate(endpoint: string, resolve: ResolveAll = resolveAll, timeoutMs = 5000): Promise<boolean> {
  let host: string;
  try {
    host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (isIP(host)) return isPrivateAddress(host);
  if (host === "localhost") return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no answer")), timeoutMs);
    });
    const addresses = await Promise.race([resolve(host), timeout]);
    return addresses.length > 0 && addresses.every((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A model server on this computer (loopback): it needs no API key, and the engine may always reach it. */
export function isLocalEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}
