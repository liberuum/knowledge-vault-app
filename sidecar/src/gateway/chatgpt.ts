import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { chatGptFailure, chatGptFailureFromBody, openAiError, type ChatGptFailure } from "./errors.js";

/**
 * The gateway's bridge to a ChatGPT plan (spec §3). The chat and the pipeline speak Chat Completions; ChatGPT
 * plan usage takes only the Responses API, streamed, with `store: false`, and refuses `max_output_tokens`,
 * `temperature`, `top_p`, `user`, `metadata` and system message items (OpenAI's "Models and inference" and
 * "Preview limitations" pages). Each request is translated there, sent streaming, and the answer translated
 * back: Chat Completions chunks for a streaming caller (the chat), one Chat Completions JSON for the others
 * (the pipeline). Nothing here sees a token except the bearer header it sends.
 */

type Json = Record<string, unknown>;

/** What the bridge needs from the sign-in (chatgpt/session.ts); its errors carry `status`, `code` and a sentence. */
export type ChatGptSessionLike = {
  accessToken(): Promise<string>;
  /** ChatGPT refused `rejected`: a renewed token (or the one another request already renewed). */
  refreshAccessToken(rejected?: string): Promise<string>;
  models(): Promise<Array<{ slug: string; name: string }>>;
  noteUsageLimit?(): void;
  noteSuccess?(): void;
};

export type ChatGptBridge = {
  handle(args: { kind: "chat" | "models"; payload: Json; res: ServerResponse; cors: Record<string, string>; signal: AbortSignal; interactive: boolean }): Promise<void>;
};

/** This route takes function tools only grouped in a namespace (or as `additional_tools` items): the caller's go in one. */
export const TOOL_NAMESPACE = "knowledge_vault";
/** Optional parts of a request ChatGPT may refuse (`subscription_sharing_unsupported_capability`): left out from then on. */
export type DropKey = "text" | "reasoning" | "parallel_tool_calls" | "tool_choice";

const PAUSE_MS = 5 * 60_000;
const BACKOFF_MS = [1000, 3000];

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (isObject(p) && typeof p.text === "string" ? p.text : "")).join("") : "";

/** A user message's parts: text, images and inline files. Audio and uploaded-file references are not supported on this route. */
function userContent(content: unknown): string | Json[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: Json[] = [];
  for (const p of content) {
    if (!isObject(p)) continue;
    if (p.type === "text" && typeof p.text === "string") parts.push({ type: "input_text", text: p.text });
    else if (p.type === "image_url") {
      const image = p.image_url;
      const url = typeof image === "string" ? image : isObject(image) ? image.url : undefined;
      const detail = isObject(image) && typeof image.detail === "string" ? image.detail : "auto";
      if (typeof url === "string") parts.push({ type: "input_image", image_url: url, detail });
    } else if (p.type === "file" && isObject(p.file) && typeof p.file.file_data === "string") {
      parts.push({ type: "input_file", file_data: p.file.file_data, ...(typeof p.file.filename === "string" ? { filename: p.file.filename } : {}) });
    }
  }
  return parts;
}

function toolsOf(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  const out: Json[] = [];
  for (const t of tools) {
    if (!isObject(t) || t.type !== "function") continue;
    const fn = isObject(t.function) ? t.function : t;
    if (typeof fn.name !== "string" || !fn.name) continue;
    out.push({
      type: "function",
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      parameters: isObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
    });
  }
  return out;
}

/** `response_format` → the Responses `text.format`. */
function formatOf(rf: unknown): Json | undefined {
  if (!isObject(rf)) return undefined;
  if (rf.type === "json_object") return { type: "json_object" };
  if (rf.type !== "json_schema") return undefined;
  const spec = isObject(rf.json_schema) ? rf.json_schema : {};
  if (!isObject(spec.schema)) return { type: "json_object" };
  return {
    type: "json_schema",
    name: typeof spec.name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(spec.name) ? spec.name : "answer",
    schema: spec.schema,
    ...(typeof spec.strict === "boolean" ? { strict: spec.strict } : {}),
    ...(typeof spec.description === "string" ? { description: spec.description } : {}),
  };
}

