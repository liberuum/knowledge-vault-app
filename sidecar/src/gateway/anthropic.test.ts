import { describe, expect, it, vi } from "vitest";
import { anthropicJson } from "./anthropic.js";

function fakeFetch(status: number, json: unknown) {
  return vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch & { mock: { calls: [string, RequestInit][] } };
}
const body = {
  model: "claude-sonnet-5",
  max_tokens: 4000,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: "Extract claims." },
    { role: "user", content: "The text." },
  ],
};

describe("anthropicJson", () => {
  it("sends the system text apart and forces one JSON tool", async () => {
    const f = fakeFetch(200, { id: "msg_1", model: "claude-sonnet-5", stop_reason: "tool_use", content: [{ type: "tool_use", name: "answer", input: { claims: ["a"] } }], usage: { input_tokens: 10, output_tokens: 5 } });
    const out = await anthropicJson({ endpoint: "https://api.anthropic.com/v1", key: "sk-ant", body, fetchImpl: f, signal: new AbortController().signal });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system: "Extract claims.",
      messages: [{ role: "user", content: "The text." }],
      tools: [{ name: "answer", description: "Return the answer as one JSON object.", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "answer" },
    });
    expect(out).toEqual({
      status: 200,
      json: {
        id: "msg_1",
        object: "chat.completion",
        model: "claude-sonnet-5",
        choices: [{ index: 0, message: { role: "assistant", content: '{"claims":["a"]}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });
  });

  it("uses a json_schema's schema, and reports a cut-off answer as length", async () => {
    const f = fakeFetch(200, { id: "m", model: "c", stop_reason: "max_tokens", content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const out = await anthropicJson({ endpoint: "https://api.anthropic.com/v1", key: "k", body: { ...body, response_format: { type: "json_schema", json_schema: { name: "x", schema } } }, fetchImpl: f, signal: new AbortController().signal });
    expect(JSON.parse(String(f.mock.calls[0]![1].body)).tools[0].input_schema).toEqual(schema);
    expect((out.json as { choices: [{ finish_reason: string; message: { content: string } }] }).choices[0]).toMatchObject({ finish_reason: "length", message: { content: "" } });
  });

  it("passes a refusal through in OpenAI's shape", async () => {
    const f = fakeFetch(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const out = await anthropicJson({ endpoint: "https://api.anthropic.com/v1", key: "bad", body, fetchImpl: f, signal: new AbortController().signal });
    expect(out).toEqual({ status: 401, json: { error: { message: "Anthropic refused the API key: invalid x-api-key", type: "invalid_request_error", code: "provider_auth" } } });
  });
});
