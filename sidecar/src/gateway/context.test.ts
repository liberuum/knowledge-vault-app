import { describe, expect, it } from "vitest";
import { localContextProbe } from "./context.js";

/** A llama.cpp server on 8084: its model, and the context its slot runs with. */
const llamaCpp = (calls: string[]) =>
  (async (u: unknown) => {
    const url = String(u);
    calls.push(url);
    if (url === "http://127.0.0.1:8084/v1/models") return new Response(JSON.stringify({ data: [{ id: "gpt-oss-20b-vault" }] }), { status: 200 });
    if (url === "http://127.0.0.1:8084/props") return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 32_768 }, total_slots: 1 }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

describe("the context a model on this computer runs with", () => {
  it("is read from its server, and kept for a minute", async () => {
    const calls: string[] = [];
    let now = 0;
    const probe = localContextProbe(llamaCpp(calls), () => now);
    expect(await probe("http://127.0.0.1:8084/v1", "gpt-oss-20b-vault")).toBe(32_768);
    const asked = calls.length;
    now = 30_000;
    expect(await probe("http://127.0.0.1:8084/v1", "gpt-oss-20b-vault")).toBe(32_768);
    expect(calls.length).toBe(asked);
    now = 61_000;
    await probe("http://127.0.0.1:8084/v1", "gpt-oss-20b-vault");
    expect(calls.length).toBeGreaterThan(asked);
  });
  it("is unknown for a server on another machine, or one that does not say", async () => {
    const calls: string[] = [];
    const probe = localContextProbe(llamaCpp(calls));
    expect(await probe("http://192.168.1.20:8084/v1", "m")).toBeNull();
    expect(calls).toEqual([]);
    expect(await probe("http://127.0.0.1:9999/v1", "m")).toBeNull();
  });
});
