import type { ChatGptModel } from "../api/chatgpt.js";

/** The plan's heavyweight variants: slow, and the hardest on the plan's usage — never the default for processing. */
const HEAVY = /\b(pro|thinking|deep[- ]?research|o1-pro)\b/i;

/**
 * The model the app uses when someone signs in with ChatGPT, so there is nothing to choose: the first general model
 * in ChatGPT's own order (its default comes first), skipping the "pro", "thinking" and research variants — a source
 * takes many calls, and a lighter model leaves more of the plan's allowance. Changeable in Settings › Models.
 */
export function defaultChatGptModel(models: readonly ChatGptModel[]): string | undefined {
  return (models.find((m) => !HEAVY.test(m.id) && !HEAVY.test(m.name)) ?? models[0])?.id;
}
