import type { SidecarInfo } from "../sidecar.js";
import { control, saveSettings, type AppSettings } from "../vaults.js";
import type { OnboardingState } from "./onboarding-state.js";

/** One tiny JSON request through the engine's gateway, timed: what "Ready" rests on. */
export type ModelCheck = { ok: true; ms: number; model: string } | { ok: false; detail: string };
export type AddedSource = { id: string; title: string; queued: boolean };

export function checkModel(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<ModelCheck> {
  return control<ModelCheck>(info, "/settings/models/check", { method: "POST" }, fetchImpl);
}

/** The bundled guide, "How Knowledge Vault works", filed in the vault and queued. */
export async function addSample(info: SidecarInfo, vaultId: string, fetchImpl: typeof fetch = fetch): Promise<AddedSource> {
  return (await control<{ source: AddedSource }>(info, `/vaults/${encodeURIComponent(vaultId)}/sources`, { method: "POST", body: JSON.stringify({ sample: true }) }, fetchImpl)).source;
}

/** Pasted text as a source, titled by its first line, and queued. */
export async function addText(info: SidecarInfo, vaultId: string, content: string, fetchImpl: typeof fetch = fetch): Promise<AddedSource> {
  return (await control<{ source: AddedSource }>(info, `/vaults/${encodeURIComponent(vaultId)}/sources`, { method: "POST", body: JSON.stringify({ content }) }, fetchImpl)).source;
}

export function finishOnboarding(info: SidecarInfo, state: OnboardingState, fetchImpl: typeof fetch = fetch): Promise<AppSettings> {
  return saveSettings(info, { ui: { onboarding: state } }, fetchImpl);
}

/** A new vault, with whether its processing is set up — the guide says so instead of finding out later (review I1). */
export type PipelineSetup = { state: "ready" } | { state: "unconfigured" } | { state: "failed"; error: string };
export async function createGuideVault(info: SidecarInfo, name: string, fetchImpl: typeof fetch = fetch): Promise<{ vault: { id: string; name: string }; pipeline: PipelineSetup }> {
  return control<{ vault: { id: string; name: string }; pipeline: PipelineSetup }>(info, "/vaults", { method: "POST", body: JSON.stringify({ name }) }, fetchImpl);
}

/** Starter workflows (spec 2026-10-15): ready-made Workflow Studio workflows that bring sources into a vault. */
export type StarterId = "feed" | "papers" | "granola";
export type StarterSummary = { workflowId: string; starter: StarterId; label: string; name: string; createdAt: string; status: string };
export type AddedStarter = StarterSummary & { added: number; addError?: string };
export type StarterRequest = { starter: StarterId; feedUrl?: string; topic?: string; apiKey?: string; process: boolean; backfill: boolean };

export async function listStarters(info: SidecarInfo, vaultId: string, fetchImpl: typeof fetch = fetch): Promise<StarterSummary[]> {
  return (await control<{ starters: StarterSummary[] }>(info, `/vaults/${encodeURIComponent(vaultId)}/starters`, { method: "GET" }, fetchImpl)).starters;
}

/** Made, checked and switched on by the engine; a wrong address or key comes back as the error, with nothing left behind. */
export async function addStarter(info: SidecarInfo, vaultId: string, request: StarterRequest, fetchImpl: typeof fetch = fetch): Promise<AddedStarter> {
  return (await control<{ starter: AddedStarter }>(info, `/vaults/${encodeURIComponent(vaultId)}/starters`, { method: "POST", body: JSON.stringify(request) }, fetchImpl)).starter;
}