/** When ChatGPT refuses a JSON format: the same request, held to JSON by its instructions instead. */
function jsonInstruction(format: Json): string {
  const schema = format.type === "json_schema" ? format.schema : undefined;
  return `Answer with one JSON object and nothing else: no prose, no Markdown code fences.${schema ? `\nThe object must match this JSON Schema:\n${JSON.stringify(schema)}` : ""}`;
}

/** Chat Completions' `reasoning_effort`, or OpenRouter's `reasoning.effort` (the pipeline sends that one). */
function effortOf(chat: Json): string | undefined {
  if (typeof chat.reasoning_effort === "string") return chat.reasoning_effort;
  if (isObject(chat.reasoning) && typeof chat.reasoning.effort === "string") return chat.reasoning.effort;
  return undefined;
}

function toolChoiceOf(choice: unknown): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (isObject(choice) && isObject(choice.function) && typeof choice.function.name === "string") return { type: "function", name: choice.function.name };
  return undefined;
}

/**
 * A Chat Completions request as a Responses request for ChatGPT plan usage. Leading system and developer
 * messages become `instructions`; a later one stays in place as a developer message (system items are
 * refused). Everything not mapped here — `max_tokens`, `temperature`, `top_p`, `user`, `metadata`, `stop`,
 * `n`, OpenRouter's `usage` and `models` — is left out: the route refuses them or has no such thing.
 */
export function toResponsesRequest(chat: Json, dropped: ReadonlySet<DropKey> = new Set()): { body: Json; json: boolean } {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const tools = toolsOf(chat.tools);
  const instructions: string[] = [];
  const input: Json[] = [];
  let leading = true;
  for (const m of messages) {
    if (!isObject(m)) continue;
    if (m.role === "system" || m.role === "developer") {
      const t = textOf(m.content);
      if (!t.trim()) continue;
      if (leading) instructions.push(t);
      else input.push({ role: "developer", content: t });
      continue;
    }
    leading = false;
    if (m.role === "user") input.push({ role: "user", content: userContent(m.content) });
    else if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t) input.push({ role: "assistant", content: t });
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!isObject(call) || typeof call.id !== "string" || !isObject(call.function) || typeof call.function.name !== "string") continue;
        const args = call.function.arguments;
        input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}), ...(tools.length ? { namespace: TOOL_NAMESPACE } : {}) });
      }
    } else if (m.role === "tool" && typeof m.tool_call_id === "string") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: textOf(m.content) });
    }
  }
  const format = formatOf(chat.response_format);
  if (format && dropped.has("text")) instructions.push(jsonInstruction(format));
  const effort = effortOf(chat);
  const choice = toolChoiceOf(chat.tool_choice);
  const body: Json = {
    model: chat.model,
    ...(instructions.length ? { instructions: instructions.join("\n\n") } : {}),
    input,
    store: false,
    stream: true,
    ...(tools.length ? { tools: [{ type: "namespace", name: TOOL_NAMESPACE, description: "The tools this app offers for this conversation.", tools }] } : {}),
    ...(tools.length && choice !== undefined && !dropped.has("tool_choice") ? { tool_choice: choice } : {}),
    ...(tools.length && typeof chat.parallel_tool_calls === "boolean" && !dropped.has("parallel_tool_calls") ? { parallel_tool_calls: chat.parallel_tool_calls } : {}),
    ...(format && !dropped.has("text") ? { text: { format } } : {}),
    ...(effort && !dropped.has("reasoning") ? { reasoning: { effort } } : {}),
  };
  return { body, json: format !== undefined };
}

/** Which optional part a refused parameter names, if it is one the request can do without. */
export function dropKeyFor(param: string | undefined): DropKey | undefined {
  if (!param) return undefined;
  if (/^(text|response_format)\b/.test(param)) return "text";
  if (/^reasoning\b/.test(param)) return "reasoning";
  if (param.startsWith("parallel_tool_calls")) return "parallel_tool_calls";
  if (param.startsWith("tool_choice")) return "tool_choice";
  return undefined;
}

