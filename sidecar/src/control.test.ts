import { ConnectionError } from "./connections.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConverterBusyError, ConverterInputError } from "./converter.js";
import { createControlServer } from "./control.js";
import { SettingsError, type AppSettings } from "./settings.js";
import { RemoteAuthError, RemoteInputError, type RemoteVault } from "./remote.js";
import { NotAVaultError, type VaultSummary } from "./vaults.js";

const vaults: VaultSummary[] = [{ id: "v1", slug: "research", name: "Research", noteCount: 2 }];
let close: (() => Promise<void>) | undefined;
let deleted: string[] = [];
let signedIn = false;
let remotes: RemoteVault[] = [];
let settings: AppSettings = { version: 1, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, local: false, provider: "openrouter" }, conversion: { mode: "local", remoteUrl: "" }, ui: { closeToTray: true } };
let applied: AppSettings["conversion"][] = [];
let restarted = 0;
const converterStatus = { mode: "local" as const, state: "ready" as const, url: "http://127.0.0.1:5999", localUrl: "http://127.0.0.1:5999", pid: 4242, exitCode: null, restarts: 0, logPath: "/data/vault/logs/converter.log", health: { ok: true, binding: false }, error: null, installed: { binding: { installed: false, version: null, supported: true, platform: "linux-x64-gnu" as const, reason: null }, models: { installed: false } }, job: null };
let installed: string[] = [];
let protection: { protected: boolean; adminAddress: string | null } = { protected: false, adminAddress: null };
let restartsRequested = 0;
let expired = false;
let modelKey = false;
let removedPipelines: string[] = [];
let disabledFor: string[] = [];
let modelsApplied = 0;
let scheduled: unknown[] = [];
let shutdowns = 0;
let debugRoutes = false;
let settingsPatches: unknown[] = [];
let gatewayCalls: Array<{ url: string; body: string }> = [];
afterEach(async () => { await close?.(); close = undefined; deleted = []; signedIn = false; remotes = []; applied = []; restarted = 0; installed = []; protection = { protected: false, adminAddress: null }; restartsRequested = 0; expired = false; modelKey = false; removedPipelines = []; disabledFor = []; modelsApplied = 0; scheduled = []; shutdowns = 0; debugRoutes = false; settingsPatches = []; gatewayCalls = []; settings = { version: 1, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, local: false, provider: "openrouter" }, conversion: { mode: "local", remoteUrl: "" }, ui: { closeToTray: true } }; });

