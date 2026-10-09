import { PROVIDER_LABELS, type ModelProvider } from "../settings.js";
import { refusesKey } from "../provider-auth.js";

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
  if (refusesKey(status, detail)) return { message: `${who} refused the API key${tail}`, code: "provider_auth" };
  if (status === 402) return { message: `${who} says the account is out of credit${tail}`, code: "provider_credit" };
  if (status === 429) return { message: `${who} is rate-limiting requests${tail}`, code: "provider_rate_limit" };
  if (status === 404) return { message: `${who} does not have this model${tail}`, code: "provider_model" };
  return { message: `${who} answered ${status}${tail}`, code: "provider_error" };
}

/** ChatGPT › Settings › Usage, where the user reviews plan usage and this app's limit. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/**
 * ChatGPT plan usage: OpenAI's codes, the status each comes with, and what the user can do
 * (developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).
 */
const CHATGPT_CODES: Record<string, { status: number; code: string; message: (param?: string) => string }> = {
  subscription_sharing_usage_limit_exceeded: {
    status: 429,
    code: "chatgpt_usage_limit",
    message: () => `Usage limit reached. Review your plan or this app's limit in ChatGPT settings › Usage (${CHATGPT_USAGE_URL}).`,
  },
  subscription_sharing_user_not_eligible: {
    status: 403,
    code: "chatgpt_not_eligible",
    message: () => "Your ChatGPT plan can't be used in Knowledge Vault: ChatGPT says your account, workspace or its policy does not allow it. Choose another AI model in Settings › Models.",
  },
  subscription_sharing_usage_unavailable: { status: 503, code: "chatgpt_unavailable", message: () => "ChatGPT could not check your plan's usage just now. Try again in a few minutes." },
  subscription_sharing_user_unavailable: { status: 503, code: "chatgpt_unavailable", message: () => "ChatGPT could not look up your account just now. Try again in a few minutes." },
  subscription_sharing_unsupported_capability: {
    status: 400,
    code: "chatgpt_unsupported",
    message: (param) => `Your ChatGPT plan cannot be used for part of this request${param ? ` (${param})` : ""}.`,
  },
  subscription_sharing_route_not_supported: {
    status: 403,
    code: "chatgpt_route",
    message: () => "ChatGPT refused this kind of request on your plan. Please report it to Knowledge Vault's developers.",
  },
  subscription_sharing_invalid_user: {
    status: 401,
    code: "chatgpt_auth",
    message: () => "ChatGPT could not confirm your sign-in. If this keeps happening, sign out of ChatGPT in Settings › Models and sign in again.",
  },
  chatpass_v2_scope_not_authorized: {
    status: 403,
    code: "chatgpt_permission",
    message: () => "ChatGPT says this sign-in does not let Knowledge Vault use your plan for this request. Sign out of ChatGPT in Settings › Models, then sign in again and allow plan use.",
  },
  chatpass_v2_invalid_authorization_context: {
    status: 403,
    code: "chatgpt_permission",
    message: () => "ChatGPT says this sign-in does not let Knowledge Vault use your plan for this request. Sign out of ChatGPT in Settings › Models, then sign in again and allow plan use.",
  },
};

/** A ChatGPT refusal: the status to answer with, a sentence, and OpenAI's own code, parameter and request ID. */
export type ChatGptFailure = { status: number; message: string; code: string; upstreamCode?: string; param?: string; requestId?: string };

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** "Lead: detail." — or "Lead." without one; a detail keeps its own final stop. */
const withDetail = (lead: string, detail: string | undefined) => (detail ? `${lead}: ${/[.!?]$/.test(detail) ? detail : `${detail}.`}` : `${lead}.`);

/**
 * What a ChatGPT refusal means, in words a person can act on — an HTTP answer before the stream opened, or a
 * failed event inside it (no status of its own). Admission failures may carry only `{"detail": "…"}`: that text
 * is shown as it is, never read as a code.
 */
export function chatGptFailure(status: number | undefined, error: { code?: unknown; message?: unknown; param?: unknown; detail?: unknown }, requestId?: string): ChatGptFailure {
  const upstreamCode = text(error.code);
  const param = text(error.param);
  const detail = text(error.message) ?? text(error.detail);
  const extra = { ...(upstreamCode ? { upstreamCode } : {}), ...(param ? { param } : {}), ...(requestId ? { requestId } : {}) };
  const known = upstreamCode ? CHATGPT_CODES[upstreamCode] : undefined;
  if (known) return { status: known.status, message: known.message(param), code: known.code, ...extra };
  const s = status ?? (upstreamCode === "rate_limit_exceeded" ? 429 : upstreamCode === "model_not_found" ? 404 : 502);
  if (s === 404 || upstreamCode === "model_not_found") return { status: 404, message: "ChatGPT does not offer this model to your account. Choose another one in Settings › Models.", code: "provider_model", ...extra };
  if (s === 401) {
    return { status: 401, message: `${withDetail("ChatGPT did not accept the sign-in for plan use", detail)} Check the account you signed in with, and that Knowledge Vault may use your plan.`, code: "chatgpt_auth", ...extra };
  }
  if (s === 403) return { status: 403, message: withDetail("ChatGPT refused the request", detail), code: "chatgpt_refused", ...extra };
  if (s === 429) return { status: 429, message: withDetail("ChatGPT is rate-limiting requests", detail), code: "provider_rate_limit", ...extra };
  if (s === 503) return { status: 503, message: `ChatGPT plan use is not available right now${detail ? ` (${detail})` : ""}. Try again in a few minutes.`, code: "chatgpt_unavailable", ...extra };
  return { status: s, message: withDetail(status === undefined ? "ChatGPT could not answer" : `ChatGPT answered ${s}`, detail), code: "provider_error", ...extra };
}

/** The same, from an HTTP body: OpenAI's `{error: {code, message, param}}`, an admission `{detail}`, or plain text. */
export function chatGptFailureFromBody(status: number, bodyText: string, requestId?: string): ChatGptFailure {
  let error: { code?: unknown; message?: unknown; param?: unknown; detail?: unknown } = {};
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; detail?: unknown; message?: unknown };
    if (parsed.error && typeof parsed.error === "object") error = parsed.error as typeof error;
    else if (typeof parsed.error === "string") error = { message: parsed.error };
    else error = { detail: parsed.detail ?? parsed.message };
  } catch {
    error = { detail: bodyText.trim().slice(0, 300) };
  }
  return chatGptFailure(status, error, requestId);
}