/** A Responses stream (`text/event-stream`) as its JSON events; a `[DONE]`, a comment or a malformed event is skipped. */
export async function* responseEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<Json> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string): Json | undefined => {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return undefined;
    try {
      const value: unknown = JSON.parse(data);
      return isObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  for await (const chunk of body) {
    // A CR at the very end may be half of a CRLF: it waits for the next chunk.
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n|\r(?!$)/g, "\n");
    for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
      const event = parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
      if (event) yield event;
    }
  }
  const last = parse((buffer + decoder.decode()).replace(/\r\n?/g, "\n"));
  if (last) yield last;
}

/** A whole Responses object (a server that answered without streaming) as the one terminal event it amounts to. */
async function* wholeResponse(response: unknown): AsyncGenerator<Json> {
  const status = isObject(response) ? response.status : undefined;
  yield { type: status === "failed" ? "response.failed" : status === "incomplete" ? "response.incomplete" : "response.completed", response };
}

type Call = { itemId: string; callId: string; name: string; args: string };
const bareName = (name: unknown): string => (typeof name === "string" ? name.replace(new RegExp(`^${TOOL_NAMESPACE}(\\.|__|/)`), "") : "");
const messageText = (item: Json): string =>
  Array.isArray(item.content)
    ? item.content.map((p) => (isObject(p) ? (p.type === "output_text" && typeof p.text === "string" ? p.text : p.type === "refusal" && typeof p.refusal === "string" ? p.refusal : "") : "")).join("")
    : "";

/**
 * Responses events in; Chat Completions chunks out as they come, and at the end either the closing chunks or one
 * whole completion. Only `response.completed` (or `response.incomplete`) makes an answer; `response.failed` and
 * `error` events set `failure`.
 */
export class ResponsesToChat {
  id = `chatcmpl-${randomUUID()}`;
  readonly created: number;
  model: string;
  done = false;
  failure: ChatGptFailure | undefined;
  finishReason: "stop" | "length" | "content_filter" | "tool_calls" = "stop";
  private text = "";
  private started = false;
  private readonly calls: Call[] = [];
  /** Message items whose text already went out (as deltas, or whole). */
  private readonly sent = new Set<string>();
  /** A text delta came without its item's ID: finished message items are then never added again. */
  private anonymousText = false;
  private usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

  constructor(model: string, nowMs: number) {
    this.model = model;
    this.created = Math.floor(nowMs / 1000);
  }