async function start() {
  const server = createControlServer(await harnessDeps());
  const port = await server.listen();
  close = server.close;
  return `http://127.0.0.1:${port}`;
}
async function harnessDeps(): Promise<Parameters<typeof createControlServer>[0]> {
  return ({
    token: "secret",
    gatewayKey: "gw-key",
    gateway: { handle: async (req, res, body, cors) => { gatewayCalls.push({ url: req.url ?? "", body: body.toString() }); res.writeHead(200, { "content-type": "application/json", ...cors }).end('{"ok":true}'); } },
    hostOrigin: "http://127.0.0.1:4200",
    status: () => ({ ok: true, port: 4201, controlPort: 0, appVersion: "0.1.0", protected: false, dataDir: "/data/vault", stackVersion: "6.2.3-dev.44", vaultPackageVersion: "1.0.54-dev.22" }),
    listVaults: async () => vaults,
    createVault: async (name) => ({ id: "v2", slug: "n", name, noteCount: 0 }),
    renameVault: async (id, name) => { if (id !== "v1") throw new NotAVaultError("That drive is not a vault."); return { id, slug: "research", name }; },
    deleteVault: async (id) => { if (id !== "v1") throw new NotAVaultError("That drive is not a vault."); deleted.push(id); },
    workflowsDrive: async () => ({ id: "w1", slug: "workflows", name: "Workflows" }),
    auth: {
      status: async () => ({ authenticated: signedIn, address: signedIn ? "0xabc" : undefined, appDid: "did:key:z6Mk-app", renownUrl: "https://www.renown.id", pending: null }),
      startLogin: async () => (signedIn ? { alreadyAuthenticated: true } : { url: "https://www.renown.id/#/login?session=abc", alreadyAuthenticated: false }),
      cancelLogin: () => {},
      logout: async () => { signedIn = false; },
      token: async () => { if (expired) throw new Error("Your sign-in expired. Sign in again."); if (!signedIn) throw new Error("Not authenticated"); return { token: "jwt", expiresAt: "2026-10-06T13:00:00.000Z", address: "0xabc", did: "did:key:z6Mk-app" }; },
    },
    remote: {
      list: () => remotes,
      check: async (url, drive) => { if (!url.startsWith("http")) throw new RemoteInputError("Enter the vault's address as a URL."); if (!signedIn) throw new RemoteAuthError("Sign in first."); return { id: "c589", slug: drive ?? "pk", name: "powerhouse-knowledge", switchboardUrl: new URL(url).origin, access: "write" }; },
      add: async (url, drive) => { const v: RemoteVault = { kind: "remote", id: "c589", slug: drive ?? "pk", name: "powerhouse-knowledge", switchboardUrl: new URL(url).origin, addedAt: "2026-10-06T12:00:00.000Z" }; remotes = [v]; return v; },
      remove: (id) => { remotes = remotes.filter((v) => v.id !== id); },
    },
    validateModels: async () => ({ ok: true, detail: "3 models available" }),
    probeModels: async (endpoint: string) => (endpoint.includes("127.0.0.1") ? { ok: true, endpoint, models: ["lfm2.5-8b-a1b"] } : { ok: false, endpoint, detail: "Only a server on this computer or your local network can be used here." }),
    repairQueue: async (vaultId: string) => (vaultId === "v1" ? { requeued: ["Foreword"], dropped: ["Old"] } : { requeued: [], dropped: [], skipped: "no pipeline" }),
    modelCatalog: async (endpoint?: string) => ({ ok: true, models: [{ id: "a", name: "A", free: false }], endpoint: endpoint ?? "saved" }),
    fillConnection: async (id, opts) => {
      if (id !== "c1") throw new ConnectionError("Only a Knowledge Vault connection can be filled from this app.");
      if (opts.token && !signedIn) throw new SettingsError("Sign in first — on a protected engine the pipeline runs as you.");
      return { baseUrl: "http://127.0.0.1:4201", token: opts.token ? { kind: "minted" as const, expiresAt: "2027-01-05T00:00:00.000Z" } : null };
    },
    pipelines: {
      ensure: async (id: string) => (modelKey ? { state: "ready" as const, workflowId: `wf-${id}`, connectionId: `conn-${id}` } : { state: "unconfigured" as const }),
      status: async (id: string) => (modelKey ? { state: "ready" as const, workflowId: `wf-${id}`, connectionId: `conn-${id}`, trigger: { status: "ENABLED", lastPollAt: null, lastError: null } } : { state: "unconfigured" as const }),
      remove: async (id: string) => { removedPipelines.push(id); },
      disableAll: async (reason: string) => { disabledFor.push(reason); },
      applyModels: async () => { modelsApplied += 1; return { updated: [], recreated: [] }; },
    },
    protection: {
      get: () => protection,
      set: async (p: boolean) => {
        if (p && !signedIn) throw new SettingsError("Sign in first — protection makes your Renown identity the vaults' administrator.");
        protection = { protected: p, adminAddress: p ? "0xabc" : protection.adminAddress };
        restartsRequested += 1;
        return protection;
      },
    },
    readSettings: () => settings,
    writeSettings: (patch) => { settingsPatches.push(patch); settings = { ...settings, models: { ...settings.models, ...(patch.models?.endpoint ? { endpoint: patch.models.endpoint } : {}), ...(patch.models?.model !== undefined ? { model: patch.models.model } : {}), ...(patch.models?.apiKey !== undefined ? { hasKey: !!patch.models.apiKey } : {}) }, conversion: { ...settings.conversion, ...(patch.conversion ?? {}) } }; return settings; },
    converter: {
      status: async () => converterStatus,
      restart: async () => { restarted += 1; return converterStatus; },
      install: async (c) => { if (c === "models") throw new ConverterBusyError("Already installing the binding."); if (c !== "binding") throw new ConverterInputError("Unknown component."); installed.push(c); return { ...converterStatus, job: { component: "binding" as const, phase: "downloading" as const, percent: 42, bytes: 42, total: 100, message: "Downloading…", error: null, startedAt: "2026-10-06T00:00:00.000Z", finishedAt: null } }; },
      remove: async (c) => { installed = installed.filter((x) => x !== c); return converterStatus; },
    },
    applyConversion: async (c) => { applied.push(c); },
    maintenance: {
      listBackups: () => [{ name: "2026-10-07T12-00-00Z-6.2.3-dev.44", path: "/data/vault/backups/2026-10-07T12-00-00Z-6.2.3-dev.44", bytes: 1500, stackVersion: "6.2.3-dev.44", createdAt: "2026-10-07T12:00:00.000Z" }],
      lastAction: () => ({ action: "backup", ok: true, detail: "Backed up 1500 bytes.", at: "2026-10-07T12:00:01.000Z" }),
      schedule: (action) => { scheduled.push(action); },
    },
    shutdown: () => { shutdowns += 1; },
    exportVault: async (id) => { if (id !== "v1") throw new NotAVaultError("That drive is not a vault."); return { path: "/data/vault/exports/research-2026-10-07T12-00-00Z", documents: 2, bytes: 4096 }; },
    logsTail: () => ["line one", "line two"],
    debugRoutes,
  });
}

