import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chatGptFailureFromBody } from "../gateway/errors.js";
import type { ModelCatalog } from "../models-validate.js";
import { AGENT_NAME, DYNAMIC_CLIENT_ID, OPENAI_ENDPOINTS, PLAN_SCOPE, RESOURCE, SCOPES, type ChatGptEndpoints } from "./constants.js";
import { createJwks, IdTokenError, verifyIdToken, type IdClaims, type KeySource } from "./id-token.js";
import { ensureChatGpt, readChatGpt, writeChatGpt, type ChatGptRegistration, type ChatGptTokens } from "./store.js";

/**
 * Sign in with ChatGPT, held by the engine (spec §2.1, §3): the engine builds the sign-in link, the window opens
 * it in the system browser (the engine never opens a browser itself), the browser comes back to the control
 * server's loopback address, and the engine exchanges the code (PKCE), verifies the ID token and the granted
 * scopes, and keeps the tokens in secrets/chatgpt.json. It renews the access token before its hour is up and
 * revokes the session at sign-out. No token ever reaches the window: it sees only the status below.
 */
export type ChatGptStatus = {
  signedIn: boolean;
  /** `chatgpt.tokens.use.direct` was granted: requests can run on the user's ChatGPT plan. */
  planUsage: boolean;
  account?: { email?: string; name?: string; plan?: string };
  scopes: string[];
  /** When the current access token ends; it is renewed on its own before then. */
  expiresAt?: string;
  /** Signed out, with an account registered here: "Continue with ChatGPT" signs in to it again. */
  savedAccount?: { email?: string };
  /** A sign-in in progress: the link to show if the browser did not open. */
  pending: { url: string; startedAt: string } | null;
  /** The sign-in just finished registered this app for the account: the one-time "You're using your ChatGPT plan". */
  firstSignIn?: boolean;
  /** ChatGPT answered "usage limit reached" since the last request that succeeded. */
  usageLimit?: { at: string };
  lastError?: string;
};
export type ChatGptModel = { slug: string; name: string };

/** A refusal in words a person can act on; `status` is what the control API and the gateway answer with. */
export class ChatGptError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** A passing failure (network, 5xx): the credentials are kept, and a still-valid token may be used. */
    readonly transient = false,
  ) {
    super(message);
  }
}

export const NOT_SIGNED_IN = "Sign in with ChatGPT first: Settings › Models › Continue with ChatGPT.";
export const PLAN_NOT_ALLOWED =
  "Knowledge Vault is signed in to ChatGPT but not allowed to use your ChatGPT plan. Allow it with Continue with ChatGPT in Settings › Models, or choose another AI model.";

const SIGN_IN_TTL_MS = 10 * 60_000;
/** Renew this long before the hour is up, so a long request never starts on a token about to end. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** A token with less than this left is not used, even when renewing it failed for a passing reason. */
const STILL_USABLE_MS = 30_000;
/** OpenAI's codes for a refresh token that will never work again (errors-and-recovery › Refresh errors). */
const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

type Pending = {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** The client the authorize request named: an issued one, or the first-sign-in entry point. */
  clientId: string;
  registration?: ChatGptRegistration;
  url: string;
  startedAt: number;
};

export type ChatGptDeps = {
  dataDir: string;
  fetchImpl?: typeof fetch;
  endpoints?: ChatGptEndpoints;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One line per event; never a token. */
  log?: (line: string) => void;
  /** Tests: the signing keys, instead of OpenAI's published ones. */
  keys?: KeySource;
};

const random = () => randomBytes(32).toString("base64url");
const iso = (ms: number) => new Date(ms).toISOString();
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** What the browser tab shows when it comes back (the look of oauth.ts's page). */
export function callbackPage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} — Knowledge Vault</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1e2e;color:#e4e4e7;font:16px/1.5 system-ui,sans-serif}
main{text-align:center;max-width:30rem;padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#a1a1aa;margin:0}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;
}

