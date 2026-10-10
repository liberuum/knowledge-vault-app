import { join } from "node:path";

export type SidecarConfig = {
  dataDir: string;
  port: number;
  controlPort: number;
  controlToken: string;
  hostOrigin: string;
  protected: boolean;
  adminAddress: string | undefined;
  appVersion: string;
  logLevel: string;
  /** The Powerhouse registry Workflow Studio lists and installs pieces from; empty (the default) when off. */
  registryUrl: string;
};

/**
 * Workflow Studio's Registry tab: the pieces published to the Powerhouse registry. Off unless
 * KV_REGISTRY_URL names one (this one, say). With a registry, the workflow runtime fetches the exact
 * piece version a pipeline was pinned to instead of running the one the app ships — and leaves the
 * trigger unarmed when the registry lacks it (seen: a 6.2.3-dev.52 runtime, a pipeline pinned to the
 * previous release's piece, 404). Every app update ships a new piece version, so every existing
 * pipeline would stop. Also, registry.vetra.io answered its catalog in a shape dev.52 rejects.
 */
export const DEFAULT_REGISTRY_URL = "https://registry.vetra.io";

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
}
function port(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${key} must be a port, got "${raw}"`);
  return n;
}

export function readSidecarConfig(env: Env): SidecarConfig {
  const isProtected = env.KV_PROTECTED === "1";
  const adminAddress = env.KV_ADMIN_ADDRESS || undefined;
  if (isProtected && !adminAddress) throw new Error("KV_ADMIN_ADDRESS is required when KV_PROTECTED=1");
  return {
    dataDir: required(env, "KV_DATA_DIR"),
    port: port(env, "KV_PORT", 4201),
    controlPort: port(env, "KV_CONTROL_PORT", 4202),
    controlToken: required(env, "KV_CONTROL_TOKEN"),
    hostOrigin: env.KV_HOST_ORIGIN || "http://127.0.0.1:4200",
    protected: isProtected,
    adminAddress,
    appVersion: env.KV_APP_VERSION || "dev",
    logLevel: env.KV_LOG_LEVEL || "info",
    registryUrl: env.KV_REGISTRY_URL ?? "",
  };
}

/** The engine's own secrets, each created once in `secrets/` (0600) and kept across starts. */
export type EngineSecrets = { workflows: string; attachmentSigning: string };

/** Spec §4.2: the Switchboard matrix. environment.ts decides what else the engine inherits — an OS/session allowlist, nothing more. */
export function switchboardEnv(cfg: SidecarConfig, secrets: EngineSecrets, openModeAddress = "local", egressAllow: readonly string[] = []): Record<string, string> {
  const origin = `http://127.0.0.1:${cfg.port}`;
  const flag = cfg.protected ? "true" : "false";
  return {
    // Open mode (vault package §7.3): the anonymous caller is the engine's owner. Declared only when not protected.
    ...(cfg.protected ? {} : { KNOWLEDGE_VAULT_OPEN_MODE: "1", KNOWLEDGE_VAULT_OPEN_MODE_ADDRESS: openModeAddress }),
    // Under the authenticated-caller floor /health would answer 401; the sidecar reads it to know the engine is up.
    ...(cfg.protected ? { REQUIRE_AUTHENTICATED_CALLER_EXEMPT_PATHS: "/health" } : {}),
    PORT: String(cfg.port),
    PH_REACTOR_DATABASE_URL: join(cfg.dataDir, "reactor"),
    DATABASE_URL: join(cfg.dataDir, "read-model"),
    PH_SWITCHBOARD_PUBLIC_URL: origin,
    PUBLIC_URL: origin,
    AUTH_ENABLED: flag,
    REQUIRE_AUTHENTICATED_CALLER: flag,
    DEFAULT_PROTECTION: flag,
    DOCUMENT_PERMISSIONS_ENABLED: flag,
    ADMINS: cfg.protected ? (cfg.adminAddress ?? "") : "",
    PH_WORKFLOWS_ENABLED: "1",
    PH_WORKFLOWS_SECRETS_MASTER_KEY: secrets.workflows,
    // Attachment downloads (a source's original file, its figures) are short-lived signed links. In
    // production the Switchboard refuses every download without this secret; it is kept across
    // starts so a link handed out just before a restart still works until it expires.
    PH_ATTACHMENT_URL_SIGNING_SECRET: secrets.attachmentSigning,
    // Loopback always (the engine itself, a local model server); plus the saved model endpoint when it is on the local network.
    PH_WORKFLOWS_EGRESS_ALLOW_ADDRESSES: ["127.0.0.1/32", "::1/128", ...egressAllow].join(","),
    // Every commit is fsynced since 6.2.3-dev.45; PH_PGLITE_FSYNC=0 is upstream's escape hatch (power-loss
    // durability off), passed on only when the user set it — environment.ts drops PH_* otherwise.
    ...(process.env.PH_PGLITE_FSYNC ? { PH_PGLITE_FSYNC: process.env.PH_PGLITE_FSYNC } : {}),
    SWITCHBOARD_APP_NAME: "knowledge-vault-app",
    MCP_ENABLED: "true",
    LOG_LEVEL: cfg.logLevel,
    NODE_ENV: "production",
  };
}
