import type { HostModel } from "./bootstrap.js";
import { routeHash } from "./shell/router.js";
import type { SidecarInfo } from "./sidecar.js";
import type { ModelSettings } from "./vaults.js";

const VIA: Record<ModelSettings["provider"], string> = {
  local: "on this computer",
  openrouter: "via OpenRouter",
  openai: "via OpenAI",
  anthropic: "via Anthropic",
  gemini: "via Google Gemini",
  xai: "via xAI",
  custom: "via your model server",
};
export const modelLabel = (models: ModelSettings) => `${models.model} ${VIA[models.provider]}`;

/** The model the vault's chat uses: the engine's gateway, reached with the control token the page already holds. */
export function modelDeclaration(info: SidecarInfo, models: ModelSettings): HostModel | null {
  if (!models.model.trim() || (!models.hasKey && !models.local)) return null;
  return {
    baseUrl: `${info.controlOrigin}/llm/v1`,
    model: models.model,
    label: modelLabel(models),
    // The vault calls this while it renders: keep it to this one expression, which cannot throw.
    headers: () => ({ authorization: `Bearer ${info.controlToken}` }),
  };
}

/** Settings › Models saved: the app reads the model again and re-declares it to the vault. */
export const MODELS_CHANGED_EVENT = "kv:models-changed";
export function announceModelsChanged(): void {
  if (typeof globalThis.dispatchEvent === "function" && typeof Event === "function") globalThis.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
}

/**
 * The vault chat's "set up a model" and "change in Settings": open Settings › Models. The vault calls it from
 * outside the app's React tree, so it moves the hash, which the router follows (`useRoute` listens for hashchange).
 */
export function openModelSettings(): void {
  window.location.hash = routeHash({ name: "settings", section: "models" });
}