/** A token endpoint's error code: the standard `{error: "invalid_grant"}`, or `{error: {code}}`. */
export function oauthErrorCode(bodyText: string): string | undefined {
  try {
    const body = JSON.parse(bodyText) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error === "object") {
      const e = body.error as { code?: unknown; type?: unknown };
      if (typeof e.code === "string") return e.code;
      if (typeof e.type === "string") return e.type;
    }
    if (typeof body.code === "string") return body.code;
  } catch {
    // not JSON
  }
  return undefined;
}

/** `earliest_refresh_at`, whether it comes as seconds, milliseconds or a date; anything else is ignored. */
function instant(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

export function createChatGpt(deps: ChatGptDeps) {
  const f = deps.fetchImpl ?? fetch;
  const endpoints = deps.endpoints ?? OPENAI_ENDPOINTS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  const keys = deps.keys ?? createJwks(endpoints.jwks, f, now);
  let pending: Pending | null = null;
  /** What the last finished sign-in showed its tab: a reload shows it again instead of "expired". */
  let finished: { state: string; status: number; html: string } | undefined;
  let lastError: string | undefined;
  /** Why the session ended on its own (a renewal ChatGPT refused for good); said until the next sign-in or sign-out. */
  let ended: string | undefined;
  let firstSignIn = false;
  let usageLimitAt: number | undefined;
  let refreshing: Promise<string> | undefined;

  const form = (fields: Record<string, string>, timeoutMs: number): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const signedOut = () => new ChatGptError(ended ?? NOT_SIGNED_IN, 401, "chatgpt_signed_out");

  function live(): Pending | null {
    if (pending && now() - pending.startedAt > SIGN_IN_TTL_MS) {
      pending = null;
      lastError = "The sign-in was not finished within ten minutes. Start it again.";
    }
    return pending;
  }

  function status(): ChatGptStatus {
    const record = readChatGpt(deps.dataDir);
    const tokens = record?.tokens;
    const active = record?.registrations.find((r) => r.clientId === record.active);
    const attempt = live();
    const planUsage = !!tokens && tokens.scopes.includes(PLAN_SCOPE);
    const error = lastError ?? (tokens ? undefined : ended);
    return {
      signedIn: !!tokens,
      planUsage,
      ...(tokens && active
        ? { account: { ...(active.email ? { email: active.email } : {}), ...(active.name ? { name: active.name } : {}), ...(active.plan ? { plan: active.plan } : {}) } }
        : {}),
      scopes: tokens?.scopes ?? [],
      ...(tokens ? { expiresAt: tokens.expiresAt } : {}),
      ...(!tokens && active ? { savedAccount: active.email ? { email: active.email } : {} } : {}),
      pending: attempt ? { url: attempt.url, startedAt: iso(attempt.startedAt) } : null,
      ...(tokens && firstSignIn ? { firstSignIn: true } : {}),
      ...(planUsage && usageLimitAt !== undefined ? { usageLimit: { at: iso(usageLimitAt) } } : {}),
      ...(error ? { lastError: error } : {}),
    };
  }

  /**
   * The sign-in link for the window to open. A saved account signs in again with its issued client (no new
   * registration, no consent screen); `newAccount` registers the app for another account; `allowPlanUsage`
   * asks for consent again, for a user who declined the plan permission before.
   */
  function startLogin(options: { redirectUri: string; newAccount?: boolean; allowPlanUsage?: boolean }): { url: string } {
    const record = ensureChatGpt(deps.dataDir); // the host ID exists before the first sign-in
    if (options.newAccount && record.tokens) throw new ChatGptError("Sign out of ChatGPT first, then sign in with the other account.", 409, "chatgpt_signed_in");
    const registration = options.newAccount ? undefined : record.registrations.find((r) => r.clientId === record.active);
    const state = random();
    const nonce = random();
    const verifier = random();
    const clientId = registration?.clientId ?? DYNAMIC_CLIENT_ID;
    const params: Array<[string, string]> = [["response_type", "code"], ["client_id", clientId]];
    if (!registration) params.push(["agent_name_hint", AGENT_NAME]);
    params.push(["ext_agent_host_id", record.hostId]);
    // No id_token_hint: the link is shown to the window, and no token may reach it. The email pre-selects the account.
    if (registration?.email) params.push(["login_hint", registration.email]);
    params.push(
      ["redirect_uri", options.redirectUri],
      ["scope", SCOPES.join(" ")],
      ["resource", RESOURCE],
      ["state", state],
      ["nonce", nonce],
      ["code_challenge_method", "S256"],
      ["code_challenge", createHash("sha256").update(verifier).digest("base64url")],
    );
    if (options.allowPlanUsage) params.push(["prompt", "consent"]);
    const url = `${endpoints.authorize}?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
    pending = { state, nonce, verifier, redirectUri: options.redirectUri, clientId, ...(registration ? { registration } : {}), url, startedAt: now() };
    lastError = undefined;
    log(registration ? "sign-in started (saved account)" : "sign-in started (registering this app)");
    return { url };
  }

  function cancelLogin(): void {
    pending = null;
  }

  /** The tokens in a token-endpoint answer; what a refresh leaves out is kept from the session it renews. */
  function tokensFrom(text: string, fallbackScopes: string[], previous?: ChatGptTokens): ChatGptTokens {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ChatGptError("ChatGPT's sign-in service answered with something that could not be read. Try again.", 502, "chatgpt_bad_answer", true);
    }
    const accessToken = typeof body.access_token === "string" && body.access_token ? body.access_token : undefined;
    const refreshToken = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous?.refreshToken;
    const idToken = typeof body.id_token === "string" && body.id_token ? body.id_token : previous?.idToken;
    if (!accessToken || !idToken) throw new ChatGptError("ChatGPT's sign-in service left out part of the sign-in. Try again.", 502, "chatgpt_bad_answer", true);
    if (!refreshToken) throw new ChatGptError("ChatGPT did not grant lasting access (no refresh token), so the sign-in would end within the hour. Try again.", 502, "chatgpt_bad_answer");
    const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : fallbackScopes;
    const earliest = instant(body.earliest_refresh_at);
    const at = now();
    return {
      accessToken,
      refreshToken,
      idToken,
      tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
      expiresAt: iso(at + expiresIn * 1000),
      scopes,
      savedAt: iso(at),
      ...(earliest !== undefined ? { earliestRefreshAt: iso(earliest) } : {}),
    };
  }

  /** Revoke a refresh token (sign-out, or a session replaced). An empty 200 means done, also for a token already invalid. */
  async function revoke(clientId: string, token: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1000 * attempt);
      try {
        const res = await f(endpoints.revoke, form({ token, token_type_hint: "refresh_token", client_id: clientId }, 15_000));
        await res.text().catch(() => "");
        if (res.ok) return true;
        if (res.status < 500) return false; // a refusal will not change on a retry
      } catch {
        // a network failure: try again
      }
    }
    return false;
  }

  async function complete(attempt: Pending, query: URLSearchParams): Promise<boolean> {
    const error = query.get("error");
    if (error === "access_denied") {
      throw new ChatGptError("The sign-in was declined in the browser, so Knowledge Vault cannot use your ChatGPT plan. You can try again any time.", 400, "chatgpt_declined");
    }
    if (error) {
      const description = query.get("error_description");
      throw new ChatGptError(`ChatGPT did not complete the sign-in (${error}${description ? `: ${description}` : ""}).`, 400, "chatgpt_sign_in_failed");
    }
    const code = query.get("code");
    if (!code) throw new ChatGptError("ChatGPT came back without a sign-in code. Start the sign-in again.", 400, "chatgpt_sign_in_failed");
    const returned = query.get("client_id");
    let clientId: string;
    if (attempt.clientId === DYNAMIC_CLIENT_ID) {
      if (!returned || returned === DYNAMIC_CLIENT_ID) throw new ChatGptError("ChatGPT did not finish registering Knowledge Vault. Start the sign-in again.", 400, "chatgpt_registration_incomplete");
      clientId = returned;
    } else {
      if (returned && returned !== attempt.clientId) {
        throw new ChatGptError("ChatGPT answered for another registration of this app than the one the sign-in started with, so the answer was not used. Start the sign-in again.", 400, "chatgpt_client_mismatch");
      }
      clientId = attempt.clientId;
    }

    let res: Response;
    try {
      res = await f(endpoints.token, form({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }, 30_000));
    } catch (e) {
      throw new ChatGptError(`Could not reach ChatGPT to finish the sign-in: ${messageOf(e)}. Start it again.`, 502, "chatgpt_unreachable", true);
    }
    const text = await res.text();
    if (!res.ok) {
      const oauthCode = oauthErrorCode(text);
      if (oauthCode === "invalid_grant") throw new ChatGptError("ChatGPT refused the sign-in code (it may have expired). Start the sign-in again.", 400, "chatgpt_sign_in_failed");
      throw new ChatGptError(`ChatGPT refused the sign-in (HTTP ${res.status}${oauthCode ? `, ${oauthCode}` : ""}). Start it again.`, 400, "chatgpt_sign_in_failed");
    }
    // The token response's scopes decide; the callback's are only a fallback when it names none.
    const tokens = tokensFrom(text, (query.get("scope") ?? "").split(/\s+/).filter(Boolean));

    let claims: IdClaims;
    try {
      claims = await verifyIdToken(tokens.idToken, { issuer: endpoints.issuer, audience: clientId, nonce: attempt.nonce }, keys, now);
    } catch (e) {
      void revoke(clientId, tokens.refreshToken);
      if (e instanceof IdTokenError) throw new ChatGptError(`ChatGPT's sign-in could not be verified: ${e.message} Start it again.`, 400, "chatgpt_id_token");
      throw new ChatGptError(`ChatGPT's sign-in could not be verified: ${messageOf(e)}. Start it again.`, 502, "chatgpt_id_token", true);
    }
    if (attempt.registration && claims.sub !== attempt.registration.subject) {
      void revoke(clientId, tokens.refreshToken);
      const was = attempt.registration.email ? ` (${attempt.registration.email})` : "";
      throw new ChatGptError(`You chose a different ChatGPT account than the one saved here${was}. To use another account, choose “Use a different ChatGPT account”.`, 400, "chatgpt_other_account");
    }

    const record = ensureChatGpt(deps.dataDir);
    const replaced = record.tokens && record.active ? { clientId: record.active, refreshToken: record.tokens.refreshToken } : undefined;
    const registration: ChatGptRegistration = {
      clientId,
      subject: claims.sub,
      ...(claims.email ? { email: claims.email } : {}),
      ...(claims.name ? { name: claims.name } : {}),
      ...(claims.plan ? { plan: claims.plan } : {}),
      registeredAt: attempt.registration?.registeredAt ?? iso(now()),
    };
    record.registrations = [...record.registrations.filter((r) => r.clientId !== clientId), registration];
    record.active = clientId;
    record.tokens = tokens;
    writeChatGpt(deps.dataDir, record);
    // The session this sign-in replaces (asking again for plan use) is ended at OpenAI too.
    if (replaced && replaced.refreshToken !== tokens.refreshToken) void revoke(replaced.clientId, replaced.refreshToken);
    firstSignIn = attempt.clientId === DYNAMIC_CLIENT_ID;
    ended = undefined;
    lastError = undefined;
    usageLimitAt = undefined;
    const planUsage = tokens.scopes.includes(PLAN_SCOPE);
    log(planUsage ? "signed in; the ChatGPT plan may be used" : "signed in, but the ChatGPT plan may not be used (chatgpt.tokens.use.direct was not granted)");
    return planUsage;
  }

  /** The browser came back to the loopback address. Answers the page its tab shows. */
  async function callback(query: URLSearchParams): Promise<{ status: number; html: string }> {
    const state = query.get("state") ?? "";
    if (finished && state && sameText(state, finished.state)) return { status: finished.status, html: finished.html };
    const attempt = live();
    if (!attempt || !state || !sameText(state, attempt.state)) {
      return { status: 404, html: callbackPage("This sign-in link has expired", "Start the sign-in again from Knowledge Vault.") };
    }
    pending = null; // one answer per sign-in
    let result: { status: number; html: string };
    try {
      result = (await complete(attempt, query))
        ? { status: 200, html: callbackPage("Signed in with ChatGPT", "Knowledge Vault can now use your ChatGPT plan. You can close this tab and return to the app.") }
        : { status: 200, html: callbackPage("Signed in, but without your plan", "Knowledge Vault was not allowed to use your ChatGPT plan. Return to the app to allow it, or choose another AI model there.") };
    } catch (error) {
      lastError = error instanceof ChatGptError ? error.message : `The sign-in could not be completed: ${messageOf(error)}`;
      log(`sign-in failed: ${error instanceof ChatGptError ? error.code : "error"}`);
      result = { status: 400, html: callbackPage("The sign-in did not complete", lastError) };
    }
    finished = { state: attempt.state, ...result };
    return result;
  }

  /** The session cannot be renewed: its tokens go; the account stays registered unless ChatGPT no longer knows the client. */
  function endSession(reason: string, forgetRegistration: boolean): void {
    const record = readChatGpt(deps.dataDir);
    if (record) {
      delete record.tokens;
      if (forgetRegistration && record.active) {
        const gone = record.active;
        record.registrations = record.registrations.filter((r) => r.clientId !== gone);
        delete record.active;
      }
      writeChatGpt(deps.dataDir, record);
    }
    ended = reason;
    firstSignIn = false;
    log(`the sign-in ended: ${reason}`);
  }

  async function renew(): Promise<string> {
    const record = readChatGpt(deps.dataDir);
    const tokens = record?.tokens;
    const clientId = record?.active;
    if (!tokens || !clientId) throw signedOut();
    let res: Response;
    try {
      res = await f(endpoints.token, form({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refreshToken, resource: RESOURCE }, 30_000));
    } catch (error) {
      throw new ChatGptError(`Could not reach ChatGPT to renew the sign-in: ${messageOf(error)}.`, 502, "chatgpt_unreachable", true);
    }
    const text = await res.text();
    if (!res.ok) {
      const code = oauthErrorCode(text) ?? "";
      if (TERMINAL_REFRESH.has(code)) {
        endSession(`Your ChatGPT sign-in has ended (${code}). Sign in with ChatGPT again to keep using your plan.`, false);
        throw signedOut();
      }
      if (code === "invalid_client") {
        endSession("ChatGPT no longer recognises this app's registration (it may have been disconnected in ChatGPT settings). Sign in with ChatGPT again.", true);
        throw signedOut();
      }
      throw new ChatGptError(`ChatGPT could not renew the sign-in just now (HTTP ${res.status}${code ? `, ${code}` : ""}). Try again in a minute.`, 503, "chatgpt_unavailable", true);
    }
    const next = tokensFrom(text, tokens.scopes, tokens);
    // Signed out, or signed in again, while this ran: the newer state stands and this session is ended.
    const latest = readChatGpt(deps.dataDir);
    if (!latest?.tokens || latest.active !== clientId || latest.tokens.refreshToken !== tokens.refreshToken) {
      void revoke(clientId, next.refreshToken);
      if (latest?.tokens && latest.active) return latest.tokens.accessToken;
      throw signedOut();
    }
    latest.tokens = next;
    writeChatGpt(deps.dataDir, latest); // the rotated refresh token is on disk before the new access token is used
    log("renewed the access token");
    return next.accessToken;
  }

  /** One renewal at a time: the refresh token rotates, so two at once would race (and the loser's token is spent). */
  function refreshNow(): Promise<string> {
    refreshing ??= renew().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  /** A bearer token for inference, renewed first when it is near its end. */
  async function accessToken(): Promise<string> {
    const tokens = readChatGpt(deps.dataDir)?.tokens;
    if (!tokens) throw signedOut();
    if (!tokens.scopes.includes(PLAN_SCOPE)) throw new ChatGptError(PLAN_NOT_ALLOWED, 403, "chatgpt_plan_not_allowed");
    const left = Date.parse(tokens.expiresAt) - now();
    const earliest = tokens.earliestRefreshAt ? Date.parse(tokens.earliestRefreshAt) : NaN;
    const due = !Number.isFinite(left) || (left < REFRESH_MARGIN_MS && !(left > STILL_USABLE_MS && Number.isFinite(earliest) && now() < earliest));
    if (!due) return tokens.accessToken;
    try {
      return await refreshNow();
    } catch (error) {
      if (error instanceof ChatGptError && error.transient && left > STILL_USABLE_MS) return tokens.accessToken;
      throw error;
    }
  }

  /** ChatGPT refused `rejected` (401): renew, unless another request already did. */
  async function refreshAccessToken(rejected?: string): Promise<string> {
    const tokens = readChatGpt(deps.dataDir)?.tokens;
    if (tokens && rejected && tokens.accessToken !== rejected) return tokens.accessToken;
    return refreshNow();
  }

  /** Sign out: revoke the refresh token at OpenAI (retried on network failures and 5xx), then forget the tokens here. */
  async function logout(): Promise<{ revoked: boolean }> {
    pending = null;
    await refreshing?.catch(() => undefined);
    const record = readChatGpt(deps.dataDir);
    let revoked = true;
    if (record?.tokens && record.active) {
      revoked = await revoke(record.active, record.tokens.refreshToken);
      const latest = readChatGpt(deps.dataDir) ?? record;
      delete latest.tokens;
      writeChatGpt(deps.dataDir, latest); // the account stays registered: signing in again reuses its client
    }
    ended = undefined;
    lastError = undefined;
    firstSignIn = false;
    usageLimitAt = undefined;
    finished = undefined;
    log(revoked ? "signed out" : "signed out on this computer; ChatGPT did not confirm the revocation");
    return { revoked };
  }

  /** The signed-in account's models, in ChatGPT's order: the ones meant for a picker (`visibility: "list"`). */
  async function models(): Promise<ChatGptModel[]> {
    const list = async (token: string) => {
      try {
        return await f(`${endpoints.api}/models`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new ChatGptError(`Could not reach ChatGPT: ${messageOf(error)}.`, 502, "provider_unreachable", true);
      }
    };
    const token = await accessToken();
    let res = await list(token);
    if (res.status === 401) {
      await res.text().catch(() => "");
      res = await list(await refreshAccessToken(token));
    }
    const text = await res.text();
    if (!res.ok) {
      const failure = chatGptFailureFromBody(res.status, text, res.headers.get("x-request-id") ?? undefined);
      throw new ChatGptError(failure.message, failure.status, failure.code);
    }
    let body: { models?: unknown; data?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new ChatGptError("ChatGPT's model list could not be read.", 502, "provider_error");
    }
    const out: ChatGptModel[] = [];
    if (Array.isArray(body.models)) {
      for (const m of body.models as Array<Record<string, unknown> | null>) {
        if (!m || typeof m.slug !== "string" || !m.slug || m.visibility !== "list") continue;
        out.push({ slug: m.slug, name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.slug });
      }
    } else if (Array.isArray(body.data)) {
      for (const m of body.data as Array<Record<string, unknown> | null>) if (m && typeof m.id === "string" && m.id) out.push({ slug: m.id, name: m.id });
    }
    return out;
  }

  /** Settings › Models' picker, in its catalog shape; a failure is a sentence, not an exception. */
  async function catalog(): Promise<ModelCatalog> {
    try {
      return { ok: true, models: (await models()).map((m) => ({ id: m.slug, name: m.name, free: false })) };
    } catch (error) {
      return { ok: false, detail: messageOf(error) };
    }
  }

  /** Settings › Models › Validate: signed in, allowed, and the account's model list answers. */
  async function validate(): Promise<{ ok: boolean; detail: string }> {
    try {
      const list = await models();
      const email = status().account?.email;
      return { ok: true, detail: `Signed in to ChatGPT${email ? ` as ${email}` : ""}: ${list.length} model${list.length === 1 ? "" : "s"} available on your plan.` };
    } catch (error) {
      return { ok: false, detail: messageOf(error) };
    }
  }

  return {
    status,
    startLogin,
    cancelLogin,
    callback,
    logout,
    accessToken,
    refreshAccessToken,
    models,
    catalog,
    validate,
    /** The gateway saw "usage limit reached": the window says so until a request succeeds. */
    noteUsageLimit: () => {
      usageLimitAt = now();
    },
    noteSuccess: () => {
      usageLimitAt = undefined;
    },
  };
}

export type ChatGptSession = ReturnType<typeof createChatGpt>;
