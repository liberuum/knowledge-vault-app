import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatGptError } from "../chatgpt/session.js";
import type { AppSettings } from "../settings.js";
import { createChatGptBridge, toResponsesRequest, TOOL_NAMESPACE, type ChatGptSessionLike } from "./chatgpt.js";
import { chatGptFailureFromBody } from "./errors.js";
import { createGateway, GATEWAY_PATH } from "./gateway.js";
import { JSON_INSTRUCTION } from "./json.js";

type Json = Record<string, unknown>;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const sse = (events: Json[]) => events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const completed = (extra: Json = {}) => ({ type: "response.completed", response: { id: "resp_1", model: "gpt-6.1-sol", status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 }, ...extra } });
const TEXT_EVENTS = [
  { type: "response.created", response: { id: "resp_1", model: "gpt-6.1-sol", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hel" },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "lo" },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } },
  completed(),
];
const TOOL_EVENTS = [
  { type: "response.created", response: { id: "resp_2", model: "gpt-6.1-sol" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "search_notes", namespace: TOOL_NAMESPACE, arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"query":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '"tides"}' },
  { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"query":"tides"}' },
  { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "search_notes", arguments: '{"query":"tides"}' } },
  completed({ id: "resp_2" }),
];

type Upstream = { status?: number; events?: Json[]; body?: string; headers?: Record<string, string>; drop?: boolean };
/** A fake Responses API: each request gets the next scripted answer; what it was sent is kept. */
async function responsesApi(script: Upstream[]) {
  const seen: Array<{ auth?: string; body: Json }> = [];
  const base = await listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({ ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body: JSON.parse(Buffer.concat(chunks).toString() || "{}") as Json });
    const step = script[Math.min(seen.length - 1, script.length - 1)]!;
    if (step.status && step.status !== 200) {
      res.writeHead(step.status, { "content-type": "application/json", ...step.headers }).end(step.body ?? "{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", ...step.headers });
    res.write(sse(step.events ?? []));
    if (step.drop) setTimeout(() => res.socket?.destroy(), 20); // after the first events have gone out
    else res.end();
  });
  return { base: `${base}/v1`, seen };
}

