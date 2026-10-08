import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

/**
 * The ID token from a ChatGPT sign-in, verified as OpenAI's docs require: the signature against OpenAI's
 * published keys (RS256, the only algorithm its discovery document lists), then the issuer, the audience
 * (the issued client ID), the expiry and the nonce of this sign-in. node:crypto does the RSA check, so no
 * JWT library is needed.
 */
export type IdClaims = { sub: string; email?: string; name?: string; plan?: string };
export class IdTokenError extends Error {}

type Jwk = JsonWebKey & { kid?: string; kty?: string };
export type KeySource = { find(kid: string | undefined): Promise<Jwk | undefined> };

const CLOCK_SKEW_S = 60;
const KEYS_TTL_MS = 60 * 60_000;

/** OpenAI's signing keys, cached for an hour and fetched again when a token names a key not seen yet. */
export function createJwks(url: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): KeySource {
  let keys: Jwk[] | undefined;
  let fetchedAt = 0;
  const pick = (list: Jwk[], kid: string | undefined) => list.find((k) => k.kty === "RSA" && (kid === undefined || k.kid === kid));
  return {
    async find(kid) {
      if (keys && now() - fetchedAt < KEYS_TTL_MS) {
        const hit = pick(keys, kid);
        if (hit) return hit;
      }
      const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new IdTokenError(`OpenAI's signing keys could not be read (HTTP ${res.status}).`);
      const body = (await res.json()) as { keys?: unknown };
      keys = Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
      fetchedAt = now();
      return pick(keys, kid);
    },
  };
}

function part(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  return parsed as Record<string, unknown>;
}

export async function verifyIdToken(
  token: string,
  expected: { issuer: string; audience: string; nonce: string },
  keys: KeySource,
  now: () => number = Date.now,
): Promise<IdClaims> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new IdTokenError("The ID token is not a signed token.");
  const [h, p, s] = segments as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = part(h);
    payload = part(p);
  } catch {
    throw new IdTokenError("The ID token could not be read.");
  }
  if (header.alg !== "RS256") throw new IdTokenError("The ID token is not signed the way OpenAI signs them.");
  const jwk = await keys.find(typeof header.kid === "string" ? header.kid : undefined);
  if (!jwk) throw new IdTokenError("The ID token is signed with a key OpenAI does not publish.");
  let valid = false;
  try {
    valid = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) throw new IdTokenError("The ID token's signature is not valid.");
  if (payload.iss !== expected.issuer) throw new IdTokenError("The ID token was not issued by OpenAI.");
  const aud = payload.aud;
  if (!(aud === expected.audience || (Array.isArray(aud) && aud.includes(expected.audience)))) throw new IdTokenError("The ID token was issued to another app.");
  const nowS = now() / 1000;
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < nowS) throw new IdTokenError("The ID token has expired.");
  if (typeof payload.iat !== "number") throw new IdTokenError("The ID token has no issue time.");
  if (payload.nonce !== expected.nonce) throw new IdTokenError("The ID token belongs to another sign-in.");
  if (typeof payload.sub !== "string" || !payload.sub) throw new IdTokenError("The ID token names no account.");
  const auth = payload["https://api.openai.com/auth"];
  const plan = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_plan_type : undefined;
  return {
    sub: payload.sub,
    ...(typeof payload.email === "string" && payload.email ? { email: payload.email } : {}),
    ...(typeof payload.name === "string" && payload.name ? { name: payload.name } : {}),
    ...(typeof plan === "string" && plan ? { plan } : {}),
  };
}
