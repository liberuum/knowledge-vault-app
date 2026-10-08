import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppSettings } from "../settings.js";
import { createGateway, GATEWAY_PATH } from "./gateway.js";

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
const settingsFor = (endpoint: string, model = "m-1", provider: AppSettings["models"]["provider"] = "custom"): AppSettings => ({
  version: 1,
  models: { endpoint, model, hasKey: true, local: provider === "local", provider },
  conversion: { mode: "off", remoteUrl: "" },
  ui: { closeToTray: true },
});
/** The gateway behind a tiny server, the way the control server mounts it. */
async function gatewayAt(readSettings: () => AppSettings, key = "sk-test") {
  const gw = createGateway({ readSettings, readModelKey: () => key });
  return listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    await gw.handle(req, res, Buffer.concat(chunks), {});
  });
}
const ask = (base: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base}${GATEWAY_PATH}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("gateway", () => {
  it("forwards a chat request with the key and the configured model", async () => {
    let seen: { auth?: string; body?: Record<string, unknown> } = {};
    const upstream = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      seen = { auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }));
    });
    const gw = await gatewayAt(() => settingsFor(`${upstream}/v1`));
    const res = await ask(gw, { messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choices: [{ message: { role: "assistant", content: "hi" } }] });
    expect(seen).toEqual({ auth: "Bearer sk-test", body: { messages: [{ role: "user", content: "hello" }], model: "m-1" } });
  });

  it("streams server-sent events through as they arrive", async () => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'), 20);
    });
    const gw = await gatewayAt(() => settingsFor(`${upstream}/v1`));
    const res = await ask(gw, { stream: true, messages: [] });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
  });

  it("says in plain words that the provider refused the key", async () => {
    const upstream = await listen((_req, res) => res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid API key" } })));
    const gw = await gatewayAt(() => settingsFor(`${upstream}/v1`, "m-1", "openai"));
    const res = await ask(gw, { messages: [] });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: "OpenAI refused the API key: Invalid API key", type: "invalid_request_error", code: "provider_auth" } });
  });

  it("no model: answers 409 and says where to set one", async () => {
    const gw = await gatewayAt(() => settingsFor("http://127.0.0.1:9/v1", ""));
    const res = await ask(gw, { messages: [] });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe("No AI model is set up yet. Choose one in Settings › Models.");
  });

  it("an unreachable provider: 502 naming it", async () => {
    const gw = await gatewayAt(() => settingsFor("http://127.0.0.1:9/v1", "m-1", "local"));
    const res = await ask(gw, { messages: [] });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/^Could not reach this computer's model server/);
  });

  it("upstream drops mid-stream: the client gets an error event and the stream ends", async () => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const gw = await gatewayAt(() => settingsFor(`${upstream}/v1`, "m-1", "local"));
    const text = await (await ask(gw, { stream: true, messages: [] })).text();
    expect(text).toContain('data: {"choices":[{"delta":{"content":"Hel"}}]}');
    expect(text).toContain('"message":"The model server on this computer stopped answering in the middle of the reply."');
  });

  it("reads the settings when the request leaves the queue", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const hits: string[] = [];
    const first = await listen(async (_req, res) => { hits.push("first"); await held; res.writeHead(200).end("{}"); });
    const second = await listen((_req, res) => { hits.push("second"); res.writeHead(200).end("{}"); });
    let current = settingsFor(`${first}/v1`, "m-1", "local"); // local: one at a time
    const gw = await gatewayAt(() => current);
    const a = ask(gw, { messages: [] });
    await new Promise((r) => setTimeout(r, 30));
    const b = ask(gw, { messages: [] }); // waits behind a
    await new Promise((r) => setTimeout(r, 30));
    current = settingsFor(`${second}/v1`, "m-2", "local"); // the model changes while b waits
    release();
    await Promise.all([a, b]);
    expect(hits).toEqual(["first", "second"]);
  });

  it("forwards the model list", async () => {
    const upstream = await listen((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: req.url }] })));
    const gw = await gatewayAt(() => settingsFor(`${upstream}/v1`));
    expect(await (await fetch(`${gw}${GATEWAY_PATH}/models`)).json()).toEqual({ data: [{ id: "/v1/models" }] });
  });

  it("a body that is JSON but not an object: 400", async () => {
    const gw = await gatewayAt(() => settingsFor("http://127.0.0.1:9/v1"));
    for (const raw of ["null", "[]"]) {
      const res = await fetch(`${gw}${GATEWAY_PATH}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toBe("The request body must be a JSON object.");
    }
  });

  it("an internal error answers 500, and the queue slot is released", async () => {
    const upstream = await listen((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    let calls = 0;
    const gw = await gatewayAt(() => {
      if (++calls === 1) throw new Error("broken");
      return settingsFor(`${upstream}/v1`);
    });
    const res = await ask(gw, { messages: [] });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatchObject({ message: "The model gateway could not handle the request.", code: "gateway_error" });
    const next = await ask(gw, { messages: [] });
    expect(next.status).toBe(200);
  });
});
