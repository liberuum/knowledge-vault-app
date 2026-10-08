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
