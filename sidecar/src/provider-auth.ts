/**
 * How each provider wants its key, and how it says no. Anthropic's API authenticates with `x-api-key` and requires
 * `anthropic-version` on its native endpoints (its model list among them); every other provider here takes the key
 * as a bearer token. Google and xAI refuse a bad key with 400 rather than 401, naming the key in the message.
 */
export const ANTHROPIC_VERSION = "2023-06-01";

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export const isAnthropicEndpoint = (endpoint: string): boolean => hostOf(endpoint) === "api.anthropic.com";
export const isGeminiEndpoint = (endpoint: string): boolean => hostOf(endpoint) === "generativelanguage.googleapis.com";

export function providerHeaders(endpoint: string, key: string | undefined): Record<string, string> {
  if (!key) return {};
  return isAnthropicEndpoint(endpoint) ? { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } : { authorization: `Bearer ${key}` };
}

/** The model list's address: Anthropic pages it (20 by default), so all of it is asked for at once. */
export function modelsUrl(endpoint: string): string {
  const base = `${endpoint.replace(/\/+$/, "")}/models`;
  return isAnthropicEndpoint(endpoint) ? `${base}?limit=1000` : base;
}

/** A model id as the provider's chat takes it: Gemini lists `models/gemini-…`, its chat and Google's examples use the bare name. */
export const chatModelId = (endpoint: string, id: string): string => (isGeminiEndpoint(endpoint) ? id.replace(/^models\//, "") : id);

/** The provider refused the key itself: 401 and 403, and a 400 whose message is about the key (Google, xAI). */
export function refusesKey(status: number, message: string | undefined): boolean {
  return status === 401 || status === 403 || (status === 400 && /api[ _-]?key|x-api-key/i.test(message ?? ""));
}
