import { openAiError, providerMessage } from "./errors.js";
import type { AnthropicJson } from "./gateway.js";

type Message = { role: string; content: unknown };
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : "";

/**
 * A JSON request to Anthropic: system and developer messages become `system`, the rest alternate
 * user/assistant, and one forced tool carries the schema; its input comes back as the answer text.
 */
export const anthropicJson: AnthropicJson = async ({ endpoint, key, body, fetchImpl, signal }) => {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
  const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  const turns = messages.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: textOf(m.content) }));
  const format = body.response_format as { type?: string; json_schema?: { schema?: unknown } } | undefined;
  const schema = format?.type === "json_schema" && format.json_schema?.schema ? format.json_schema.schema : { type: "object" };
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : 8192;
  const response = await fetchImpl(`${endpoint.replace(/\/+$/, "")}/messages`, {
    method: "POST",
    signal,
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: body.model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: turns,
      tools: [{ name: "answer", description: "Return the answer as one JSON object.", input_schema: schema }],
      tool_choice: { type: "tool", name: "answer" },
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    const { message, code } = providerMessage("anthropic", response.status, text);
    return { status: response.status, json: openAiError(response.status, message, code) };
  }
  const json = JSON.parse(text) as { id: string; model: string; stop_reason?: string; content?: Array<{ type: string; input?: unknown }>; usage?: { input_tokens?: number; output_tokens?: number } };
  const tool = (json.content ?? []).find((c) => c.type === "tool_use");
  const prompt = json.usage?.input_tokens ?? 0;
  const completion = json.usage?.output_tokens ?? 0;
  return {
    status: 200,
    json: {
      id: json.id,
      object: "chat.completion",
      model: json.model,
      choices: [{ index: 0, message: { role: "assistant", content: tool ? JSON.stringify(tool.input ?? {}) : "" }, finish_reason: json.stop_reason === "max_tokens" ? "length" : "stop" }],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    },
  };
};
