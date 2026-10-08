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
  if (kind === 4) {
    const [a, b] = host.split(".").map(Number);
    const rfc1918 = a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
    return rfc1918 ? `${host}/32` : null;
  }
  if (kind === 6) {
    const lower = host.toLowerCase();
    if (lower === "::1") return null;
    return /^f[cd][0-9a-f]{2}:/.test(lower) ? `${host}/128` : null; // unique local addresses
  }
  return null;
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