describe("control API", () => {
  it("rejects a missing or wrong token", async () => {
    const base = await start();
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
  it("answers status, lists and creates vaults with the token", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    expect(await (await fetch(`${base}/status`, { headers: h })).json()).toMatchObject({ ok: true, port: 4201 });
    expect(await (await fetch(`${base}/vaults`, { headers: h })).json()).toEqual({ vaults });
    const created = await fetch(`${base}/vaults`, { method: "POST", headers: h, body: JSON.stringify({ name: "New" }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ vault: { id: "v2", slug: "n", name: "New", noteCount: 0 }, pipeline: { state: "unconfigured" } });
  });
  it("rejects a vault without a name", async () => {
    const base = await start();
    const res = await fetch(`${base}/vaults`, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ name: "  " }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "A vault needs a name." });
  });
  it("rejects a wrong token of the right length too (constant-time compare, same answer)", async () => {
    const base = await start();
    expect((await fetch(`${base}/status`, { headers: { authorization: "Bearer secreT" } })).status).toBe(401);
  });
  it("answers a malformed JSON body with 400, not 500", async () => {
    const base = await start();
    const res = await fetch(`${base}/vaults`, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: "{ not json" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/JSON/);
  });
  it("marks CORS answers as varying by origin", async () => {
    const base = await start();
    const res = await fetch(`${base}/status`, { headers: { authorization: "Bearer secret", origin: "http://127.0.0.1:4200" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4200");
    expect(res.headers.get("vary")).toBe("Origin");
  });
  it("answers CORS preflight for the host origin only", async () => {
    const base = await start();
    const ok = await fetch(`${base}/vaults`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:4200", "access-control-request-method": "POST" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:4200");
    const other = await fetch(`${base}/vaults`, { method: "OPTIONS", headers: { origin: "http://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("renames and deletes a vault, and answers 404 for a drive that is not a vault", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    const renamed = await fetch(`${base}/vaults/v1`, { method: "PATCH", headers: h, body: JSON.stringify({ name: "  Lab notes " }) });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ vault: { id: "v1", slug: "research", name: "Lab notes" } });
    expect((await fetch(`${base}/vaults/v1`, { method: "PATCH", headers: h, body: JSON.stringify({ name: " " }) })).status).toBe(400);
    const gone = await fetch(`${base}/vaults/v1`, { method: "DELETE", headers: h });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ deleted: "v1" });
    expect(deleted).toEqual(["v1"]);
    const refused = await fetch(`${base}/vaults/w1`, { method: "DELETE", headers: h });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "That drive is not a vault." });
  });
  it("hands out the Workflows drive and reads and writes settings without ever returning a key", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    expect(await (await fetch(`${base}/workflows`, { headers: h })).json()).toEqual({ drive: { id: "w1", slug: "workflows", name: "Workflows" } });
    expect(await (await fetch(`${base}/settings`, { headers: h })).json()).toMatchObject({ version: 1, models: { hasKey: false } });
    const saved = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ models: { model: "gpt-4o-mini", apiKey: "sk-x" } }) });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as AppSettings;
    expect(body.models).toEqual({ endpoint: "https://openrouter.ai/api/v1", model: "gpt-4o-mini", hasKey: true, local: false, provider: "openrouter" });
    expect(JSON.stringify(body)).not.toContain("sk-x");
    expect((await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ models: { apiKey: 42 } }) })).status).toBe(400);
  });
  it("forwards a provider to writeSettings, and answers 400 for a provider that is not a fixed service", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    const ok = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ models: { provider: "gemini" } }) });
    expect(ok.status).toBe(200);
    expect(settingsPatches).toEqual([{ models: { provider: "gemini" } }]);
    const bad = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ models: { provider: "constructor" } }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "`models.provider` must be one of: openrouter, openai, anthropic, gemini, xai." });
    expect(settingsPatches).toHaveLength(1);
  });
  it("allows the management methods in the CORS preflight", async () => {
    const base = await start();
    const res = await fetch(`${base}/vaults/v1`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:4200", "access-control-request-method": "DELETE" } });
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,PATCH,PUT,DELETE,OPTIONS");
  });

  it("drives the sign-in flow: status, login URL, a token only once signed in, sign-out", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    expect(await (await fetch(`${base}/auth/status`, { headers: h })).json()).toMatchObject({ authenticated: false, pending: null });
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: h });
    expect(login.status).toBe(202);
    expect(await login.json()).toEqual({ url: "https://www.renown.id/#/login?session=abc", alreadyAuthenticated: false });
    expect((await fetch(`${base}/auth/token`, { headers: h })).status).toBe(401);
    signedIn = true;
    expect(await (await fetch(`${base}/auth/token`, { headers: h })).json()).toMatchObject({ token: "jwt", address: "0xabc" });
    expect((await fetch(`${base}/auth/logout`, { method: "POST", headers: h })).status).toBe(200);
    expect(signedIn).toBe(false);
  });
  it("checks, adds, lists and removes remote vaults, mapping refusals to their status", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    expect((await fetch(`${base}/remote-vaults/check`, { method: "POST", headers: h, body: JSON.stringify({ url: "not a url" }) })).status).toBe(400);
    expect((await fetch(`${base}/remote-vaults/check`, { method: "POST", headers: h, body: JSON.stringify({ url: "https://s.example.com/graphql", drive: "pk" }) })).status).toBe(401);
    signedIn = true;
    const checked = await fetch(`${base}/remote-vaults/check`, { method: "POST", headers: h, body: JSON.stringify({ url: "https://s.example.com/graphql", drive: "pk" }) });
    expect(await checked.json()).toEqual({ vault: { id: "c589", slug: "pk", name: "powerhouse-knowledge", switchboardUrl: "https://s.example.com", access: "write" } });
    const added = await fetch(`${base}/remote-vaults`, { method: "POST", headers: h, body: JSON.stringify({ url: "https://s.example.com/d/pk" }) });
    expect(added.status).toBe(201);
    expect(((await (await fetch(`${base}/remote-vaults`, { headers: h })).json()) as { vaults: RemoteVault[] }).vaults).toHaveLength(1);
    expect((await fetch(`${base}/remote-vaults/c589`, { method: "DELETE", headers: h })).status).toBe(200);
    expect(remotes).toEqual([]);
  });

  it("reports the converter and restarts it", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    expect(await (await fetch(`${base}/converter`, { headers: h })).json()).toMatchObject({ mode: "local", state: "ready", url: "http://127.0.0.1:5999", health: { binding: false } });
    expect((await fetch(`${base}/converter/restart`, { method: "POST", headers: h })).status).toBe(200);
    expect(restarted).toBe(1);
  });
  it("applies a conversion setting right after saving it, and refuses a malformed one", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    const res = await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ conversion: { mode: "remote", remoteUrl: "http://10.0.0.5:5011" } }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AppSettings).conversion).toEqual({ mode: "remote", remoteUrl: "http://10.0.0.5:5011" });
    expect(applied).toEqual([{ mode: "remote", remoteUrl: "http://10.0.0.5:5011" }]);
    expect((await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ conversion: { mode: 7 } }) })).status).toBe(400);
    expect((await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ models: { model: "x" } }) })).status).toBe(200);
    expect(applied).toHaveLength(1); // a models-only save does not touch the converter
  });

  it("starts an install as a job (202), refuses a second while busy (409), rejects nonsense (400), and removes", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    const res = await fetch(`${base}/converter/install`, { method: "POST", headers: h, body: JSON.stringify({ component: "binding" }) });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { job: { phase: string; percent: number } }).job).toMatchObject({ phase: "downloading", percent: 42 });
    expect(installed).toEqual(["binding"]);
    expect((await fetch(`${base}/converter/install`, { method: "POST", headers: h, body: JSON.stringify({ component: "models" }) })).status).toBe(409);
    expect((await fetch(`${base}/converter/install`, { method: "POST", headers: h, body: JSON.stringify({ component: "docker" }) })).status).toBe(400);
    expect((await fetch(`${base}/converter/install`, { method: "POST", headers: h, body: "{}" })).status).toBe(400);
    expect((await fetch(`${base}/converter/remove`, { method: "POST", headers: h, body: JSON.stringify({ component: "binding" }) })).status).toBe(200);
    expect(installed).toEqual([]);
  });
});

