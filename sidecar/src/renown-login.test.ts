import { describe, expect, it, vi } from "vitest";
import { renownLogin } from "./renown-login.js";

const appDid = "did:key:z6MkApp";
function fakeRenown() {
  return { did: appDid, login: vi.fn(async (did: string) => ({ address: "0xabc", did })) };
}
const ready = (did: string) => new Response(JSON.stringify({ status: "ready", did }), { status: 200 });
const waiting = () => new Response(JSON.stringify({ status: "pending" }), { status: 200 });

describe("renownLogin", () => {
  it("reports a link that carries the session and the app identity, unchanged", async () => {
    const renown = fakeRenown();
    let reported = "";
    const fetchImpl = vi.fn(async () => ready("did:pkh:user"));
    await renownLogin(renown, {
      renownUrl: "https://www.renown.id",
      onLoginUrl: (url) => (reported = url),
      fetchImpl,
      sleep: async () => {},
    });
    const u = new URL(reported);
    expect(u.pathname).toBe("/console");
    expect(u.searchParams.get("session")).toMatch(/^[0-9a-f-]{36}$/);
    expect(u.searchParams.get("connect")).toBe(appDid);
    expect(u.searchParams.get("app")).toBe(appDid);
  });

  it("polls the session until it is ready, then completes the login with the user's DID", async () => {
    const renown = fakeRenown();
    const responses = [waiting(), waiting(), ready("did:pkh:user")];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const result = await renownLogin(renown, { renownUrl: "https://www.renown.id", fetchImpl, sleep: async () => {} });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/^https:\/\/www\.renown\.id\/api\/console\/session\/[0-9a-f-]{36}$/);
    expect(renown.login).toHaveBeenCalledWith("did:pkh:user");
    expect(result).toEqual({ user: { address: "0xabc", did: "did:pkh:user" }, cliDid: appDid });
  });

  it("keeps polling through network errors", async () => {
    const renown = fakeRenown();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new TypeError("network down");
      return ready("did:pkh:user");
    });
    await renownLogin(renown, { renownUrl: "https://www.renown.id", fetchImpl, sleep: async () => {} });
    expect(renown.login).toHaveBeenCalledOnce();
  });

  it("gives up after the timeout", async () => {
    const renown = fakeRenown();
    let clock = 0;
    await expect(
      renownLogin(renown, {
        renownUrl: "https://www.renown.id",
        timeoutMs: 1000,
        now: () => clock,
        fetchImpl: async () => waiting(),
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow("Authentication timed out.");
    expect(renown.login).not.toHaveBeenCalled();
  });

  it("stops when cancelled", async () => {
    const renown = fakeRenown();
    const controller = new AbortController();
    const run = renownLogin(renown, {
      renownUrl: "https://www.renown.id",
      signal: controller.signal,
      fetchImpl: async () => waiting(),
      sleep: async () => {
        controller.abort();
      },
    });
    await expect(run).rejects.toThrow();
    expect(renown.login).not.toHaveBeenCalled();
  });
});
