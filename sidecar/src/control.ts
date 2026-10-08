import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { allowedHost } from "./loopback.js";
import { callbackPage, createOAuthStore } from "./oauth.js";
import type { AccessToken, IdentityStatus } from "./identity.js";
import { RemoteAccessError, RemoteAuthError, RemoteInputError, RemoteNotFoundError, RemoteTooOldError, type RemoteCheck, type RemoteVault } from "./remote.js";
import { ConverterBusyError, ConverterInputError, type ConverterStatus } from "./converter.js";
import { ConnectionError, type FillResult } from "./connections.js";
import type { EnsureResult, PipelineStatus } from "./pipelines.js";
import { SettingsError, type AppSettings, type ConversionMode, type ConversionSettings, type SettingsPatch, type LocalProtection } from "./settings.js";
import { NotAVaultError, type DriveRef, type VaultSummary } from "./vaults.js";
import type { BackupInfo } from "./backups.js";
import type { ExportResult } from "./export.js";
import type { ActionResult, PendingAction } from "./pending.js";

export type StatusPayload = {
  ok: true;
  port: number;
  controlPort: number;
  appVersion: string;
  protected: boolean;
  /** The administrator when protected (spec §4.4). */
  adminAddress?: string | null;
  /** For Diagnostics and About (spec §5.2). */
  dataDir: string;
  stackVersion: string;
  vaultPackageVersion: string;
};
export type ControlDeps = {
  token: string;
  hostOrigin: string;
  status: () => StatusPayload;
  listVaults: () => Promise<VaultSummary[]>;
  createVault: (name: string) => Promise<VaultSummary>;
  renameVault: (id: string, name: string) => Promise<DriveRef>;
  deleteVault: (id: string) => Promise<void>;
  workflowsDrive: () => Promise<DriveRef>;
  readSettings: () => AppSettings;
  writeSettings: (patch: SettingsPatch) => AppSettings;
  /** Studio's Knowledge Vault connection, filled from this app: the engine's address and, when asked, a token from the sign-in. */
  fillConnection: (connectionId: string, options: { token: boolean }) => Promise<FillResult>;
  /** Settings › Models › Validate: the saved endpoint and key against the provider. */
  validateModels: () => Promise<{ ok: boolean; detail: string }>;
  /** One pass of the queue watchdog for a vault, on demand (queue-watchdog.ts). */
  repairQueue: (vaultId: string) => Promise<{ requeued: string[]; dropped: string[]; skipped?: string }>;
  /** The provider's model list with the saved key, for the picker; `endpoint` follows the form when it differs from the saved one. */
  modelCatalog: (endpoint?: string) => Promise<unknown>;
  /** Spec §4.5: each vault's pipeline (template instantiation, status, removal). */
  pipelines: {
    ensure: (vaultId: string) => Promise<EnsureResult>;
    status: (vaultId: string) => Promise<PipelineStatus>;
    remove: (vaultId: string) => Promise<void>;
    disableAll: (reason: string) => Promise<void>;
    /** Settings › Models changed: every pipeline follows (its connection rewritten, or set up again). */
    applyModels: () => Promise<{ updated: string[]; recreated: string[] }>;
  };
  /** Spec §4.4: the protection switch. `set` writes config.json's `local` section and schedules the engine's restart. */
  protection: {
    get: () => LocalProtection;
    set: (wanted: boolean) => Promise<LocalProtection & { restarting?: boolean }>;
  };
  /** Plan 4: the conversion helper; a saved conversion setting is applied right after it is written. */
  converter: {
    status: () => Promise<ConverterStatus>;
    restart: () => Promise<ConverterStatus>;
    install: (component: string) => Promise<ConverterStatus>;
    remove: (component: string) => Promise<ConverterStatus>;
  };
  applyConversion: (settings: ConversionSettings) => Promise<void>;
  auth: {
    status: () => Promise<IdentityStatus>;
    startLogin: () => Promise<{ url?: string; alreadyAuthenticated: boolean }>;
    cancelLogin: () => void;
    logout: () => Promise<void>;
    token: () => Promise<AccessToken>;
  };
  remote: {
    list: () => RemoteVault[];
    check: (url: string, drive?: string) => Promise<RemoteCheck>;
    add: (url: string, drive?: string) => Promise<RemoteVault>;
    remove: (id: string) => void;
  };
  /** Spec §9: backups, restores and the delete-all run with the store closed — the engine records the wish and restarts. */
  maintenance: {
    listBackups: () => BackupInfo[];
    lastAction: () => ActionResult | undefined;
    schedule: (action: PendingAction) => void;
  };
  /** Spec §9: GET /vaults/:id/export — the vault as documents under exports/ (synchronous; the host shows a spinner). */
  exportVault: (id: string) => Promise<ExportResult>;
  /** POST /shutdown: announce the stop (so the supervisor does not count it as a crash) and exit. */
  shutdown: () => void;
  /** GET /logs/tail: the supervisor's last lines, for Diagnostics. */
  logsTail: () => string[];
  /** KV_DEBUG_ROUTES=1 only: POST /debug/crash exits 3 so the supervisor can be exercised. */
  debugRoutes?: boolean;
};

