import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_SCOPE } from "./constants.js";
import { createChatGpt } from "./session.js";
import { chatGptFile, readChatGpt, writeChatGpt } from "./store.js";

const ISSUER = "https://auth.openai.com";
const ALL_SCOPES = "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function idToken(claims: Record<string, unknown>, key: KeyObject = privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: ISSUER, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString("base64url");
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key).toString("base64url")}`;
}

type Reply = { status: number; body?: unknown; delayMs?: number };
type Seen = { path: string; form: Record<string, string>; auth?: string };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** OpenAI's auth server and API, as far as the sign-in uses them. */
async function fakeOpenAI(handlers: { token?: (form: Record<string, string>) => Reply; revoke?: (form: Record<string, string>) => Reply; models?: (auth?: string) => Reply } = {}) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const path = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ path, form, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    const reply: Reply =
      path === "/jwks"
        ? { status: 200, body: { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] } }
        : path === "/token" && handlers.token
          ? handlers.token(form)
          : path === "/revoke"
            ? (handlers.revoke?.(form) ?? { status: 200 })
            : path === "/v1/models" && handlers.models
              ? handlers.models(req.headers.authorization)
              : { status: 404, body: { error: "not found" } };
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body === undefined ? "" : JSON.stringify(reply.body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    seen,
    endpoints: { issuer: ISSUER, authorize: `${base}/authorize`, token: `${base}/token`, revoke: `${base}/revoke`, jwks: `${base}/jwks`, api: `${base}/v1` },
  };
}

const dataDir = () => mkdtempSync(join(tmpdir(), "kv-chatgpt-"));
const REDIRECT = "http://127.0.0.1:4202/auth/callback";

/** A signed-in session on disk, its access token ending in `leftMs`. */
function seed(dir: string, leftMs: number, scopes = ALL_SCOPES.split(" ")) {
  writeChatGpt(dir, {
    version: 1,
    hostId: "urn:uuid:5b9cfb1e-6e8a-4d5c-9d47-1e0b6f1f4a11",
    registrations: [{ clientId: "oaiapp_1", subject: "user-1", email: "ada@example.com", registeredAt: "2026-10-01T00:00:00.000Z" }],
    active: "oaiapp_1",
    tokens: { accessToken: "old-at", refreshToken: "rt-1", idToken: "the-id-token", tokenType: "Bearer", expiresAt: new Date(Date.now() + leftMs).toISOString(), scopes, savedAt: "2026-10-09T00:00:00.000Z" },
  });
}

describe("Sign in with ChatGPT", () => {
  it("registers the app on the first sign-in: PKCE link → loopback callback → code exchange → verified ID token → tokens saved 0600", async () => {
    let link!: URL;
    const fake = await fakeOpenAI({
      token: (form) => {
        // PKCE: the verifier sent now hashes to the challenge the link carried.
        const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
        if (challenge !== link.searchParams.get("code_challenge")) return { status: 400, body: { error: "invalid_grant" } };
        return {
          status: 200,
          body: { access_token: "at-1", refresh_token: "rt-1", id_token: idToken({ aud: "oaiapp_123", sub: "user-1", email: "ada@example.com", nonce: link.searchParams.get("nonce") }), token_type: "Bearer", expires_in: 3600, scope: ALL_SCOPES },
        };
      },
    });
    const dir = dataDir();
    const chatgpt = createChatGpt({ dataDir: dir, endpoints: fake.endpoints });
    const { url } = chatgpt.startLogin({ redirectUri: REDIRECT });
    link = new URL(url);
    expect(`${link.origin}${link.pathname}`).toBe(fake.endpoints.authorize);
    expect(Object.fromEntries(link.searchParams)).toEqual({
      response_type: "code",
      client_id: "dynamic_agent_client",
      agent_name_hint: "Knowledge Vault",
      ext_agent_host_id: expect.stringMatching(/^urn:uuid:[0-9a-f-]{36}$/),
      redirect_uri: REDIRECT,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: "https://api.openai.com/v1",
      state: expect.any(String),
      nonce: expect.any(String),
      code_challenge_method: "S256",
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(url).not.toContain("+"); // every value percent-encoded
    expect(chatgpt.status().pending?.url).toBe(url);

    const back = new URLSearchParams({ code: "code-1", state: link.searchParams.get("state")!, client_id: "oaiapp_123", scope: ALL_SCOPES });
    const page = await chatgpt.callback(back);
    expect(page.status).toBe(200);
    expect(page.html).toContain("Signed in with ChatGPT");
    expect(fake.seen.find((r) => r.path === "/token")?.form).toEqual({
      grant_type: "authorization_code",
      client_id: "oaiapp_123",
      code: "code-1",
      code_verifier: expect.any(String),
      redirect_uri: REDIRECT,
      resource: "https://api.openai.com/v1",
    });
    const status = chatgpt.status();
    expect(status).toMatchObject({ signedIn: true, planUsage: true, account: { email: "ada@example.com" }, firstSignIn: true, pending: null });
    expect(JSON.stringify(status)).not.toMatch(/at-1|rt-1/);
    if (process.platform !== "win32") expect(statSync(chatGptFile(dir)).mode & 0o777).toBe(0o600);
    expect(readChatGpt(dir)).toMatchObject({
      hostId: link.searchParams.get("ext_agent_host_id"),
      active: "oaiapp_123",
      registrations: [{ clientId: "oaiapp_123", subject: "user-1", email: "ada@example.com" }],
      tokens: { accessToken: "at-1", refreshToken: "rt-1", scopes: ALL_SCOPES.split(" ") },
    });
    expect(await chatgpt.accessToken()).toBe("at-1");
    // The tab reloaded: the same answer, no second exchange.
    expect((await chatgpt.callback(back)).status).toBe(200);
    expect(fake.seen.filter((r) => r.path === "/token")).toHaveLength(1);
  });

  it("keeps a sign-in without the plan permission, runs nothing on it, and asks again with the saved client", async () => {
    let link!: URL;
    const fake = await fakeOpenAI({
      token: () => ({ status: 200, body: { access_token: "at-1", refresh_token: "rt-1", id_token: idToken({ aud: "oaiapp_123", sub: "user-1", email: "ada@example.com", nonce: link.searchParams.get("nonce") }), expires_in: 3600, scope: "openid profile email offline_access" } }),
    });
    const chatgpt = createChatGpt({ dataDir: dataDir(), endpoints: fake.endpoints });
    link = new URL(chatgpt.startLogin({ redirectUri: REDIRECT }).url);
    const page = await chatgpt.callback(new URLSearchParams({ code: "c", state: link.searchParams.get("state")!, client_id: "oaiapp_123" }));
    expect(page.html).toContain("without your plan");
    expect(chatgpt.status()).toMatchObject({ signedIn: true, planUsage: false });
    await expect(chatgpt.accessToken()).rejects.toMatchObject({ status: 403, code: "chatgpt_plan_not_allowed" });
    const again = new URL(chatgpt.startLogin({ redirectUri: REDIRECT, allowPlanUsage: true }).url).searchParams;
    expect(again.get("client_id")).toBe("oaiapp_123");
    expect(again.get("agent_name_hint")).toBeNull();
    expect(again.get("login_hint")).toBe("ada@example.com");
    expect(again.get("prompt")).toBe("consent");
    expect(again.get("id_token_hint")).toBeNull(); // the link is shown to the window: no token in it
    expect(again.get("ext_agent_host_id")).toBe(link.searchParams.get("ext_agent_host_id"));
  });

  it("refuses an answer it cannot trust: another state, a declined consent, an ID token for another sign-in or signed by another key", async () => {
    let link!: URL;
    let token = (nonce: string | null) => idToken({ aud: "oaiapp_123", sub: "user-1", nonce: `${nonce}-other` });
    const fake = await fakeOpenAI({ token: () => ({ status: 200, body: { access_token: "at-1", refresh_token: "rt-1", id_token: token(link.searchParams.get("nonce")), expires_in: 3600, scope: ALL_SCOPES } }) });
    const dir = dataDir();
    const chatgpt = createChatGpt({ dataDir: dir, endpoints: fake.endpoints, sleep: async () => {} });

    link = new URL(chatgpt.startLogin({ redirectUri: REDIRECT }).url);
    expect((await chatgpt.callback(new URLSearchParams({ code: "c", state: "forged", client_id: "oaiapp_123" }))).status).toBe(404);

    const declined = await chatgpt.callback(new URLSearchParams({ error: "access_denied", state: link.searchParams.get("state")! }));
    expect(declined.status).toBe(400);
    expect(chatgpt.status().lastError).toMatch(/declined/);
    expect(fake.seen.some((r) => r.path === "/token")).toBe(false);

    link = new URL(chatgpt.startLogin({ redirectUri: REDIRECT }).url);
    expect((await chatgpt.callback(new URLSearchParams({ code: "c", state: link.searchParams.get("state")!, client_id: "oaiapp_123" }))).status).toBe(400);
    expect(chatgpt.status()).toMatchObject({ signedIn: false, lastError: expect.stringContaining("another sign-in") });

    token = (nonce) => idToken({ aud: "oaiapp_123", sub: "user-1", nonce }, other.privateKey);
    link = new URL(chatgpt.startLogin({ redirectUri: REDIRECT }).url);
    await chatgpt.callback(new URLSearchParams({ code: "c", state: link.searchParams.get("state")!, client_id: "oaiapp_123" }));
    expect(chatgpt.status()).toMatchObject({ signedIn: false, lastError: expect.stringContaining("signature") });
    expect(readChatGpt(dir)?.tokens).toBeUndefined();
    // The tokens it could not trust are revoked at OpenAI.
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.seen.filter((r) => r.path === "/revoke").map((r) => r.form.token)).toEqual(["rt-1", "rt-1"]);
  });
});

describe("the ChatGPT session", () => {
  it("renews near the end of the hour — once for every caller at the same time — and keeps the rotated refresh token", async () => {
    const fake = await fakeOpenAI({ token: () => ({ status: 200, delayMs: 30, body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600, scope: ALL_SCOPES } }) });
    const dir = dataDir();
    seed(dir, 60_000); // a minute left: inside the five-minute margin
    const chatgpt = createChatGpt({ dataDir: dir, endpoints: fake.endpoints });
    expect(await Promise.all([chatgpt.accessToken(), chatgpt.accessToken(), chatgpt.accessToken()])).toEqual(["at-2", "at-2", "at-2"]);
    const renewals = fake.seen.filter((r) => r.path === "/token");
    expect(renewals.map((r) => r.form)).toEqual([{ grant_type: "refresh_token", client_id: "oaiapp_1", refresh_token: "rt-1", resource: "https://api.openai.com/v1" }]);
    expect(readChatGpt(dir)?.tokens).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2", idToken: "the-id-token" });
    expect(await chatgpt.accessToken()).toBe("at-2");
    expect(fake.seen.filter((r) => r.path === "/token")).toHaveLength(1);
    // A request refused with the old token does not renew a second time.
    expect(await chatgpt.refreshAccessToken("old-at")).toBe("at-2");
    expect(fake.seen.filter((r) => r.path === "/token")).toHaveLength(1);
  });

  it("a refresh token refused for good ends the session but keeps the account for the next sign-in", async () => {
    const fake = await fakeOpenAI({ token: () => ({ status: 400, body: { error: "refresh_token_reused", error_description: "reused" } }) });
    const dir = dataDir();
    seed(dir, 10_000);
    const chatgpt = createChatGpt({ dataDir: dir, endpoints: fake.endpoints });
    await expect(chatgpt.accessToken()).rejects.toMatchObject({ status: 401, code: "chatgpt_signed_out", message: expect.stringContaining("has ended") });
    expect(chatgpt.status()).toMatchObject({ signedIn: false, savedAccount: { email: "ada@example.com" }, lastError: expect.stringContaining("has ended") });
    expect(readChatGpt(dir)).toMatchObject({ active: "oaiapp_1", registrations: [{ clientId: "oaiapp_1" }] });
    expect(readChatGpt(dir)?.tokens).toBeUndefined();
  });

  it("a passing failure keeps the credentials, and a token that still works is used", async () => {
    const fake = await fakeOpenAI({ token: () => ({ status: 503, body: { error: "temporarily_unavailable" } }) });
    const dir = dataDir();
    seed(dir, 120_000);
    const chatgpt = createChatGpt({ dataDir: dir, endpoints: fake.endpoints });
    expect(await chatgpt.accessToken()).toBe("old-at");
    seed(dir, -1000); // already ended: nothing usable, but still signed in
    await expect(chatgpt.accessToken()).rejects.toMatchObject({ status: 503, code: "chatgpt_unavailable" });
    expect(readChatGpt(dir)?.tokens?.refreshToken).toBe("rt-1");
  });

  it("signs out: revokes the refresh token, forgets the tokens, keeps the account; signing in again reuses its client", async () => {
    const fake = await fakeOpenAI();
    const dir = dataDir();
    seed(dir, 3_600_000);
    const chatgpt = createChatGpt({ dataDir: dir, endpoints: fake.endpoints });
    expect(await chatgpt.logout()).toEqual({ revoked: true });
    expect(fake.seen.find((r) => r.path === "/revoke")?.form).toEqual({ token: "rt-1", token_type_hint: "refresh_token", client_id: "oaiapp_1" });
    expect(chatgpt.status()).toMatchObject({ signedIn: false, planUsage: false, savedAccount: { email: "ada@example.com" } });
    await expect(chatgpt.accessToken()).rejects.toMatchObject({ status: 401, code: "chatgpt_signed_out" });
    const again = new URL(chatgpt.startLogin({ redirectUri: REDIRECT }).url).searchParams;
    expect([again.get("client_id"), again.get("login_hint"), again.get("agent_name_hint")]).toEqual(["oaiapp_1", "ada@example.com", null]);
    expect(new URL(chatgpt.startLogin({ redirectUri: REDIRECT, newAccount: true }).url).searchParams.get("client_id")).toBe("dynamic_agent_client");
  });

  it("an unconfirmed revocation still signs out here, and says so", async () => {
    const fake = await fakeOpenAI({ revoke: () => ({ status: 503 }) });
    const dir = dataDir();
    seed(dir, 3_600_000);
    const chatgpt = createChatGpt({ dataDir: dir, endpoints: fake.endpoints, sleep: async () => {} });
    expect(await chatgpt.logout()).toEqual({ revoked: false });
    expect(fake.seen.filter((r) => r.path === "/revoke")).toHaveLength(3);
    expect(readChatGpt(dir)?.tokens).toBeUndefined();
  });

  it("lists the account's models meant for a picker, in ChatGPT's order", async () => {
    const fake = await fakeOpenAI({
      models: (auth) =>
        auth === "Bearer old-at"
          ? { status: 200, body: { models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }, { slug: "internal", display_name: "Internal", visibility: "hide" }, { slug: "gpt-6-mini", display_name: "GPT-6 mini", visibility: "list" }] } }
          : { status: 401, body: { error: { message: "bad token" } } },
    });
    const dir = dataDir();
    seed(dir, 3_600_000);
    const chatgpt = createChatGpt({ dataDir: dir, endpoints: fake.endpoints });
    expect(await chatgpt.models()).toEqual([{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }, { slug: "gpt-6-mini", name: "GPT-6 mini" }]);
    expect(await chatgpt.catalog()).toEqual({ ok: true, models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", free: false }, { id: "gpt-6-mini", name: "GPT-6 mini", free: false }] });
    seed(dir, 3_600_000, ["openid", "email"]); // signed in, plan use not allowed
    expect(await chatgpt.catalog()).toEqual({ ok: false, detail: expect.stringContaining("not allowed to use your ChatGPT plan") });
    expect(PLAN_SCOPE).toBe("chatgpt.tokens.use.direct");
  });
});

describe("the credential file", () => {
  it("is written whole and owner-only", () => {
    const dir = dataDir();
    seed(dir, 1000);
    expect(JSON.parse(readFileSync(chatGptFile(dir), "utf8"))).toMatchObject({ version: 1, active: "oaiapp_1" });
    if (process.platform !== "win32") expect(statSync(chatGptFile(dir)).mode & 0o777).toBe(0o600);
  });
});
