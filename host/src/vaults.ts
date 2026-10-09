import type { SidecarInfo } from "./sidecar.js";
export type VaultSummary = { id: string; slug: string; name: string; noteCount: number; /** From engines that report it (0.2 on). */ sourceCount?: number };

export class ControlError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export async function control<T>(info: SidecarInfo, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${info.controlOrigin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${info.controlToken}`,
      "content-type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ControlError(body.error ?? `The engine answered HTTP ${res.status}`, res.status);
  return body;
}
export async function fetchVaults(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<VaultSummary[]> {
  return (await control<{ vaults: VaultSummary[] }>(info, "/vaults", { method: "GET" }, fetchImpl)).vaults;
}
export async function createVault(info: SidecarInfo, name: string, fetchImpl: typeof fetch = fetch): Promise<VaultSummary> {
  return (await control<{ vault: VaultSummary }>(info, "/vaults", { method: "POST", body: JSON.stringify({ name }) }, fetchImpl)).vault;
}
export type EngineStatus = { ok: true; port: number; controlPort: number; appVersion: string; protected: boolean; adminAddress?: string | null; dataDir: string; stackVersion: string; vaultPackageVersion: string; /** This store's identity (sidecar/src/store-id.ts); absent from older engines. */ storeId?: string; };
/** Spec §4.4: one switch for the local engine. */
export type LocalProtection = { protected: boolean; adminAddress: string | null };
export async function fetchProtection(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<LocalProtection> {
  return control<LocalProtection>(info, "/local/protection", { method: "GET" }, fetchImpl);
}
/** Asks the engine to switch; it restarts itself with the new setting (202). */
export async function setProtection(info: SidecarInfo, wanted: boolean, fetchImpl: typeof fetch = fetch): Promise<LocalProtection & { restarting: boolean }> {
  return control<LocalProtection & { restarting: boolean }>(info, "/local/protection", { method: "PUT", body: JSON.stringify({ protected: wanted }) }, fetchImpl);
}
export async function fetchStatus(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<EngineStatus> {
  return control<EngineStatus>(info, "/status", { method: "GET" }, fetchImpl);
}
export type DriveRef = { id: string; slug: string; name: string };
export async function renameVault(info: SidecarInfo, id: string, name: string, fetchImpl: typeof fetch = fetch): Promise<DriveRef> {
  return (await control<{ vault: DriveRef }>(info, `/vaults/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }, fetchImpl)).vault;
}
export async function deleteVault(info: SidecarInfo, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await control<{ deleted: string }>(info, `/vaults/${encodeURIComponent(id)}`, { method: "DELETE" }, fetchImpl);
}
export async function fetchWorkflowsDrive(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<DriveRef> {
  return (await control<{ drive: DriveRef }>(info, "/workflows", { method: "GET" }, fetchImpl)).drive;
}
/** `local`: the endpoint is on this computer — no key is needed. */
export type ModelSettings = { endpoint: string; model: string; hasKey: boolean; local?: boolean; provider: "local" | "chatgpt" | "openrouter" | "openai" | "anthropic" | "gemini" | "xai" | "custom" };
/** Where documents convert (Plan 4): the helper on this computer, another server by URL, or nowhere. */
export type ConversionMode = "local" | "remote" | "off";
export type ConversionSettings = { mode: ConversionMode; remoteUrl: string };
export type AppSettings = { version: 1; models: ModelSettings; conversion: ConversionSettings; ui?: { closeToTray: boolean; onboarding?: "skipped" | "done" } };
export type SettingsPatch = {
  models?: { endpoint?: string; model?: string; apiKey?: string | null; provider?: "chatgpt" | "openrouter" | "openai" | "anthropic" | "gemini" | "xai" };
  conversion?: { mode?: ConversionMode; remoteUrl?: string };
  ui?: { closeToTray?: boolean; onboarding?: "skipped" | "done" };
};
export type ConverterStatus = {
  mode: ConversionMode;
  state: "off" | "starting" | "ready" | "down";
  url: string | null;
  localUrl: string | null;
  pid: number | null;
  exitCode: number | null;
  restarts: number;
  logPath: string;
  health: Record<string, unknown> | null;
  error: string | null;
  installed: {
    binding: { installed: boolean; version: string | null; supported: boolean; platform: string | null; reason: string | null };
    models: { installed: boolean; supported: boolean; reason: string | null };
  };
  job: InstallJob | null;
};
export type ConverterComponent = "binding" | "models";
export type InstallJob = {
  component: ConverterComponent;
  phase: "downloading" | "verifying" | "extracting" | "fetching" | "done" | "failed";
  percent: number | null;
  bytes: number;
  total: number | null;
  message: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};
export async function fetchSettings(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<AppSettings> {
  return control<AppSettings>(info, "/settings", { method: "GET" }, fetchImpl);
}
export async function saveSettings(info: SidecarInfo, patch: SettingsPatch, fetchImpl: typeof fetch = fetch): Promise<AppSettings> {
  return control<AppSettings>(info, "/settings", { method: "PUT", body: JSON.stringify(patch) }, fetchImpl);
}
export async function fetchConverter(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<ConverterStatus> {
  return control<ConverterStatus>(info, "/converter", { method: "GET" }, fetchImpl);
}
export async function restartConverter(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<ConverterStatus> {
  return control<ConverterStatus>(info, "/converter/restart", { method: "POST" }, fetchImpl);
}
export async function installConverterComponent(info: SidecarInfo, component: ConverterComponent, fetchImpl: typeof fetch = fetch): Promise<ConverterStatus> {
  return control<ConverterStatus>(info, "/converter/install", { method: "POST", body: JSON.stringify({ component }) }, fetchImpl);
}
export async function removeConverterComponent(info: SidecarInfo, component: ConverterComponent, fetchImpl: typeof fetch = fetch): Promise<ConverterStatus> {
  return control<ConverterStatus>(info, "/converter/remove", { method: "POST", body: JSON.stringify({ component }) }, fetchImpl);
}

/** Spec §4.5: a vault's pipeline as the engine reports it (sidecar/src/pipelines.ts). */
export type RunProblem = { kind: "no-funds" | "bad-key" | "rate-limited" | "slow-model" | "model-missing" | "model-refused" | "interrupted"; message: string; model?: string };
export type PipelineStatus =
  | { state: "unconfigured" }
  | { state: "missing" }
  | { state: "stale"; reason: string; workflowId: string; connectionId: string }
  | {
      state: "ready";
      workflowId: string;
      connectionId: string;
      trigger?: { status: string; lastPollAt: string | null; lastError: string | null };
      lastRun?: { id: string; status: string; startedAt: string | null; endedAt: string | null; error: string | null; problem?: RunProblem };
    };
export async function fetchPipeline(info: SidecarInfo, vaultId: string, fetchImpl: typeof fetch = fetch): Promise<PipelineStatus> {
  return (await control<{ pipeline: PipelineStatus }>(info, `/vaults/${encodeURIComponent(vaultId)}/pipeline`, { method: "GET" }, fetchImpl)).pipeline;
}
/** Create (or re-create) the vault's pipeline from the shipped template; 409 when no model is set up. */
export async function setupPipeline(info: SidecarInfo, vaultId: string, fetchImpl: typeof fetch = fetch): Promise<PipelineStatus> {
  return (await control<{ pipeline: PipelineStatus }>(info, `/vaults/${encodeURIComponent(vaultId)}/pipeline`, { method: "POST" }, fetchImpl)).pipeline;
}
/** The engine tries the saved model settings against the provider (one cheap request) and reports the verdict. */
export type ModelVerdict = { ok: boolean; detail: string; warning?: string };
export async function validateModels(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<ModelVerdict> {
  return control<ModelVerdict>(info, "/settings/models/validate", { method: "POST" }, fetchImpl);
}
/** A model server on this computer (or the local network), tried before it is saved: what it serves, or why it did not answer. */
export type LocalProbe = { ok: true; endpoint: string; models: string[] } | { ok: false; endpoint: string; detail: string };
export async function probeLocalModels(info: SidecarInfo, endpoint: string, fetchImpl: typeof fetch = fetch): Promise<LocalProbe> {
  return control<LocalProbe>(info, `/settings/models/probe?endpoint=${encodeURIComponent(endpoint)}`, { method: "GET" }, fetchImpl);
}
/** What the engine found running on this computer, and what its graphics memory runs well (sidecar model-discovery.ts, gpu.ts). */
export type DiscoveredModel = { id: string; loaded: boolean | null; contextLength: number | null; vision: boolean | null };
export type DiscoveredServer = { endpoint: string; port: number; provider: string; models: DiscoveredModel[]; parallel: number | null };
export type LocalDiscovery = { servers: DiscoveredServer[]; gpu: { kind: "dedicated" | "unified" | "none"; bytes: number; name: string | null }; hint: string };
export async function discoverLocalModels(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<LocalDiscovery> {
  return control<LocalDiscovery>(info, "/settings/models/discover", { method: "GET" }, fetchImpl);
}
/** The provider's model list with the saved key, for the picker (the engine asks; the page never holds the key). */
export type ModelCatalog = { ok: true; models: import("./settings/model-picker.js").CatalogModel[] } | { ok: false; detail: string };
/** The models a key just entered gives, before it is saved: a named service's, or another one's at its address. */
export async function fetchModelCatalogFor(info: SidecarInfo, request: { provider: string; endpoint?: string; apiKey: string }, fetchImpl: typeof fetch = fetch): Promise<ModelCatalog> {
  return control<ModelCatalog>(info, "/settings/models/catalog", { method: "POST", body: JSON.stringify(request) }, fetchImpl);
}

export async function fetchModelCatalog(info: SidecarInfo, endpoint?: string, fetchImpl: typeof fetch = fetch): Promise<ModelCatalog> {
  const q = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : "";
  return control<ModelCatalog>(info, `/settings/models/catalog${q}`, { method: "GET" }, fetchImpl);
}

// ---- Plan 5: maintenance. Backups, restores and the delete-all run at the engine's next start (spec §9).
export type BackupInfo = { name: string; path: string; bytes: number; stackVersion: string; createdAt: string };
export type ActionResult = { action: "backup" | "restore" | "delete-all"; ok: boolean; detail: string; at: string };
export type ExportResult = { path: string; documents: number; bytes: number; failed?: string[] };
export async function fetchBackups(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<{ backups: BackupInfo[]; lastAction: ActionResult | null }> {
  return control(info, "/backups", { method: "GET" }, fetchImpl);
}
export async function requestBackup(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<{ restarting: boolean }> {
  return control(info, "/backups", { method: "POST" }, fetchImpl);
}
export async function requestRestore(info: SidecarInfo, name: string, fetchImpl: typeof fetch = fetch): Promise<{ restarting: boolean }> {
  return control(info, `/backups/${encodeURIComponent(name)}/restore`, { method: "POST" }, fetchImpl);
}
export async function requestDeleteAll(info: SidecarInfo, includeBackups: boolean, fetchImpl: typeof fetch = fetch): Promise<{ restarting: boolean }> {
  return control(info, "/data/delete-all", { method: "POST", body: JSON.stringify({ confirm: "delete", includeBackups }) }, fetchImpl);
}
export async function exportVault(info: SidecarInfo, id: string, fetchImpl: typeof fetch = fetch): Promise<ExportResult> {
  return (await control<{ export: ExportResult }>(info, `/vaults/${encodeURIComponent(id)}/export`, { method: "GET" }, fetchImpl)).export;
}
export async function fetchLogTail(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return (await control<{ lines: string[] }>(info, "/logs/tail", { method: "GET" }, fetchImpl)).lines;
}
export async function shutdownEngine(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<{ stopping: boolean }> {
  return control(info, "/shutdown", { method: "POST" }, fetchImpl);
}
