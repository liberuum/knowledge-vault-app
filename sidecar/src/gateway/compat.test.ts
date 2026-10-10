import { describe, expect, it } from "vitest";
import { adaptPayload, withoutRefusedParameter } from "./compat.js";

const ask = { model: "o4-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 4000, temperature: 0.2 };

describe("requests every model of a service takes", () => {
  it("gives OpenAI max_completion_tokens, and leaves other services alone", () => {
    expect(adaptPayload("https://api.openai.com/v1", ask)).toEqual({ model: "o4-mini", messages: ask.messages, max_completion_tokens: 4000, temperature: 0.2 });
    expect(adaptPayload("https://api.x.ai/v1", ask)).toBe(ask);
    expect(adaptPayload("http://127.0.0.1:8080/v1", ask)).toBe(ask);
  });
  it("drops what a model refuses by name, renames max_tokens, and never touches the request's core", () => {
    const temperature = JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.", param: "temperature", code: "unsupported_value" } });
    expect(withoutRefusedParameter(ask, temperature)).toEqual({ model: "o4-mini", messages: ask.messages, max_tokens: 4000 });
    const maxTokens = JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: "max_tokens", code: "unsupported_parameter" } });
    expect(withoutRefusedParameter(ask, maxTokens)).toEqual({ model: "o4-mini", messages: ask.messages, temperature: 0.2, max_completion_tokens: 4000 });
    expect(withoutRefusedParameter(ask, "Unsupported value: 'temperature' must be 1")).toEqual({ model: "o4-mini", messages: ask.messages, max_tokens: 4000 }); // a message alone
    expect(withoutRefusedParameter(ask, JSON.stringify({ error: { message: "Invalid model", param: "model", code: "unsupported_value" } }))).toBeNull();
    expect(withoutRefusedParameter(ask, JSON.stringify({ error: { message: "The prompt is too long", param: "messages" } }))).toBeNull();
    expect(withoutRefusedParameter(ask, JSON.stringify({ error: { message: "Rate limit reached" } }))).toBeNull();
  });
});