  private chunk(delta: Json): Json {
    const first = !this.started;
    this.started = true;
    return { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta: first ? { role: "assistant", ...delta } : delta, finish_reason: null }] };
  }

  private noteResponse(response: unknown): void {
    if (!isObject(response)) return;
    if (typeof response.model === "string" && response.model) this.model = response.model;
    if (!this.started && typeof response.id === "string" && response.id) this.id = `chatcmpl-${response.id}`;
  }

  private addText(text: string, out: Json[]): void {
    if (!text) return;
    this.text += text;
    out.push(this.chunk({ content: text }));
  }

  /** The call for a function-call item, announced (id and name) the first time it is seen. */
  private callFor(item: Json | undefined, itemId: unknown, out: Json[]): Call | undefined {
    const id = typeof itemId === "string" ? itemId : undefined;
    const callId = item && typeof item.call_id === "string" ? item.call_id : undefined;
    let call = this.calls.find((c) => (id !== undefined && c.itemId === id) || (callId !== undefined && c.callId === callId));
    if (!call) {
      if (id === undefined && callId === undefined) return undefined;
      call = { itemId: id ?? callId!, callId: callId ?? id!, name: bareName(item?.name), args: "" };
      this.calls.push(call);
      out.push(this.chunk({ tool_calls: [{ index: this.calls.length - 1, id: call.callId, type: "function", function: { name: call.name, arguments: "" } }] }));
    } else if (!call.name && item && typeof item.name === "string") {
      call.name = bareName(item.name);
      out.push(this.chunk({ tool_calls: [{ index: this.calls.indexOf(call), function: { name: call.name } }] }));
    }
    return call;
  }

  /** The arguments in full (a `.done` event or the finished item): whatever did not stream goes out now. */
  private catchUp(call: Call, full: string, out: Json[]): void {
    if (full.length > call.args.length && full.startsWith(call.args)) {
      const rest = full.slice(call.args.length);
      call.args = full;
      out.push(this.chunk({ tool_calls: [{ index: this.calls.indexOf(call), function: { arguments: rest } }] }));
    } else if (!full.startsWith(call.args)) {
      call.args = full;
    }
  }

  /** A finished output item: a message that never streamed its text, or a function call. */
  private item(item: unknown, out: Json[]): void {
    if (!isObject(item)) return;
    if (item.type === "function_call") {
      const call = this.callFor(item, item.id, out);
      if (call && typeof item.arguments === "string") this.catchUp(call, item.arguments, out);
    } else if (item.type === "message" && !this.anonymousText && !(typeof item.id === "string" && this.sent.has(item.id))) {
      if (typeof item.id === "string") this.sent.add(item.id);
      this.addText(messageText(item), out);
    }
  }

  push(event: Json): Json[] {
    const out: Json[] = [];
    switch (event.type) {
      case "response.created":
      case "response.in_progress":
        this.noteResponse(event.response);
        break;
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (typeof event.item_id === "string") this.sent.add(event.item_id);
        else this.anonymousText = true;
        this.addText(typeof event.delta === "string" ? event.delta : "", out);
        break;
      case "response.output_item.added":
        if (isObject(event.item) && event.item.type === "function_call") this.item(event.item, out);
        break;
      case "response.output_item.done":
        this.item(event.item, out);
        break;
      case "response.function_call_arguments.delta": {
        const call = this.callFor(undefined, event.item_id, out);
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (call && delta) {
          call.args += delta;
          out.push(this.chunk({ tool_calls: [{ index: this.calls.indexOf(call), function: { arguments: delta } }] }));
        }
        break;
      }
      case "response.function_call_arguments.done": {
        const call = this.callFor(undefined, event.item_id, out);
        if (call && typeof event.arguments === "string") this.catchUp(call, event.arguments, out);
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = isObject(event.response) ? event.response : {};
        this.noteResponse(response);
        for (const item of Array.isArray(response.output) ? response.output : []) this.item(item, out);
        const u = isObject(response.usage) ? response.usage : undefined;
        if (u) {
          const prompt = typeof u.input_tokens === "number" ? u.input_tokens : 0;
          const completion = typeof u.output_tokens === "number" ? u.output_tokens : 0;
          this.usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : prompt + completion };
        }
        if (event.type === "response.incomplete") {
          const reason = isObject(response.incomplete_details) ? response.incomplete_details.reason : undefined;
          this.finishReason = reason === "content_filter" ? "content_filter" : "length";
        } else {
          this.finishReason = this.calls.length ? "tool_calls" : "stop";
        }
        this.done = true;
        break;
      }
      case "response.failed": {
        const response = isObject(event.response) ? event.response : {};
        this.failure = chatGptFailure(undefined, isObject(response.error) ? response.error : {});
        break;
      }
      case "error":
        this.failure = chatGptFailure(undefined, { code: event.code, message: event.message, param: event.param });
        break;
    }
    return out;
  }

  /** The closing chunks of a stream: the finish reason, then the usage when the caller asked for it. */
  finalChunks(includeUsage: boolean): Json[] {
    const head = { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model };
    const usage = this.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return [{ ...head, choices: [{ index: 0, delta: {}, finish_reason: this.finishReason }] }, ...(includeUsage ? [{ ...head, choices: [], usage }] : [])];
  }

  /** The whole answer as one Chat Completions object. */
  completion(): Json {
    const message: Json = { role: "assistant", content: this.text || (this.calls.length ? null : "") };
    if (this.calls.length) message.tool_calls = this.calls.map((c) => ({ id: c.callId, type: "function", function: { name: c.name, arguments: c.args } }));
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finishReason }],
      usage: this.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}

type Outcome = { kind: "answered" } | { kind: "aborted" } | { kind: "failed"; failure: ChatGptFailure } | { kind: "broke"; failure: ChatGptFailure };