function session(over: Partial<ChatGptSessionLike> = {}) {
  let token = "at-1";
  return {
    accessToken: vi.fn(async () => token),
    refreshAccessToken: vi.fn(async () => (token = "at-2")),
    models: vi.fn(async () => [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }]),
    noteUsageLimit: vi.fn(),
    noteSuccess: vi.fn(),
    ...over,
  };
}
const chatgptSettings: AppSettings = {
  version: 1,
  models: { endpoint: "https://api.openai.com/v1", model: "gpt-6.1-sol", hasKey: true, local: false, provider: "chatgpt" },
  conversion: { mode: "off", remoteUrl: "" },
  ui: { closeToTray: true },
};
/** The real gateway with the ChatGPT provider set, its bridge pointed at the fake API. */
async function gatewayFor(apiBase: string, s: ChatGptSessionLike) {
  const gw = createGateway({ readSettings: () => chatgptSettings, readModelKey: () => undefined, chatgpt: createChatGptBridge({ session: s, apiBase, sleep: async () => {} }) });
  return listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    await gw.handle(req, res, Buffer.concat(chunks), {});
  });
}
const ask = (base: string, body: Json, headers: Record<string, string> = {}) =>
  fetch(`${base}${GATEWAY_PATH}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const frames = (text: string) =>
  text
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => b.slice(6))
    .map((d) => (d === "[DONE]" ? d : (JSON.parse(d) as Json)));
const PIPELINE_CALL = {
  messages: [{ role: "system", content: "Extract claims as JSON." }, { role: "user", content: "The text." }],
  response_format: { type: "json_object" },
  temperature: 0.2,
  max_tokens: 24_000,
  reasoning: { effort: "low" },
  usage: { include: true },
};

describe("Chat Completions → Responses", () => {
  it("moves system text to instructions, groups the tools in a namespace, maps formats and turns, and leaves out what the route refuses", () => {
    const { body, json } = toResponsesRequest({
      model: "gpt-6.1-sol",
      messages: [
        { role: "system", content: "You answer from the vault." },
        { role: "user", content: [{ type: "text", text: "What is in this figure?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }] },
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "search_notes", arguments: '{"query":"tides"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "3 notes" },
        { role: "system", content: "Cite the notes." },
      ],
      tools: [{ type: "function", function: { name: "search_notes", description: "Search the vault.", parameters: { type: "object", properties: { query: { type: "string" } } } } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: { type: "object", properties: { a: { type: "string" } } } } },
      reasoning_effort: "medium",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 4000,
      max_completion_tokens: 4000,
      user: "u",
      metadata: { a: "b" },
      stop: ["\n"],
      n: 1,
    });
    expect(json).toBe(true);
    expect(body).toEqual({
      model: "gpt-6.1-sol",
      instructions: "You answer from the vault.",
      input: [
        { role: "user", content: [{ type: "input_text", text: "What is in this figure?" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" }] },
        { type: "function_call", call_id: "call_1", name: "search_notes", arguments: '{"query":"tides"}', namespace: TOOL_NAMESPACE },
        { type: "function_call_output", call_id: "call_1", output: "3 notes" },
        { role: "developer", content: "Cite the notes." },
      ],
      store: false,
      stream: true,
      tools: [{ type: "namespace", name: TOOL_NAMESPACE, description: expect.any(String), tools: [{ type: "function", name: "search_notes", description: "Search the vault.", parameters: { type: "object", properties: { query: { type: "string" } } } }] }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      text: { format: { type: "json_schema", name: "answer", strict: true, schema: { type: "object", properties: { a: { type: "string" } } } } },
      reasoning: { effort: "medium" },
    });
  });

  it("holds JSON to the instructions when the format itself was refused", () => {
    const { body } = toResponsesRequest({ model: "m", ...PIPELINE_CALL }, new Set(["text"]));
    expect(body.text).toBeUndefined();
    expect(body.instructions).toBe("Extract claims as JSON.\n\nAnswer with one JSON object and nothing else: no prose, no Markdown code fences.");
    expect(body.reasoning).toEqual({ effort: "low" });
  });
});

describe("the ChatGPT bridge in the gateway", () => {
  it("streams text back as Chat Completions chunks", async () => {
    const api = await responsesApi([{ events: TEXT_EVENTS }]);
    const s = session();
    const gw = await gatewayFor(api.base, s);
    const res = await ask(gw, { stream: true, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const out = frames(await res.text());
    expect(out.at(-1)).toBe("[DONE]");
    const chunks = out.slice(0, -1) as Json[];
    expect(chunks.map((c) => (c.choices as Json[])[0])).toEqual([
      { index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null },
      { index: 0, delta: { content: "lo" }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]);
    expect(chunks[0]).toMatchObject({ id: "chatcmpl-resp_1", object: "chat.completion.chunk", model: "gpt-6.1-sol" });
    expect(api.seen[0]).toEqual({ auth: "Bearer at-1", body: { model: "gpt-6.1-sol", instructions: "Be brief.", input: [{ role: "user", content: "Hi" }], store: false, stream: true } });
    expect(s.noteSuccess).toHaveBeenCalled();
  });

  it("streams a tool call: announced with its id and name, then its arguments, finishing with tool_calls", async () => {
    const api = await responsesApi([{ events: TOOL_EVENTS }]);
    const gw = await gatewayFor(api.base, session());
    const tools = [{ type: "function", function: { name: "search_notes", description: "Search.", parameters: { type: "object", properties: {} } } }];
    const out = frames(await (await ask(gw, { stream: true, messages: [{ role: "user", content: "Tides?" }], tools, tool_choice: "auto" })).text());
    const deltas = (out.slice(0, -1) as Json[]).map((c) => (c.choices as Json[])[0]);
    expect(deltas).toEqual([
      { index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search_notes", arguments: "" } }] }, finish_reason: null },
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] }, finish_reason: null },
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"tides"}' } }] }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: "tool_calls" },
    ]);
  });

  it("answers the pipeline's JSON call with one completion: text.format set, refused fields gone", async () => {
    const events = [
      { type: "response.output_text.delta", item_id: "msg_1", delta: '{"claims":' },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "[]}" },
      completed(),
    ];
    const api = await responsesApi([{ events }]);
    const gw = await gatewayFor(api.base, session());
    const res = await ask(gw, PIPELINE_CALL);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toMatchObject({
      object: "chat.completion",
      model: "gpt-6.1-sol",
      choices: [{ index: 0, message: { role: "assistant", content: '{"claims":[]}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    });
    expect(api.seen[0]!.body).toEqual({
      model: "gpt-6.1-sol",
      instructions: `Extract claims as JSON.\n\n${JSON_INSTRUCTION}`,
      // The system prompt became instructions, which JSON mode does not read: the input says it too.
      input: [{ role: "user", content: "The text.\n\nAnswer in JSON." }],
      store: false,
      stream: true,
      text: { format: { type: "json_object" } },
      reasoning: { effort: "low" },
    });
  });

  it("answers the pipeline's tool-using call with tool_calls and no text", async () => {
    const api = await responsesApi([{ events: TOOL_EVENTS }]);
    const gw = await gatewayFor(api.base, session());
    const tools = [{ type: "function", function: { name: "search_notes", description: "Search.", parameters: { type: "object", properties: {} } } }];
    const body = (await (await ask(gw, { messages: [{ role: "user", content: "Tides?" }], tools, tool_choice: "auto", temperature: 0.2 })).json()) as Json;
    expect((body.choices as Json[])[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_notes", arguments: '{"query":"tides"}' } }] },
      finish_reason: "tool_calls",
    });
  });

  it("a usage limit before the answer starts: 429 in plain words, ChatGPT › Settings › Usage named; background requests then pause", async () => {
    const limited = { type: "response.failed", response: { id: "resp_x", status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } };
    const api = await responsesApi([{ events: [limited], headers: { "x-request-id": "req_42" } }, { events: TEXT_EVENTS }]);
    const s = session();
    const gw = await gatewayFor(api.base, s);
    const res = await ask(gw, PIPELINE_CALL);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toEqual({
      message: "Usage limit reached. Review your plan or this app's limit in ChatGPT settings › Usage (https://chatgpt.com/settings/usage).",
      type: "invalid_request_error",
      code: "chatgpt_usage_limit",
      request_id: "req_42",
    });
    expect(s.noteUsageLimit).toHaveBeenCalled();
    expect((await ask(gw, PIPELINE_CALL)).status).toBe(429); // the pipeline waits: ChatGPT is not asked
    expect(api.seen).toHaveLength(1);
    expect((await ask(gw, { messages: [{ role: "user", content: "Hi" }] }, { "x-kv-priority": "interactive" })).status).toBe(200); // the person in the chat may try
    expect(api.seen).toHaveLength(2);
  });

  it("says why a plan cannot be used, and keeps OpenAI's request ID", async () => {
    const api = await responsesApi([{ status: 403, headers: { "x-request-id": "req_7" }, body: JSON.stringify({ error: { code: "subscription_sharing_user_not_eligible", message: "not eligible" } }) }]);
    const gw = await gatewayFor(api.base, session());
    const res = await ask(gw, { messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({ code: "chatgpt_not_eligible", request_id: "req_7", message: expect.stringContaining("Choose another AI model") });
  });

  it("a refused JSON format: asked again without it, held to JSON by the instructions — and not offered again", async () => {
    const refused = JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "text.format", message: "unsupported" } });
    const api = await responsesApi([{ status: 400, body: refused }, { events: [{ type: "response.output_text.delta", item_id: "m", delta: "{}" }, completed()] }]);
    const gw = await gatewayFor(api.base, session());
    expect((await ask(gw, PIPELINE_CALL)).status).toBe(200);
    expect(api.seen.map((r) => r.body.text)).toEqual([{ format: { type: "json_object" } }, undefined]);
    expect(api.seen[1]!.body.instructions).toContain("Answer with one JSON object");
    await ask(gw, PIPELINE_CALL);
    expect(api.seen[2]!.body.text).toBeUndefined();
  });

  it("a refused token is renewed once and the request sent again", async () => {
    const api = await responsesApi([{ status: 401, body: JSON.stringify({ detail: "Unauthorized" }) }, { events: TEXT_EVENTS }]);
    const s = session();
    const gw = await gatewayFor(api.base, s);
    expect((await ask(gw, { messages: [{ role: "user", content: "Hi" }] })).status).toBe(200);
    expect(s.refreshAccessToken).toHaveBeenCalledWith("at-1");
    expect(api.seen.map((r) => r.auth)).toEqual(["Bearer at-1", "Bearer at-2"]);
  });

  it("usage that cannot be checked right now is waited out with a bounded backoff", async () => {
    const unavailable = { status: 503, body: JSON.stringify({ error: { code: "subscription_sharing_usage_unavailable" } }) };
    const api = await responsesApi([unavailable, unavailable, { events: TEXT_EVENTS }]);
    const gw = await gatewayFor(api.base, session());
    expect((await ask(gw, { messages: [{ role: "user", content: "Hi" }] })).status).toBe(200);
    const always = await responsesApi([unavailable]);
    const gw2 = await gatewayFor(always.base, session());
    const res = await ask(gw2, { messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(503);
    expect(always.seen).toHaveLength(3);
    expect((await res.json()).error.message).toBe("ChatGPT could not check your plan's usage just now. Try again in a few minutes.");
  });

  it("only response.completed is an answer: a stream that stops is an error, before or during the reply", async () => {
    const cut = await responsesApi([{ events: [{ type: "response.output_text.delta", item_id: "m", delta: "Hal" }], drop: true }]);
    const gw = await gatewayFor(cut.base, session());
    const json = await ask(gw, PIPELINE_CALL);
    expect(json.status).toBe(502);
    expect((await json.json()).error).toMatchObject({ code: "provider_dropped", message: "ChatGPT stopped answering before it replied." });
    const text = await (await ask(gw, { stream: true, messages: [{ role: "user", content: "Hi" }] })).text();
    expect(text).toContain('"content":"Hal"');
    expect(text).toContain("ChatGPT stopped answering in the middle of the reply.");
    expect(text).not.toContain("[DONE]");
  });

  it("not signed in: the sign-in's own sentence, before anything is sent", async () => {
    const api = await responsesApi([{ events: TEXT_EVENTS }]);
    const gw = await gatewayFor(api.base, session({ accessToken: async () => Promise.reject(new ChatGptError("Sign in with ChatGPT first: Settings › Models › Continue with ChatGPT.", 401, "chatgpt_signed_out")) }));
    const res = await ask(gw, { messages: [{ role: "user", content: "Hi" }] });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatchObject({ code: "chatgpt_signed_out", message: "Sign in with ChatGPT first: Settings › Models › Continue with ChatGPT." });
    expect(api.seen).toHaveLength(0);
  });

  it("lists the account's models in the OpenAI shape", async () => {
    const gw = await gatewayFor("http://127.0.0.1:9/v1", session());
    expect(await (await fetch(`${gw}${GATEWAY_PATH}/models`)).json()).toEqual({ object: "list", data: [{ id: "gpt-6.1-sol", object: "model", created: 0, owned_by: "openai", name: "GPT-6.1 Sol" }] });
  });
});

describe("ChatGPT refusals in plain words", () => {
  it("reads OpenAI's codes, and an admission `detail` only as text", () => {
    expect(chatGptFailureFromBody(403, JSON.stringify({ detail: "Unsupported country, region, or territory" }))).toEqual({ status: 403, message: "ChatGPT refused the request: Unsupported country, region, or territory.", code: "chatgpt_refused" });
    expect(chatGptFailureFromBody(401, JSON.stringify({ detail: "Unauthorized" })).message).toBe(
      "ChatGPT did not accept the sign-in for plan use: Unauthorized. Check the account you signed in with, and that Knowledge Vault may use your plan.",
    );
    expect(chatGptFailureFromBody(503, "")).toMatchObject({ status: 503, code: "chatgpt_unavailable" });
    expect(chatGptFailureFromBody(400, JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "tools" } }))).toMatchObject({
      status: 400,
      code: "chatgpt_unsupported",
      param: "tools",
      message: "Your ChatGPT plan cannot be used for part of this request (tools).",
    });
    expect(chatGptFailureFromBody(403, JSON.stringify({ error: { code: "chatpass_v2_scope_not_authorized" } })).code).toBe("chatgpt_permission");
    expect(chatGptFailureFromBody(404, JSON.stringify({ error: { message: "The model `x` does not exist" } })).code).toBe("provider_model");
  });
});

describe("JSON mode and the word json (OpenAI requires it in the input messages)", () => {
  it("asks for JSON in the last user message when only the system prompt said so", () => {
    const { body } = toResponsesRequest({ model: "m", messages: [{ role: "system", content: "Return JSON with the claims." }, { role: "user", content: "Extract the claims." }], response_format: { type: "json_object" } });
    expect(body.instructions).toBe("Return JSON with the claims.");
    expect((body.input as Array<{ content: unknown }>).at(-1)?.content).toBe("Extract the claims.\n\nAnswer in JSON.");
  });
  it("leaves the messages alone when they already mention JSON", () => {
    const { body } = toResponsesRequest({ model: "m", messages: [{ role: "user", content: "Reply with a JSON object." }], response_format: { type: "json_object" } });
    expect((body.input as Array<{ content: unknown }>).at(-1)?.content).toBe("Reply with a JSON object.");
  });
});

