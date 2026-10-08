/**
 * The onboarding's live check: one tiny JSON request through the engine's own gateway — the path the chat and the
 * pipeline take, with the saved key, the provider's JSON handling and the queue — timed. "Ready" means the model
 * answered with JSON, which is what processing needs; anything else says what went wrong.
 */
export type ModelCheck = { ok: true; ms: number; model: string } | { ok: false; detail: string };

const PROMPT = 'Reply with exactly this JSON object and nothing else: {"ready": true}';

function jsonIn(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

export async function checkModel(opts: { gatewayUrl: string; gatewayKey: string; provider?: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number }): Promise<ModelCheck> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const started = now();
  let res: Response;
  try {
    res = await f(`${opts.gatewayUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.gatewayKey}`, "x-kv-priority": "interactive" },
      // Room for a reasoning model to think first (review I2); OpenRouter alone takes a reasoning effort, others would refuse the field.
      body: JSON.stringify({ messages: [{ role: "user", content: PROMPT }], response_format: { type: "json_object" }, max_tokens: 4000, stream: false, ...(opts.provider === "openrouter" ? { reasoning: { effort: "low" } } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, detail: `No answer within ${Math.round(timeoutMs / 60_000)} minutes. A large model on this computer may still be loading: try again in a minute.` };
    }
    return { ok: false, detail: `Could not reach the model: ${error instanceof Error ? error.message : String(error)}` };
  }
  const text = await res.text();
  let body: { error?: { message?: string }; model?: string; choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }> } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // a non-JSON body is reported below
  }
  if (!res.ok) return { ok: false, detail: body.error?.message ?? `The model answered HTTP ${res.status}.` };
  const content = body.choices?.[0]?.message?.content ?? "";
  if (!content.trim() && body.choices?.[0]?.finish_reason === "length") {
    return { ok: false, detail: "The model spent its whole answer thinking and gave none. Reasoning models can do the same while processing: try again, or choose a model that answers directly." };
  }
  const parsed = jsonIn(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, detail: "The model answered, but not with the JSON that processing needs. Choose another model." };
  }
  return { ok: true, ms: Math.max(0, now() - started), model: body.model ?? "" };
}