export type ChatGptBridgeDeps = {
  session: ChatGptSessionLike;
  /** Where `/responses` and `/models` are (tests: a fake server). */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** One line per refusal: the codes and OpenAI's request ID, never a token or a prompt. */
  log?: (line: string) => void;
};

export function createChatGptBridge(deps: ChatGptBridgeDeps): ChatGptBridge {
  const f = deps.fetchImpl ?? fetch;
  const base = (deps.apiBase ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});
  /** After "usage limit reached", background requests (the pipeline) wait here instead of asking again (OpenAI: pause). */
  let pausedUntil = 0;
  /** Per model: the optional parts ChatGPT refused. */
  const refused = new Map<string, Set<DropKey>>();

  const sendJson = (res: ServerResponse, status: number, body: unknown, cors: Record<string, string>) => {
    res.writeHead(status, { "content-type": "application/json", ...cors }).end(JSON.stringify(body));
  };
  const errorBody = (failure: ChatGptFailure) => ({ error: { ...openAiError(failure.status, failure.message, failure.code).error, ...(failure.requestId ? { request_id: failure.requestId } : {}) } });
  const sendFailure = (res: ServerResponse, cors: Record<string, string>, failure: ChatGptFailure) => sendJson(res, failure.status, errorBody(failure), cors);
  /** The sign-in's refusal (signed out, plan use not allowed, a renewal that failed) as a failure. */
  const fromSession = (error: unknown): ChatGptFailure => {
    const e = error as { status?: unknown; code?: unknown };
    if (error instanceof Error && typeof e.status === "number" && typeof e.code === "string") return { status: e.status, message: error.message, code: e.code };
    return { status: 500, message: `The ChatGPT sign-in could not be used: ${error instanceof Error ? error.message : String(error)}`, code: "chatgpt_error" };
  };
  const note = (failure: ChatGptFailure) => {
    if (failure.code !== "chatgpt_usage_limit") return;
    pausedUntil = now() + PAUSE_MS;
    deps.session.noteUsageLimit?.();
  };

  async function relay(upstream: Response, ctx: { model: string; stream: boolean; includeUsage: boolean; res: ServerResponse; cors: Record<string, string>; signal: AbortSignal; requestId?: string }): Promise<Outcome> {
    const t = new ResponsesToChat(ctx.model, now());
    let started = false;
    const write = (chunks: Json[]) => {
      if (!chunks.length) return;
      if (!started) {
        // Not before the first piece of the answer: a refusal before it still gets its own HTTP status.
        ctx.res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", ...ctx.cors });
        started = true;
      }
      for (const c of chunks) ctx.res.write(`data: ${JSON.stringify(c)}\n\n`);
    };
    const withId = (failure: ChatGptFailure): ChatGptFailure => (ctx.requestId && !failure.requestId ? { ...failure, requestId: ctx.requestId } : failure);
    const broke = (failure: ChatGptFailure): Outcome => {
      ctx.res.end(`data: ${JSON.stringify(errorBody(failure))}\n\n`);
      return { kind: "broke", failure };
    };
    const dropped = (): Outcome =>
      started
        ? broke(withId({ status: 502, message: "ChatGPT stopped answering in the middle of the reply.", code: "provider_dropped" }))
        : { kind: "failed", failure: withId({ status: 502, message: "ChatGPT stopped answering before it replied.", code: "provider_dropped" }) };
    try {
      const events = (upstream.headers.get("content-type") ?? "").includes("application/json")
        ? wholeResponse(await upstream.json())
        : responseEvents(upstream.body as unknown as AsyncIterable<Uint8Array>);
      for await (const event of events) {
        const chunks = t.push(event);
        if (t.failure) return started ? broke(withId(t.failure)) : { kind: "failed", failure: withId(t.failure) };
        if (ctx.stream) write(chunks);
        if (t.done) break;
      }
    } catch {
      if (ctx.signal.aborted) return { kind: "aborted" };
      return dropped();
    }
    // Only response.completed (or .incomplete) is an answer; a stream that just ends is not.
    if (!t.done) return ctx.signal.aborted ? { kind: "aborted" } : dropped();
    if (ctx.stream) {
      write(t.finalChunks(ctx.includeUsage));
      ctx.res.end("data: [DONE]\n\n");
    } else {
      sendJson(ctx.res, 200, t.completion(), ctx.cors);
    }
    return { kind: "answered" };
  }

  async function chat(payload: Json, res: ServerResponse, cors: Record<string, string>, signal: AbortSignal, interactive: boolean): Promise<void> {
    if (!interactive && pausedUntil > now()) return sendFailure(res, cors, chatGptFailure(429, { code: "subscription_sharing_usage_limit_exceeded" }));
    let token: string;
    try {
      token = await deps.session.accessToken();
    } catch (error) {
      return sendFailure(res, cors, fromSession(error));
    }
    const model = typeof payload.model === "string" ? payload.model : "";
    const stream = payload.stream === true;
    const includeUsage = stream && isObject(payload.stream_options) && payload.stream_options.include_usage === true;
    let renewed = false;
    let waits = 0;
    let failure: ChatGptFailure = { status: 502, message: "ChatGPT could not answer.", code: "provider_error" };
    for (let attempt = 0; attempt < 8; attempt++) {
      const dropped = refused.get(model) ?? new Set<DropKey>();
      const { body } = toResponsesRequest(payload, dropped);
      let upstream: Response;
      try {
        upstream = await f(`${base}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) return;
        return sendJson(res, 502, openAiError(502, `Could not reach ChatGPT: ${error instanceof Error ? error.message : String(error)}`, "provider_unreachable"), cors);
      }
      const requestId = upstream.headers.get("x-request-id") ?? undefined;
      if (!upstream.ok) {
        failure = chatGptFailureFromBody(upstream.status, await upstream.text().catch(() => ""), requestId);
      } else {
        const outcome = await relay(upstream, { model, stream, includeUsage, res, cors, signal, ...(requestId ? { requestId } : {}) });
        if (outcome.kind === "answered") {
          deps.session.noteSuccess?.();
          return;
        }
        if (outcome.kind === "aborted") return;
        if (outcome.kind === "broke") {
          note(outcome.failure);
          log(`ChatGPT stopped a reply: ${outcome.failure.upstreamCode ?? outcome.failure.code}${outcome.failure.requestId ? ` (request ${outcome.failure.requestId})` : ""}`);
          return;
        }
        failure = outcome.failure;
      }
      // Nothing reached the caller yet: what can be retried is retried.
      if (failure.status === 401 && !renewed) {
        renewed = true;
        try {
          token = await deps.session.refreshAccessToken(token);
        } catch (error) {
          return sendFailure(res, cors, fromSession(error));
        }
        continue;
      }
      const drop = failure.upstreamCode === "subscription_sharing_unsupported_capability" ? dropKeyFor(failure.param) : undefined;
      if (drop && !dropped.has(drop)) {
        refused.set(model, new Set([...dropped, drop]));
        log(`ChatGPT does not take ${failure.param} for ${model || "this model"}; asking again without it`);
        continue;
      }
      if (failure.status === 503 && waits < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[waits++]!);
        if (signal.aborted) return;
        continue;
      }
      break;
    }
    note(failure);
    log(`ChatGPT refused a request: ${failure.upstreamCode ?? failure.code} (HTTP ${failure.status}${failure.requestId ? `, request ${failure.requestId}` : ""})`);
    return sendFailure(res, cors, failure);
  }

  async function models(res: ServerResponse, cors: Record<string, string>): Promise<void> {
    try {
      const list = await deps.session.models();
      sendJson(res, 200, { object: "list", data: list.map((m) => ({ id: m.slug, object: "model", created: 0, owned_by: "openai", name: m.name })) }, cors);
    } catch (error) {
      sendFailure(res, cors, fromSession(error));
    }
  }

  return {
    async handle({ kind, payload, res, cors, signal, interactive }) {
      if (kind === "models") return models(res, cors);
      return chat(payload, res, cors, signal, interactive);
    },
  };
}
