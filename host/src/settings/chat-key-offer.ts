import type { ModelSettings } from "../vaults.js";

/** Remembers the answer, so the offer is made once: "used" or "declined". */
export const OFFER_KEY = "kv-chat-key-offer:v1";

/**
 * An OpenRouter key the vault chat saved in this window (before the chat ran on the app's model), offered once to
 * become the app's key. Not while the app has a key or runs a model on this computer, which needs none.
 */
export function chatKeyOffer(storage: Pick<Storage, "getItem">, models: ModelSettings): string | null {
  if (models.hasKey || models.local === true || storage.getItem(OFFER_KEY)) return null;
  const direct = storage.getItem("bai-chat-credentials:v1")?.trim();
  if (direct) return direct;
  try {
    const saved = JSON.parse(storage.getItem("bai-chat-providers:v1") ?? "null") as { openrouter?: { key?: unknown } } | null;
    const key = saved?.openrouter?.key;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

export function answerChatKeyOffer(storage: Pick<Storage, "setItem">, answer: "used" | "declined"): void {
  storage.setItem(OFFER_KEY, answer);
}