describe("local protection", () => {
  const h = { authorization: "Bearer secret", "content-type": "application/json" };
  it("reports the switch and refuses to protect without a sign-in", async () => {
    const base = await start();
    expect(await (await fetch(`${base}/local/protection`, { headers: h })).json()).toEqual({ protected: false, adminAddress: null });
    const refused = await fetch(`${base}/local/protection`, { method: "PUT", headers: h, body: JSON.stringify({ protected: true }) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Sign in first — protection makes your Renown identity the vaults' administrator." });
    expect(restartsRequested).toBe(0);
  });
  it("switches protection on for the signed-in administrator and announces the restart", async () => {
    signedIn = true;
    const base = await start();
    const res = await fetch(`${base}/local/protection`, { method: "PUT", headers: h, body: JSON.stringify({ protected: true }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ restarting: true, protected: true, adminAddress: "0xabc" });
    expect(restartsRequested).toBe(1);
    expect(await (await fetch(`${base}/local/protection`, { headers: h })).json()).toEqual({ protected: true, adminAddress: "0xabc" });
  });
  it("wants a boolean", async () => {
    const base = await start();
    const res = await fetch(`${base}/local/protection`, { method: "PUT", headers: h, body: JSON.stringify({ protected: "yes" }) });
    expect(res.status).toBe(400);
  });
});

describe("identity — expiry over the control API", () => {
  it("answers 401 with the sentence when the credential expired", async () => {
    signedIn = true; expired = true;
    const base = await start();
    const res = await fetch(`${base}/auth/token`, { headers: { authorization: "Bearer secret" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Your sign-in expired. Sign in again." });
  });
});

describe("pipelines over the control API", () => {
  const h = { authorization: "Bearer secret", "content-type": "application/json" };
  it("creating a vault reports its pipeline — unconfigured until a model is set up", async () => {
    const base = await start();
    const created = await fetch(`${base}/vaults`, { method: "POST", headers: h, body: JSON.stringify({ name: "New" }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ vault: { id: "v2", slug: "n", name: "New", noteCount: 0 }, pipeline: { state: "unconfigured" } });
    const explicit = await fetch(`${base}/vaults/v2/pipeline`, { method: "POST", headers: h });
    expect(explicit.status).toBe(409);
    expect(await explicit.json()).toEqual({ error: "Set up a model first — Settings › Models." });
    expect(await (await fetch(`${base}/vaults/v2/pipeline`, { headers: h })).json()).toEqual({ pipeline: { state: "unconfigured" } });
  });
  it("with a model configured: created ready, re-creatable, readable; deleting the vault removes its pipeline", async () => {
    modelKey = true;
    const base = await start();
    const created = await fetch(`${base}/vaults`, { method: "POST", headers: h, body: JSON.stringify({ name: "New" }) });
    expect((await created.json()).pipeline).toEqual({ state: "ready", workflowId: "wf-v2", connectionId: "conn-v2" });
    const again = await fetch(`${base}/vaults/v2/pipeline`, { method: "POST", headers: h });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ pipeline: { state: "ready", workflowId: "wf-v2", connectionId: "conn-v2" } });
    expect((await (await fetch(`${base}/vaults/v1/pipeline`, { headers: h })).json()).pipeline.trigger.status).toBe("ENABLED");
    await fetch(`${base}/vaults/v1`, { method: "DELETE", headers: h });
    expect(removedPipelines).toEqual(["v1"]);
  });
});

describe("filling a Knowledge Vault connection over the control API", () => {
  const h = { authorization: "Bearer secret", "content-type": "application/json" };
  it("fills the address, the token when asked, and refuses other connections", async () => {
    const base = await start();
    const url = await fetch(`${base}/connections/c1/fill`, { method: "POST", headers: h, body: "{}" });
    expect(await url.json()).toEqual({ connection: { baseUrl: "http://127.0.0.1:4201", token: null } });
    signedIn = true;
    const withToken = await fetch(`${base}/connections/c1/fill`, { method: "POST", headers: h, body: JSON.stringify({ token: true }) });
    expect((await withToken.json()).connection.token).toEqual({ kind: "minted", expiresAt: "2027-01-05T00:00:00.000Z" });
    const other = await fetch(`${base}/connections/mail/fill`, { method: "POST", headers: h, body: "{}" });
    expect(other.status).toBe(400);
    expect(await other.json()).toEqual({ error: "Only a Knowledge Vault connection can be filled from this app." });
  });
});

describe("model validation over the control API", () => {
  const h = { authorization: "Bearer secret", "content-type": "application/json" };
  it("needs a stored key, then answers the provider's verdict", async () => {
    const base = await start();
    const none = await fetch(`${base}/settings/models/validate`, { method: "POST", headers: h });
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: "Save a key first." });
    settings = { ...settings, models: { ...settings.models, hasKey: true } };
    const ok = await fetch(`${base}/settings/models/validate`, { method: "POST", headers: h });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, detail: "3 models available" });
  });
  it("lists the provider's models for the picker with the saved key, following the form's endpoint when given", async () => {
    const base = await start();
    const none = await fetch(`${base}/settings/models/catalog`, { headers: h });
    expect(none.status).toBe(400);
    settings = { ...settings, models: { ...settings.models, hasKey: true } };
    const saved = await fetch(`${base}/settings/models/catalog`, { headers: h });
    expect(await saved.json()).toMatchObject({ ok: true, endpoint: "saved", models: [{ id: "a" }] });
    const typed = await fetch(`${base}/settings/models/catalog?endpoint=${encodeURIComponent("http://127.0.0.1:11434/v1")}`, { headers: h });
    expect(await typed.json()).toMatchObject({ endpoint: "http://127.0.0.1:11434/v1" });
  });
});

describe("a local model server", () => {
  const h = { authorization: "Bearer secret", "content-type": "application/json" };
  it("is probed by address before it is saved, and needs no key to be validated or listed", async () => {
    const base = await start();
    const probe = await fetch(`${base}/settings/models/probe?endpoint=${encodeURIComponent("http://127.0.0.1:8080/v1")}`, { headers: h });
    expect(await probe.json()).toEqual({ ok: true, endpoint: "http://127.0.0.1:8080/v1", models: ["lfm2.5-8b-a1b"] });
    expect((await fetch(`${base}/settings/models/probe`, { headers: h })).status).toBe(400);
    // without a key, a remote endpoint cannot be listed; a local one can
    expect((await fetch(`${base}/settings/models/catalog`, { headers: h })).status).toBe(400);
    settings = { ...settings, models: { ...settings.models, endpoint: "http://127.0.0.1:8080/v1", local: true } };
    expect((await fetch(`${base}/settings/models/catalog`, { headers: h })).status).toBe(200);
    expect((await fetch(`${base}/settings/models/validate`, { method: "POST", headers: h })).status).toBe(200);
  });
});

describe("the queue watchdog on demand", () => {
  const h = { authorization: "Bearer secret", "content-type": "application/json" };
  it("runs one repair pass for a vault and reports what it queued again or dropped", async () => {
    const base = await start();
    const r = await fetch(`${base}/vaults/v1/pipeline/repair`, { method: "POST", headers: h });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ requeued: ["Foreword"], dropped: ["Old"] });
    const none = await fetch(`${base}/vaults/v9/pipeline/repair`, { method: "POST", headers: h });
    expect(await none.json()).toEqual({ requeued: [], dropped: [], skipped: "no pipeline" });
  });
});

