import { externalSignIn } from "./oauth.js";
import type { SidecarInfo } from "../sidecar.js";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** OpenRouter's PKCE sign-in in the system browser; resolves with the key it issues. */
export async function signInWithOpenRouter(info: SidecarInfo, deps: { signIn?: typeof externalSignIn; fetchImpl?: typeof fetch } = {}): Promise<string> {
  const signIn = deps.signIn ?? externalSignIn;
  const f = deps.fetchImpl ?? fetch;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const code = await signIn(info, (callback) => `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`);
  const res = await f("https://openrouter.ai/api/v1/auth/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }) });
  if (!res.ok) throw new Error(`OpenRouter did not issue a key (${res.status}).`);
  const { key } = (await res.json()) as { key?: string };
  if (!key) throw new Error("OpenRouter did not issue a key.");
  return key;
}
