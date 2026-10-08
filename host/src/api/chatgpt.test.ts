import { describe, expect, it, vi } from "vitest";
import { cancelChatGptSignIn, chooseChatGptPlan, fetchChatGptModels, fetchChatGptStatus, signOutOfChatGpt, startChatGptSignIn } from "./chatgpt.js";

const info = { origin: "http://127.0.0.1:4201", graphqlUrl: "http://127.0.0.1:4201/graphql", controlOrigin: "http://127.0.0.1:4202", controlToken: "t" };

function engine(answer: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } }));
}

describe("the ChatGPT sign-in calls", () => {
  it("ask the engine's /chatgpt routes with the control token", async () => {
    const f = engine({ url: "https://auth.openai.com/api/accounts/authorize?x=1" }, 202);
    expect(await startChatGptSignIn(info, { allowPlanUsage: true }, f)).toEqual({ url: "https://auth.openai.com/api/accounts/authorize?x=1" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4202/chatgpt/login");
    expect(init).toMatchObject({ method: "POST", body: '{"allowPlanUsage":true}', headers: { authorization: "Bearer t" } });

    const s = engine({ signedIn: true, planUsage: true, scopes: [], pending: null });
    expect(await fetchChatGptStatus(info, s)).toMatchObject({ signedIn: true, planUsage: true });
    expect(s.mock.calls[0]![0]).toBe("http://127.0.0.1:4202/chatgpt/status");

    const c = engine({ cancelled: true });
    await cancelChatGptSignIn(info, c);
    expect([c.mock.calls[0]![0], c.mock.calls[0]![1]?.method]).toEqual(["http://127.0.0.1:4202/chatgpt/cancel", "POST"]);

    expect(await signOutOfChatGpt(info, engine({ signedOut: true, revoked: false }))).toEqual({ signedOut: true, revoked: false });
    expect(await fetchChatGptModels(info, engine({ ok: true, models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", free: false }] }))).toEqual([{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }]);

    const put = engine({});
    await chooseChatGptPlan(info, "gpt-6.1-sol", put);
    expect(put.mock.calls[0]![1]).toMatchObject({ method: "PUT", body: '{"models":{"provider":"chatgpt","model":"gpt-6.1-sol"}}' });
  });

  it("pass the engine's sentence on when it refuses", async () => {
    await expect(startChatGptSignIn(info, { newAccount: true }, engine({ error: "Sign out of ChatGPT first, then sign in with the other account.", code: "chatgpt_signed_in" }, 409))).rejects.toThrow(
      "Sign out of ChatGPT first, then sign in with the other account.",
    );
  });
});
