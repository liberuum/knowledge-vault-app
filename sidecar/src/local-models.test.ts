import { describe, expect, it, vi } from "vitest";
import { isLocalEndpoint, privateHostAllow } from "./egress.js";
import { fetchModelCatalog, probeLocalModels } from "./models-validate.js";

const answer = (status: number, body: unknown) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
const allowed = (e: string) => isLocalEndpoint(e) || privateHostAllow(e) !== null;

describe("a model server on this computer", () => {
  it("is recognised by its loopback address, nothing else", () => {
    for (const e of ["http://127.0.0.1:8080/v1", "http://localhost:11434/v1", "http://[::1]:1234/v1", "http://127.0.0.2:8000"]) expect(isLocalEndpoint(e)).toBe(true);
    for (const e of ["https://openrouter.ai/api/v1", "http://192.168.1.20:8080/v1", "not a url"]) expect(isLocalEndpoint(e)).toBe(false);
  });

  it("is asked for its models without an Authorization header when there is no key", async () => {
    const f = answer(200, { data: [{ id: "lfm2.5-8b-a1b" }] });
    await fetchModelCatalog("http://127.0.0.1:8080/v1", "", f);
    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("probes an address: what it serves, normalised the way Settings stores it", async () => {
    const f = answer(200, { data: [{ id: "lfm2.5-8b-a1b" }, { id: "qwen3.8-flash-next" }] });
    expect(await probeLocalModels(" http://127.0.0.1:8080/v1/chat/completions/ ", allowed, f)).toEqual({ ok: true, endpoint: "http://127.0.0.1:8080/v1", models: ["lfm2.5-8b-a1b", "qwen3.8-flash-next"] });
    expect(String((f as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0])).toBe("http://127.0.0.1:8080/v1/models");
  });

  it("says why when nothing answers, nothing is served, the address is not local, or not a URL", async () => {
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await probeLocalModels("http://127.0.0.1:9/v1", allowed, down)).toMatchObject({ ok: false, detail: expect.stringContaining("Could not reach") });
    expect(await probeLocalModels("http://127.0.0.1:8080/v1", allowed, answer(200, { data: [] }))).toMatchObject({ ok: false, detail: "The server answered, but serves no model." });
    expect(await probeLocalModels("https://openrouter.ai/api/v1", allowed, answer(200, { data: [{ id: "x" }] }))).toMatchObject({ ok: false, detail: "Only a server on this computer or your local network can be used here." });
    expect(await probeLocalModels("nope", allowed, answer(200, {}))).toMatchObject({ ok: false, detail: expect.stringContaining("not a URL") });
  });

  it("accepts a server on the local network too (Ollama on another machine)", async () => {
    expect(await probeLocalModels("http://192.168.1.20:11434/v1", allowed, answer(200, { data: [{ id: "llama3" }] }))).toMatchObject({ ok: true, models: ["llama3"] });
  });
});