/** A path segment; a malformed escape is the caller's mistake (400), not the server's (500). */
function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new BadRequestError("The address has a malformed name in it.");
  }
}

function settingsPatch(body: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
  const models = body.models;
  if (models !== undefined) {
    if (!models || typeof models !== "object" || Array.isArray(models)) throw new BadRequestError("`models` must be an object.");
    const m = models as Record<string, unknown>;
    const mp: NonNullable<SettingsPatch["models"]> = {};
    if (m.endpoint !== undefined) {
      if (typeof m.endpoint !== "string") throw new BadRequestError("`models.endpoint` must be a string.");
      mp.endpoint = m.endpoint;
    }
    if (m.model !== undefined) {
      if (typeof m.model !== "string") throw new BadRequestError("`models.model` must be a string.");
      mp.model = m.model;
    }
    if (m.apiKey !== undefined) {
      if (m.apiKey !== null && typeof m.apiKey !== "string") throw new BadRequestError("`models.apiKey` must be a string or null.");
      mp.apiKey = m.apiKey;
    }
    patch.models = mp;
  }
  const ui = body.ui;
  if (ui !== undefined) {
    if (!ui || typeof ui !== "object" || Array.isArray(ui)) throw new BadRequestError("`ui` must be an object.");
    const closeToTray = (ui as Record<string, unknown>).closeToTray;
    if (closeToTray !== undefined && typeof closeToTray !== "boolean") throw new BadRequestError("`ui.closeToTray` must be a boolean.");
    patch.ui = closeToTray === undefined ? {} : { closeToTray };
  }
  const conversion = body.conversion;
  if (conversion !== undefined) {
    if (!conversion || typeof conversion !== "object" || Array.isArray(conversion)) throw new BadRequestError("`conversion` must be an object.");
    const c = conversion as Record<string, unknown>;
    const cp: NonNullable<SettingsPatch["conversion"]> = {};
    if (c.mode !== undefined) {
      if (typeof c.mode !== "string") throw new BadRequestError("`conversion.mode` must be a string.");
      cp.mode = c.mode as ConversionMode; // the value itself is checked where it is stored
    }
    if (c.remoteUrl !== undefined) {
      if (typeof c.remoteUrl !== "string") throw new BadRequestError("`conversion.remoteUrl` must be a string.");
      cp.remoteUrl = c.remoteUrl;
    }
    patch.conversion = cp;
  }
  return patch;
}

class BadRequestError extends Error {}

function send(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("vary", "Origin"); // every answer depends on the origin, the refused ones included
  if (origin) res.setHeader("access-control-allow-origin", origin);
  res.end(JSON.stringify(body));
}

