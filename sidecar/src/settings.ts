import { isLocalEndpoint } from "./egress.js";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./process-identity.js";

/**
 * Spec §5.6: `config.json` in the data dir holds settings; secrets never do. The
 * model key lives in `secrets/llm.key` (0600) and is reported only as `hasKey`.
 * Other keys in config.json (the shell's `ui`, later `vaults`) are preserved.
 */
export type ModelProvider = "local" | "openrouter" | "openai" | "anthropic" | "gemini" | "xai" | "custom";
/** The services with a fixed address; "local" and "custom" are whatever the user points at. */
export const PROVIDER_ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  xai: "https://api.x.ai/v1",
} as const;
export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  local: "this computer",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  xai: "xAI",
  custom: "your model server",
};
/** Which provider an endpoint is: a known service by its exact address, else local or custom. */
export function inferProvider(endpoint: string, local: boolean): ModelProvider {
  if (local) return "local";
  const norm = endpoint.trim().replace(/\/+$/, "");
  for (const [provider, address] of Object.entries(PROVIDER_ENDPOINTS)) if (norm === address) return provider as ModelProvider;
  return "custom";
}
/** `local`: the endpoint is on this computer — no key is needed (a placeholder is used). */
export type ModelSettings = { endpoint: string; model: string; hasKey: boolean; local: boolean; provider: ModelProvider };
/** Where documents convert (Plan 4): the helper on this computer, another server by URL, or nowhere. */
export type ConversionMode = "local" | "remote" | "off";
/** `removed`: components the user removed in Settings — not installed again on their own. */
export type ConversionSettings = { mode: ConversionMode; remoteUrl: string; removed?: Array<"binding" | "models"> };
export const CONVERSION_MODES: readonly ConversionMode[] = ["local", "remote", "off"];
/** Plan 5: the shell's window behaviour — closing the window keeps the engine serving tools from the tray. */
export type UiSettings = { closeToTray: boolean };
export type AppSettings = { version: 1; models: ModelSettings; conversion: ConversionSettings; ui: UiSettings };
export type SettingsPatch = {
  models?: { endpoint?: string; model?: string; apiKey?: string | null; provider?: keyof typeof PROVIDER_ENDPOINTS };
  conversion?: { mode?: ConversionMode; remoteUrl?: string };
  ui?: { closeToTray?: boolean };
};

/** A rejected value (the control API answers 400). */
export class SettingsError extends Error {}

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";

/**
 * People paste what their provider shows — often the chat-completions URL.
 * The piece and the chat want the API root: drop `/chat/completions`,
 * `/completions` or `/models`, the query, the hash and trailing slashes; a
 * server mounted at its root stays as given.
 */
export function normalizeEndpoint(raw: string): string {
  const url = new URL(raw.trim());
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/(chat\/completions|completions|models)\/?$/, "").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function configPath(dataDir: string): string {
  return join(dataDir, "config.json");
}
function keyPath(dataDir: string): string {
  return join(dataDir, "secrets", "llm.key");
}

/** The whole config.json, for stores that own other keys (remote vaults); unknown keys survive every write. */
export function readConfig(dataDir: string): Record<string, unknown> {
  return readRaw(dataDir);
}
export function writeConfig(dataDir: string, raw: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(configPath(dataDir), JSON.stringify({ ...raw, version: 1 }, null, 2) + "\n");
}