describe("settings changes reach the pipelines", () => {
  const h = { authorization: "Bearer secret", "content-type": "application/json" };
  it("removing the key disables every pipeline; changing the endpoint or the model makes every pipeline follow", async () => {
    const base = await start();
    await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ models: { endpoint: "http://127.0.0.1:11434/v1" } }) });
    expect(disabledFor).toEqual([]);
    expect(modelsApplied).toBe(1);
    await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ models: { model: "llama3" } }) });
    expect(modelsApplied).toBe(2);
    await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ ui: { closeToTray: false } }) });
    expect(modelsApplied).toBe(2);
    await fetch(`${base}/settings`, { method: "PUT", headers: h, body: JSON.stringify({ models: { apiKey: "" } }) });
    expect(disabledFor).toEqual(["the model key was removed"]);
    expect(modelsApplied).toBe(2);
  });

  it("Plan 5: lists backups with the last action, and schedules a backup, a restore or a delete-all for the next start (202 restarting)", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret", "content-type": "application/json" };
    const list = await fetch(`${base}/backups`, { headers: h });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ backups: [{ name: "2026-10-07T12-00-00Z-6.2.3-dev.44", bytes: 1500 }], lastAction: { action: "backup", ok: true } });
    const made = await fetch(`${base}/backups`, { method: "POST", headers: h });
    expect(made.status).toBe(202);
    expect(await made.json()).toEqual({ restarting: true });
    const restored = await fetch(`${base}/backups/2026-10-07T12-00-00Z-6.2.3-dev.44/restore`, { method: "POST", headers: h });
    expect(restored.status).toBe(202);
    expect((await fetch(`${base}/backups/nope/restore`, { method: "POST", headers: h })).status).toBe(404);
    const refused = await fetch(`${base}/data/delete-all`, { method: "POST", headers: h, body: JSON.stringify({ confirm: "yes" }) });
    expect(refused.status).toBe(400);
    const gone = await fetch(`${base}/data/delete-all`, { method: "POST", headers: h, body: JSON.stringify({ confirm: "delete", includeBackups: true }) });
    expect(gone.status).toBe(202);
    expect(scheduled).toEqual([{ action: "backup" }, { action: "restore", name: "2026-10-07T12-00-00Z-6.2.3-dev.44" }, { action: "delete-all", includeBackups: true }]);
  });
  it("Plan 5: shutdown answers 202 and stops; the log tail is the supervisor's last lines; the crash route exists only when debug routes are on", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret" };
    const stop = await fetch(`${base}/shutdown`, { method: "POST", headers: h });
    expect(stop.status).toBe(202);
    expect(await stop.json()).toEqual({ stopping: true });
    expect(shutdowns).toBe(1);
    expect(await (await fetch(`${base}/logs/tail`, { headers: h })).json()).toEqual({ lines: ["line one", "line two"] });
    expect((await fetch(`${base}/debug/crash`, { method: "POST", headers: h })).status).toBe(404);
  });

  it("Plan 5: a busy control port falls back upward, and the bound port is what listen() resolves", async () => {
    const { createServer: createNet } = await import("node:net");
    const holder = createNet();
    const held = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as { port: number }).port)));
    const server = createControlServer({ ...(await harnessDeps()) });
    const port = await server.listen(held);
    expect(port).toBe(held + 1);
    expect((await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: "Bearer secret" } })).status).toBe(200);
    await server.close();
    await new Promise((r) => holder.close(r));
  });

  it("Plan 5: exports a vault as documents, 404 for a drive that is not a vault", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret" };
    const ok = await fetch(`${base}/vaults/v1/export`, { headers: h });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ export: { path: "/data/vault/exports/research-2026-10-07T12-00-00Z", documents: 2, bytes: 4096 } });
    expect((await fetch(`${base}/vaults/nope/export`, { headers: h })).status).toBe(404);
  });
  it("answers 400, not 500, for a malformed name in the address", async () => {
    const base = await start();
    expect((await fetch(`${base}/backups/%E0%A4%A/restore`, { method: "POST", headers: { authorization: "Bearer secret" } })).status).toBe(400);
  });
  it("answers only requests addressed to it (DNS rebinding): a foreign Host gets 403 even with the token", async () => {
    const base = await start();
    const port = Number(new URL(base).port);
    const { request } = await import("node:http");
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/status", headers: { host, authorization: "Bearer secret" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await status(`127.0.0.1:${port}`)).toBe(200);
    expect(await status(`evil.example:${port}`)).toBe(403);
  });
  it("runs a browser sign-in's return leg: start with the token, the callback without it, the code collected once", async () => {
    const base = await start();
    const h = { authorization: "Bearer secret" };
    const started = (await (await fetch(`${base}/oauth/start`, { method: "POST", headers: h })).json()) as { nonce: string; callbackUrl: string };
    const port = new URL(base).port;
    expect(started.callbackUrl).toBe(`http://localhost:${port}/oauth/callback/${started.nonce}`);
    expect((await fetch(`${base}/oauth/result/${started.nonce}`, { headers: h })).status).toBe(202);
    const page = await fetch(`${base}/oauth/callback/${started.nonce}?code=the-code`); // the system browser: no token
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toMatch(/return to Knowledge Vault/i);
    expect(await (await fetch(`${base}/oauth/result/${started.nonce}`, { headers: h })).json()).toEqual({ code: "the-code" });
    expect((await fetch(`${base}/oauth/result/${started.nonce}`, { headers: h })).status).toBe(404);
    expect((await fetch(`${base}/oauth/callback/unknown?code=x`)).status).toBe(404);
    expect((await fetch(`${base}/oauth/start`, { method: "POST" })).status).toBe(401);
  });
});

describe("model gateway route", () => {
  it("takes the control token or the gateway key, and nothing else", async () => {
    const base = await start();
    const post = (auth: string) => fetch(`${base}/llm/v1/chat/completions`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: '{"messages":[]}' });
    expect((await post("Bearer secret")).status).toBe(200);
    expect((await post("Bearer gw-key")).status).toBe(200);
    expect((await post("Bearer nope")).status).toBe(401);
    expect(gatewayCalls).toEqual([
      { url: "/llm/v1/chat/completions", body: '{"messages":[]}' },
      { url: "/llm/v1/chat/completions", body: '{"messages":[]}' },
    ]);
  });
  it("lets the app's page send the priority header", async () => {
    const base = await start();
    const res = await fetch(`${base}/llm/v1/chat/completions`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:4200" } });
    expect(res.headers.get("access-control-allow-headers")).toContain("x-kv-priority");
  });
});
