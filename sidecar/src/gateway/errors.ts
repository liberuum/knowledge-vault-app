import { PROVIDER_LABELS, type ModelProvider } from "../settings.js";

export function openAiError(status: number, message: string, code?: string) {
  return { error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", ...(code ? { code } : {}) } };
}

/** The provider's own sentence, when its body carries one. */
function detailOf(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    return typeof m === "string" ? m.trim() : "";
  } catch {
    return bodyText.trim().slice(0, 300);
  }
}

/** What a provider's refusal means, in words a person can act on. */
export function providerMessage(provider: ModelProvider, status: number, bodyText: string): { message: string; code: string } {
  const who = provider === "local" ? "The model server on this computer" : PROVIDER_LABELS[provider];
  const detail = detailOf(bodyText);
  const tail = detail ? `: ${detail}` : ".";
  if (status === 401 || status === 403) return { message: `${who} refused the API key${tail}`, code: "provider_auth" };
  if (status === 402) return { message: `${who} says the account is out of credit${tail}`, code: "provider_credit" };
  if (status === 429) return { message: `${who} is rate-limiting requests${tail}`, code: "provider_rate_limit" };
  if (status === 404) return { message: `${who} does not have this model${tail}`, code: "provider_model" };
  return { message: `${who} answered ${status}${tail}`, code: "provider_error" };
}