function readRaw(dataDir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(dataDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readModelKey(dataDir: string): string | undefined {
  try {
    const key = readFileSync(keyPath(dataDir), "utf8").trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

export function readSettings(dataDir: string): AppSettings {
  const raw = readRaw(dataDir);
  const models = (raw.models && typeof raw.models === "object" ? raw.models : {}) as Record<string, unknown>;
  const conversion = (raw.conversion && typeof raw.conversion === "object" ? raw.conversion : {}) as Record<string, unknown>;
  const ui = (raw.ui && typeof raw.ui === "object" ? raw.ui : {}) as Record<string, unknown>;
  const endpoint = typeof models.endpoint === "string" && models.endpoint ? models.endpoint : DEFAULT_ENDPOINT;
  const local = isLocalEndpoint(endpoint);
  return {
    version: 1,
    models: {
      endpoint,
      model: typeof models.model === "string" ? models.model : "",
      hasKey: readModelKey(dataDir) !== undefined,
      local,
      provider: inferProvider(endpoint, local),
    },
    conversion: {
      mode: CONVERSION_MODES.includes(conversion.mode as ConversionMode) ? (conversion.mode as ConversionMode) : "local",
      remoteUrl: typeof conversion.remoteUrl === "string" ? conversion.remoteUrl : "",
      removed: Array.isArray(conversion.removed) ? (conversion.removed as unknown[]).filter((c): c is "binding" | "models" => c === "binding" || c === "models") : [],
    },
    ui: { closeToTray: ui.closeToTray !== false },
  };
}

export function writeSettings(dataDir: string, patch: SettingsPatch): AppSettings {
  const raw = readRaw(dataDir);
  const current = readSettings(dataDir);
  const models = { endpoint: current.models.endpoint, model: current.models.model };
  if (patch.models) {
    if (patch.models.provider && typeof patch.models.endpoint !== "string") {
      const address = PROVIDER_ENDPOINTS[patch.models.provider];
      if (!address) throw new SettingsError("Unknown model provider.");
      models.endpoint = address;
    }
    if (typeof patch.models.endpoint === "string") {
      const endpoint = patch.models.endpoint.trim() || DEFAULT_ENDPOINT;
      if (!/^https?:\/\//.test(endpoint)) throw new SettingsError("The model endpoint must be an http(s) URL.");
      models.endpoint = normalizeEndpoint(endpoint);
    }
    if (typeof patch.models.model === "string") models.model = patch.models.model.trim();
    if (patch.models.apiKey !== undefined) {
      if (patch.models.apiKey === null || patch.models.apiKey === "") {
        rmSync(keyPath(dataDir), { force: true });
      } else {
        mkdirSync(join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
        writeFileSync(keyPath(dataDir), patch.models.apiKey.trim(), { mode: 0o600 });
        chmodSync(keyPath(dataDir), 0o600);
      }
    }
  }
  const conversion = { ...current.conversion };
  if (patch.conversion) {
    if (patch.conversion.mode !== undefined) {
      if (!CONVERSION_MODES.includes(patch.conversion.mode)) throw new SettingsError("The conversion mode must be local, remote or off.");
      conversion.mode = patch.conversion.mode;
    }
    if (typeof patch.conversion.remoteUrl === "string") {
      const url = patch.conversion.remoteUrl.trim().replace(/\/+$/, "");
      if (url && !/^https?:\/\//.test(url)) throw new SettingsError("The conversion server must be an http(s) URL.");
      conversion.remoteUrl = url;
    }
    if (conversion.mode === "remote" && !conversion.remoteUrl) throw new SettingsError("Another server needs its URL.");
  }
  // The ui section is shared with the shell (it reads closeToTray at every window close); other keys in it survive.
  const ui = { ...(raw.ui && typeof raw.ui === "object" ? (raw.ui as Record<string, unknown>) : {}) };
  if (patch.ui && typeof patch.ui.closeToTray === "boolean") ui.closeToTray = patch.ui.closeToTray;
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(configPath(dataDir), JSON.stringify({ ...raw, version: 1, models, conversion, ...(Object.keys(ui).length ? { ui } : {}) }, null, 2) + "\n");
  return readSettings(dataDir);
}

/** For tests and diagnostics: whether a config file exists at all. */
export function hasConfig(dataDir: string): boolean {
  return existsSync(configPath(dataDir));
}

/** Spec §4.4: one switch for the local engine — protected means the signed-in Renown identity administers every local vault. */
export type LocalProtection = { protected: boolean; adminAddress: string | null };

/** The `local` section of config.json. Protected without an administrator cannot start the engine, so it reads as open. */
export function readLocalProtection(dataDir: string): LocalProtection {
  const raw = readRaw(dataDir);
  const local = (raw.local && typeof raw.local === "object" ? raw.local : {}) as Record<string, unknown>;
  const adminAddress = typeof local.adminAddress === "string" && local.adminAddress ? local.adminAddress : null;
  return { protected: local.protected === true && adminAddress !== null, adminAddress };
}

export function writeLocalProtection(dataDir: string, protection: LocalProtection): LocalProtection {
  if (protection.protected && !protection.adminAddress) throw new SettingsError("Protection needs the signed-in administrator's address.");
  const raw = readRaw(dataDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(
    configPath(dataDir),
    JSON.stringify({ ...raw, version: 1, local: { protected: protection.protected, adminAddress: protection.adminAddress } }, null, 2) + "\n",
  );
  return readLocalProtection(dataDir);
}

/** Spec §9: the stack that last opened this store (top-level `stackVersion` of config.json); a store never opened has none. */
export function readStackVersion(dataDir: string): string | undefined {
  const v = readRaw(dataDir).stackVersion;
  return typeof v === "string" && v ? v : undefined;
}
export function writeStackVersion(dataDir: string, stackVersion: string): void {
  writeConfig(dataDir, { ...readRaw(dataDir), stackVersion });
}

/** Remember (or forget) that the user removed a converter component: removed ones are not installed again on their own. */
export function setComponentRemoved(dataDir: string, component: "binding" | "models", removed: boolean): void {
  const raw = readRaw(dataDir);
  const conversion = (raw.conversion && typeof raw.conversion === "object" ? raw.conversion : {}) as Record<string, unknown>;
  const list = new Set(Array.isArray(conversion.removed) ? (conversion.removed as unknown[]).filter((c): c is string => typeof c === "string") : []);
  if (removed) list.add(component);
  else list.delete(component);
  writeConfig(dataDir, { ...raw, conversion: { ...conversion, removed: [...list] } });
}
