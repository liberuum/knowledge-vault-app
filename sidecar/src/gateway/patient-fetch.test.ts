import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../settings.js";
import { createGateway, GATEWAY_PATH } from "./gateway.js";
import { patientFetch } from "./patient-fetch.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const settingsFor = (endpoint: string, local: boolean): AppSettings =>
  ({ version: 1, models: { endpoint, model: "gpt-oss-20b", hasKey: !local, local, provider: local ? "local" : "custom" }, conversion: { mode: "local", remoteUrl: "" } }) as unknown as AppSettings;
async function gatewayAt(deps: Parameters<typeof createGateway>[0]) {
  const gw = createGateway(deps);
  return listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    await gw.handle(req, res, Buffer.concat(chunks), {});
  });
}
const ask = (base: string, body: Record<string, unknown>) =>
  fetch(`${base}${GATEWAY_PATH}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Node's fetch gives up on an answer that starts after 300 s; a local model's pipeline call may (patient-fetch.ts). */
describe("the gateway's calls to a model on this computer", () => {
  it("go without fetch's time limits; a hosted provider's go through fetch", async () => {
    const upstream = await listen((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "{}" } }] })));
    const localFetch = vi.fn(patientFetch as typeof fetch);
    const fetchImpl = vi.fn(fetch);
    const local = await gatewayAt({ readSettings: () => settingsFor(`${upstream}/v1`, true), readModelKey: () => undefined, localFetch, fetchImpl });
    expect((await ask(local, { messages: [] })).status).toBe(200);
    expect(localFetch).toHaveBeenCalledWith(`${upstream}/v1/chat/completions`, expect.objectContaining({ method: "POST" }));
    expect(fetchImpl).not.toHaveBeenCalled();
    const hosted = await gatewayAt({ readSettings: () => settingsFor(`${upstream}/v1`, false), readModelKey: () => "sk", localFetch, fetchImpl });
    localFetch.mockClear();
    expect((await ask(hosted, { messages: [] })).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("wait for an answer that starts late, and stream one as it arrives", async () => {
    const late = await listen((_req, res) => void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "{\"ok\":1}" } }] })), 300));
    const gw = await gatewayAt({ readSettings: () => settingsFor(`${late}/v1`, true), readModelKey: () => undefined });
    expect(await (await ask(gw, { messages: [] })).json()).toMatchObject({ choices: [{ message: { content: "{\"ok\":1}" } }] });

    const streamed = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      setTimeout(() => res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'), 20);
    });
    const sgw = await gatewayAt({ readSettings: () => settingsFor(`${streamed}/v1`, true), readModelKey: () => undefined });
    const res = await ask(sgw, { stream: true, messages: [] });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
  });
});
