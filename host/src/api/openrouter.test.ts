import { describe, expect, it, vi } from "vitest";
import { signInWithOpenRouter } from "./openrouter.js";

const info = { origin: "o", graphqlUrl: "g", controlOrigin: "http://127.0.0.1:4202", controlToken: "t" };

describe("signInWithOpenRouter", () => {
  it("runs PKCE through the system browser and returns the issued key", async () => {
    let opened = "";
    const signIn = vi.fn(async (_i: unknown, build: (cb: string) => string) => {
      opened = build("http://localhost:4202/oauth/callback/abc");
      return "the-code";
    });
    let exchanged: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      exchanged = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ key: "sk-or-new" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(signInWithOpenRouter(info, { signIn: signIn as never, fetchImpl })).resolves.toBe("sk-or-new");
    const url = new URL(opened);
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("callback_url")).toBe("http://localhost:4202/oauth/callback/abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(exchanged).toMatchObject({ code: "the-code", code_challenge_method: "S256" });
    expect(typeof exchanged.code_verifier).toBe("string");
  });
  it("says so when OpenRouter does not issue a key", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await expect(signInWithOpenRouter(info, { signIn: (async () => "c") as never, fetchImpl })).rejects.toThrow("OpenRouter did not issue a key (400).");
  });
});
