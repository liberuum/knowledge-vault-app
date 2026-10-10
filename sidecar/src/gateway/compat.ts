/**
 * Requests that every model of a service takes. OpenAI's newer models (o-series, GPT-5 and later) refuse
 * `max_tokens` (they take `max_completion_tokens`, which all its chat models accept) and any `temperature` but the
 * default. The pipeline and the chat send what most models take; the gateway adapts it, and when a service refuses
 * one named parameter, drops it and asks again.
 */
const isOpenAi = (endpoint: string): boolean => {
  try {
    return new URL(endpoint).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
};

/** Before the first ask: OpenAI gets `max_completion_tokens`, which all its chat models take. */
export function adaptPayload(endpoint: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (!isOpenAi(endpoint) || payload.max_tokens === undefined || payload.max_completion_tokens !== undefined) return payload;
  const { max_tokens: maxTokens, ...rest } = payload;
  return { ...rest, max_completion_tokens: maxTokens };
}

/** Never dropped: without them there is no request. */
const ESSENTIAL = new Set(["model", "messages", "stream"]);

/**
 * After a 400 that refuses one parameter by name (OpenAI's `param` and `unsupported_parameter` /
 * `unsupported_value`, or a message like "Unsupported value: 'temperature'"): the payload without it, `max_tokens`
 * renamed rather than dropped; null when the refusal is about something else.
 */
export function withoutRefusedParameter(payload: Record<string, unknown>, bodyText: string): Record<string, unknown> | null {
  let param: unknown;
  let code: unknown;
  let message = "";
  try {
    const error = (JSON.parse(bodyText) as { error?: { param?: unknown; code?: unknown; message?: unknown } }).error;
    param = error?.param;
    code = error?.code;
    message = typeof error?.message === "string" ? error.message : "";
  } catch {
    message = bodyText;
  }
  if (typeof param !== "string" || !param) param = /unsupported (?:parameter|value):?\s*'([a-z_]+)'/i.exec(message)?.[1];
  if (typeof param !== "string" || ESSENTIAL.has(param) || !(param in payload)) return null;
  const refusal = code === "unsupported_parameter" || code === "unsupported_value" || /unsupported|not supported/i.test(message);
  if (!refusal) return null;
  const next = { ...payload };
  if (param === "max_tokens") {
    if (next.max_completion_tokens === undefined) next.max_completion_tokens = next.max_tokens;
  }
  delete next[param];
  return next;
}