/** Same length, then a constant-time compare — a wrong token must not be measurably "closer" than another. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BadRequestError("The request body is not valid JSON.");
  }
}

export function createControlServer(deps: ControlDeps) {
  // Sign-ins run in the system browser return here (oauth.ts).
  const oauth = createOAuthStore();
  const server = createServer(async (req, res) => {
    // DNS rebinding: answer only requests addressed to this server (review I8).
    const bound = server.address();
    if (bound && typeof bound === "object" && !allowedHost(req.headers.host, bound.port)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      return;
    }
    const origin = req.headers.origin;
    const allowed = origin === deps.hostOrigin ? origin : undefined;
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      if (allowed) {
        res.setHeader("access-control-allow-origin", allowed);
        res.setHeader("vary", "Origin");
        res.setHeader("access-control-allow-methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
        res.setHeader("access-control-allow-headers", "authorization,content-type");
      }
      res.end();
      return;
    }
    // The system browser's return from a sign-in carries no token: it is the one route that needs none,
    // and it only completes a sign-in the window started (a 48-hex nonce, once, within ten minutes).
    const callback = /^\/oauth\/callback\/([^/]+)$/.exec(new URL(req.url ?? "/", "http://control").pathname);
    if (callback && req.method === "GET") {
      const code = new URL(req.url ?? "/", "http://control").searchParams.get("code");
      const ok = !!code && oauth.receive(decodeURIComponent(callback[1]!), code);
      res.writeHead(ok ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(callbackPage(ok));
      return;
    }
    if (!tokenMatches(req.headers.authorization, deps.token)) return send(res, 401, { error: "Unauthorized" }, allowed);
    const url = new URL(req.url ?? "/", "http://control");
    try {
      if (req.method === "POST" && url.pathname === "/oauth/start") {
        const { nonce } = oauth.start();
        const bound = server.address();
        const port = typeof bound === "object" && bound ? bound.port : 0;
        // localhost, not 127.0.0.1: providers accept localhost callbacks for local apps; the Host check allows both.
        return send(res, 200, { nonce, callbackUrl: `http://localhost:${port}/oauth/callback/${nonce}` }, allowed);
      }
      const oauthResult = /^\/oauth\/result\/([^/]+)$/.exec(url.pathname);
      if (oauthResult && req.method === "GET") {
        const r = oauth.take(decodePart(oauthResult[1]!));
        if (r.state === "pending") return send(res, 202, { pending: true }, allowed);
        if (r.state === "unknown") return send(res, 404, { error: "No such sign-in, or it expired." }, allowed);
        return send(res, 200, { code: r.code }, allowed);
      }
      if (req.method === "GET" && url.pathname === "/status") return send(res, 200, deps.status(), allowed);
      if (req.method === "GET" && url.pathname === "/vaults") return send(res, 200, { vaults: await deps.listVaults() }, allowed);
      if (req.method === "POST" && url.pathname === "/vaults") {
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return send(res, 400, { error: "A vault needs a name." }, allowed);
        const vault = await deps.createVault(name);
        // The vault exists whatever happens to its pipeline; a failed instantiation is reported, not fatal.
        let pipeline: EnsureResult | { state: "failed"; error: string };
        try {
          pipeline = await deps.pipelines.ensure(vault.id);
        } catch (error) {
          pipeline = { state: "failed", error: error instanceof Error ? error.message : String(error) };
        }
        return send(res, 201, { vault, pipeline }, allowed);
      }
      const fillOf = url.pathname.match(/^\/connections\/([^/]+)\/fill$/);
      if (fillOf && req.method === "POST") {
        const body = await readJson(req);
        return send(res, 200, { connection: await deps.fillConnection(decodePart(fillOf[1]!), { token: body.token === true }) }, allowed);
      }
      const repairOf = url.pathname.match(/^\/vaults\/([^/]+)\/pipeline\/repair$/);
      if (repairOf && req.method === "POST") return send(res, 200, await deps.repairQueue(decodePart(repairOf[1]!)), allowed);
      const pipelineOf = url.pathname.match(/^\/vaults\/([^/]+)\/pipeline$/);
      if (pipelineOf && req.method === "POST") {
        const result = await deps.pipelines.ensure(decodePart(pipelineOf[1]!));
        if (result.state === "unconfigured") return send(res, 409, { error: "Set up a model first — Settings › Models." }, allowed);
        return send(res, 200, { pipeline: result }, allowed);
      }
      if (pipelineOf && req.method === "GET") return send(res, 200, { pipeline: await deps.pipelines.status(decodePart(pipelineOf[1]!)) }, allowed);
      const vault = url.pathname.match(/^\/vaults\/([^/]+)$/);
      if (vault && req.method === "PATCH") {
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return send(res, 400, { error: "A vault needs a name." }, allowed);
        return send(res, 200, { vault: await deps.renameVault(decodePart(vault[1]!), name) }, allowed);
      }
      if (vault && req.method === "DELETE") {
        const id = decodePart(vault[1]!);
        await deps.pipelines.remove(id).catch(() => undefined); // its workflow, connection and secrets go with it
        await deps.deleteVault(id);
        return send(res, 200, { deleted: id }, allowed);
      }
      if (req.method === "GET" && url.pathname === "/workflows") return send(res, 200, { drive: await deps.workflowsDrive() }, allowed);
      if (req.method === "GET" && url.pathname === "/local/protection") return send(res, 200, deps.protection.get(), allowed);
      if (req.method === "PUT" && url.pathname === "/local/protection") {
        const body = await readJson(req);
        if (typeof body.protected !== "boolean") return send(res, 400, { error: "`protected` must be true or false." }, allowed);
        const result = await deps.protection.set(body.protected);
        return send(res, 202, { restarting: true, ...result }, allowed);
      }
      if (req.method === "GET" && url.pathname === "/settings") return send(res, 200, deps.readSettings(), allowed);
      if (req.method === "POST" && url.pathname === "/settings/models/validate") {
        if (!deps.readSettings().models.hasKey) return send(res, 400, { error: "Save a key first." }, allowed);
        return send(res, 200, await deps.validateModels(), allowed);
      }
      if (req.method === "GET" && url.pathname === "/settings/models/catalog") {
        if (!deps.readSettings().models.hasKey) return send(res, 400, { error: "Save a key first." }, allowed);
        const endpoint = url.searchParams.get("endpoint")?.trim() || undefined;
        return send(res, 200, await deps.modelCatalog(endpoint), allowed);
      }
      if (req.method === "PUT" && url.pathname === "/settings") {
        const patch = settingsPatch(await readJson(req));
        const settings = deps.writeSettings(patch);
        if (patch.conversion) await deps.applyConversion(settings.conversion);
        // Removing the key must stop its use: the pipelines' runtime secret still holds it.
        if (patch.models && (patch.models.apiKey === "" || patch.models.apiKey === null)) await deps.pipelines.disableAll("the model key was removed");
        else if (patch.models && (patch.models.model !== undefined || patch.models.endpoint !== undefined)) await deps.pipelines.applyModels();
        return send(res, 200, settings, allowed);
      }
      // conversion helper (Plan 4)
      if (req.method === "GET" && url.pathname === "/converter") return send(res, 200, await deps.converter.status(), allowed);
      if (req.method === "POST" && url.pathname === "/converter/restart") return send(res, 200, await deps.converter.restart(), allowed);
      if (req.method === "POST" && (url.pathname === "/converter/install" || url.pathname === "/converter/remove")) {
        const body = await readJson(req);
        const component = typeof body.component === "string" ? body.component : "";
        if (!component) return send(res, 400, { error: "Name the component: binding or models." }, allowed);
        if (url.pathname.endsWith("/install")) return send(res, 202, await deps.converter.install(component), allowed);
        return send(res, 200, await deps.converter.remove(component), allowed);
      }
      // identity (spec §4.6 /auth/*)
      if (req.method === "GET" && url.pathname === "/auth/status") return send(res, 200, await deps.auth.status(), allowed);
      if (req.method === "POST" && url.pathname === "/auth/login") return send(res, 202, await deps.auth.startLogin(), allowed);
      if (req.method === "POST" && url.pathname === "/auth/cancel") {
        deps.auth.cancelLogin();
        return send(res, 200, { cancelled: true }, allowed);
      }
      if (req.method === "POST" && url.pathname === "/auth/logout") {
        await deps.auth.logout();
        return send(res, 200, { signedOut: true }, allowed);
      }
      if (req.method === "GET" && url.pathname === "/auth/token") {
        try {
          return send(res, 200, await deps.auth.token(), allowed);
        } catch (error) {
          // The SDK says "Not authenticated" for a missing credential; anything else is a real failure.
          const message = error instanceof Error ? error.message : String(error);
          if (/expired/i.test(message)) return send(res, 401, { error: message }, allowed);
          if (/not authenticated/i.test(message)) return send(res, 401, { error: "Not signed in." }, allowed);
          return send(res, 500, { error: `Could not mint a token: ${message}` }, allowed);
        }
      }
      // remote vaults (spec §5.5)
      if (req.method === "GET" && url.pathname === "/remote-vaults") return send(res, 200, { vaults: deps.remote.list() }, allowed);
      if (req.method === "POST" && (url.pathname === "/remote-vaults/check" || url.pathname === "/remote-vaults")) {
        const body = await readJson(req);
        const address = typeof body.url === "string" ? body.url : "";
        const drive = typeof body.drive === "string" && body.drive.trim() ? body.drive : undefined;
        if (!address) return send(res, 400, { error: "Enter the vault's address." }, allowed);
        if (url.pathname.endsWith("/check")) return send(res, 200, { vault: await deps.remote.check(address, drive) }, allowed);
        return send(res, 201, { vault: await deps.remote.add(address, drive) }, allowed);
      }
      const remote = url.pathname.match(/^\/remote-vaults\/([^/]+)$/);
      if (remote && req.method === "DELETE") {
        const id = decodePart(remote[1]!);
        deps.remote.remove(id);
        return send(res, 200, { removed: id }, allowed);
      }
      const exportMatch = url.pathname.match(/^\/vaults\/([^/]+)\/export$/);
      if (exportMatch && req.method === "GET") {
        return send(res, 200, { export: await deps.exportVault(decodePart(exportMatch[1]!)) }, allowed);
      }
      // Plan 5 — maintenance. Every action runs at the next start, with the store closed.
      if (req.method === "GET" && url.pathname === "/backups") {
        return send(res, 200, { backups: deps.maintenance.listBackups(), lastAction: deps.maintenance.lastAction() ?? null }, allowed);
      }
      if (req.method === "POST" && url.pathname === "/backups") {
        deps.maintenance.schedule({ action: "backup" });
        return send(res, 202, { restarting: true }, allowed);
      }
      const restore = url.pathname.match(/^\/backups\/([^/]+)\/restore$/);
      if (restore && req.method === "POST") {
        const name = decodePart(restore[1]!);
        if (!deps.maintenance.listBackups().some((b) => b.name === name)) return send(res, 404, { error: `No backup named ${name}.` }, allowed);
        deps.maintenance.schedule({ action: "restore", name });
        return send(res, 202, { restarting: true }, allowed);
      }
      if (req.method === "POST" && url.pathname === "/data/delete-all") {
        const body = await readJson(req);
        if (body.confirm !== "delete") return send(res, 400, { error: 'Deleting everything needs `confirm: "delete"`.' }, allowed);
        deps.maintenance.schedule({ action: "delete-all", includeBackups: body.includeBackups === true });
        return send(res, 202, { restarting: true }, allowed);
      }
      if (req.method === "POST" && url.pathname === "/shutdown") {
        deps.shutdown();
        return send(res, 202, { stopping: true }, allowed);
      }
      if (req.method === "GET" && url.pathname === "/logs/tail") return send(res, 200, { lines: deps.logsTail() }, allowed);
      if (req.method === "POST" && url.pathname === "/debug/crash" && deps.debugRoutes === true) {
        send(res, 202, { crashing: true }, allowed);
        setTimeout(() => process.exit(3), 50);
        return;
      }
      return send(res, 404, { error: "Not found" }, allowed);
    } catch (error) {
      if (error instanceof BadRequestError || error instanceof SettingsError || error instanceof ConnectionError || error instanceof ConverterInputError) return send(res, 400, { error: error.message }, allowed);
      if (error instanceof ConverterBusyError) return send(res, 409, { error: error.message }, allowed);
      if (error instanceof NotAVaultError) return send(res, 404, { error: error.message }, allowed);
      if (error instanceof RemoteInputError) return send(res, 400, { error: error.message }, allowed);
      if (error instanceof RemoteAuthError) return send(res, 401, { error: error.message }, allowed);
      if (error instanceof RemoteAccessError) return send(res, 403, { error: error.message }, allowed);
      if (error instanceof RemoteNotFoundError) return send(res, 404, { error: error.message }, allowed);
      if (error instanceof RemoteTooOldError) return send(res, 409, { error: error.message }, allowed);
      return send(res, 500, { error: error instanceof Error ? error.message : String(error) }, allowed);
    }
  });
  return {
    /**
     * Bind on loopback; `port` 0 picks a free one. A busy port falls back upward
     * (`port+1 … port+20`) — the readiness line carries the real one. Resolves the bound port.
     */
    async listen(port = 0): Promise<number> {
      const tryListen = (p: number): Promise<number> =>
        new Promise((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException) => reject(error);
          server.once("error", onError);
          server.listen(p, "127.0.0.1", () => {
            server.off("error", onError);
            const addr = server.address();
            resolve(typeof addr === "object" && addr ? addr.port : p);
          });
        });
      const candidates = port === 0 ? [0] : Array.from({ length: 21 }, (_, i) => port + i).filter((p) => p <= 65535);
      let lastError: unknown;
      for (const p of candidates) {
        try {
          return await tryListen(p);
        } catch (error) {
          lastError = error;
          if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`no free control port in ${port}–${port + 20}`);
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
