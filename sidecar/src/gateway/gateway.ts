import type { IncomingMessage, ServerResponse } from "node:http";
import { PROVIDER_LABELS, type AppSettings } from "../settings.js";
import { openAiError, providerMessage } from "./errors.js";
import { createQueue } from "./queue.js";

export const GATEWAY_PATH = "/llm/v1";
const NO_MODEL = "No AI model is set up yet. Choose one in Settings › Models.";

/** Task 3: Anthropic's JSON calls go to its native API; returns the OpenAI-shaped answer. */
export type AnthropicJson = (args: { endpoint: string; key: string; body: Record<string, unknown>; fetchImpl: typeof fetch; signal: AbortSignal }) => Promise<{ status: number; json: unknown }>;

export type GatewayDeps = {
  readSettings: () => AppSettings;
  readModelKey: () => string | undefined;
  fetchImpl?: typeof fetch;
  anthropicJson?: AnthropicJson;
};

const limitFor = (s: AppSettings) => (s.models.local ? 1 : 4);
const whoFor = (s: AppSettings) => (s.models.local ? "this computer's model server" : PROVIDER_LABELS[s.models.provider]);

function sendJson(res: ServerResponse, status: number, body: unknown, cors: Record<string, string>) {
  res.writeHead(status, { "content-type": "application/json", ...cors }).end(JSON.stringify(body));
}

export function createGateway(deps: GatewayDeps) {
  const f = deps.fetchImpl ?? fetch;
  const queue = createQueue();

  async function handle(req: IncomingMessage, res: ServerResponse, body: Buffer, cors: Record<string, string>): Promise<void> {
    const path = new URL(req.url ?? "/", "http://gateway").pathname.slice(GATEWAY_PATH.length);
    const isChat = req.method === "POST" && path === "/chat/completions";
    const isModels = req.method === "GET" && path === "/models";
    if (!isChat && !isModels) return sendJson(res, 404, openAiError(404, "No such gateway route."), cors);
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    const interactive = req.headers["x-kv-priority"] === "interactive";
    const fail = () => {
      if (!res.headersSent) sendJson(res, 500, openAiError(500, "The model gateway could not handle the request.", "gateway_error"), cors);
      else if (!res.writableEnded) res.end();
    };
    try {
      queue.setLimit(limitFor(deps.readSettings()));
    } catch {
      return fail();
    }
    await queue.run(interactive, async () => {
     try {
      // Read here, not on arrival: a request that waited goes to the provider set up now (Review Focus 2).
      const settings = deps.readSettings();
      queue.setLimit(limitFor(settings));
      const key = deps.readModelKey();
      const endpoint = settings.models.endpoint.replace(/\/+$/, "");
      const headers: Record<string, string> = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
      let payload: Record<string, unknown> = {};
      if (isChat) {
        if (!settings.models.model.trim()) return sendJson(res, 409, openAiError(409, NO_MODEL, "no_model"), cors);
        try {
          payload = body.length ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {};
        } catch {
          return sendJson(res, 400, openAiError(400, "The request body is not valid JSON."), cors);
        }
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          return sendJson(res, 400, openAiError(400, "The request body must be a JSON object."), cors);
        }
        if (typeof payload.model !== "string" || !payload.model.trim()) payload.model = settings.models.model;
        if (settings.models.provider === "anthropic" && payload.response_format && deps.anthropicJson && key) {
          try {
            const answer = await deps.anthropicJson({ endpoint, key, body: payload, fetchImpl: f, signal: controller.signal });
            return sendJson(res, answer.status, answer.json, cors);
          } catch (error) {
            return sendJson(res, 502, openAiError(502, `Could not reach Anthropic: ${error instanceof Error ? error.message : String(error)}`, "provider_unreachable"), cors);
          }
        }
      }
      let upstream: Response;
      try {
        upstream = await f(`${endpoint}${isChat ? "/chat/completions" : "/models"}`, {
          method: isChat ? "POST" : "GET",
          headers,
          ...(isChat ? { body: JSON.stringify(payload) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        return sendJson(res, 502, openAiError(502, `Could not reach ${whoFor(settings)}: ${error instanceof Error ? error.message : String(error)}`, "provider_unreachable"), cors);
      }
      if (!upstream.ok) {
        const { message, code } = providerMessage(settings.models.provider, upstream.status, await upstream.text());
        return sendJson(res, upstream.status, openAiError(upstream.status, message, code), cors);
      }
      const type = upstream.headers.get("content-type") ?? "application/json";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store", ...cors });
      try {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      } catch {
        if (!controller.signal.aborted && type.includes("text/event-stream")) {
          // Review Focus 1: the chat sees why the answer stopped instead of waiting forever.
          const who = settings.models.local ? "The model server on this computer" : PROVIDER_LABELS[settings.models.provider];
          res.write(`data: ${JSON.stringify(openAiError(502, `${who} stopped answering in the middle of the reply.`, "provider_dropped"))}\n\n`);
        }
      }
      res.end();
     } catch {
      fail();
     }
    });
  }

  return { handle };
}
