// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatGptStatus } from "../api/chatgpt.js";
import { ChatGptConnect, type ChatGptApi } from "./ChatGptConnect.js";

const info = { origin: "http://127.0.0.1:4301", graphqlUrl: "http://127.0.0.1:4301/graphql", controlOrigin: "http://127.0.0.1:4302", controlToken: "t" };
const SIGNED_OUT: ChatGptStatus = { signedIn: false, planUsage: false, scopes: [], pending: null };
const LINK = "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=s";
afterEach(() => cleanup());

function fakeApi(initial: ChatGptStatus, revoked = true) {
  const state = { status: initial };
  const api: ChatGptApi = {
    status: vi.fn(async () => state.status),
    start: vi.fn(async () => {
      state.status = { ...state.status, pending: { url: LINK, startedAt: "2026-10-09T12:00:00.000Z" } };
      return { url: LINK };
    }),
    cancel: vi.fn(async () => {
      state.status = { ...state.status, pending: null };
    }),
    signOut: vi.fn(async () => {
      state.status = { ...SIGNED_OUT, savedAccount: { email: "ada@example.com" } };
      return { revoked };
    }),
    open: vi.fn(async () => {}),
  };
  return { api, state };
}

describe("ChatGptConnect", () => {
  it("walks the sign-in: Continue with ChatGPT → the browser → the one-time confirmation → Using ChatGPT plan → sign out", async () => {
    const { api, state } = fakeApi(SIGNED_OUT);
    render(<ChatGptConnect info={info} api={api} pollMs={50} />);
    expect(await screen.findByText("Use your ChatGPT plan")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => expect(api.open).toHaveBeenCalledWith(LINK));
    expect(api.start).toHaveBeenCalledWith(info, {});
    expect(await screen.findByText("Waiting for the browser…")).toBeTruthy();
    expect((screen.getByRole("link", { name: "open the sign-in page" }) as HTMLAnchorElement).href).toBe(LINK);
    // The browser comes back: the next poll sees the sign-in.
    state.status = { signedIn: true, planUsage: true, scopes: ["chatgpt.tokens.use.direct"], pending: null, account: { email: "ada@example.com" }, firstSignIn: true };
    expect(await screen.findByText("You're using your ChatGPT plan", undefined, { timeout: 4000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText("You're using your ChatGPT plan")).toBeNull();
    expect(screen.getByText("Using ChatGPT plan")).toBeTruthy();
    expect(screen.getByText("Signed in as ada@example.com.")).toBeTruthy();
    expect((screen.getByRole("link", { name: "Manage usage" }) as HTMLAnchorElement).href).toBe("https://chatgpt.com/settings/usage");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.signOut).toHaveBeenCalled());
    expect(await screen.findByText("Last signed in as ada@example.com.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use a different ChatGPT account" }));
    await waitFor(() => expect(api.start).toHaveBeenLastCalledWith(info, { newAccount: true }));
  });

  it("a sign-in without permission to use the plan: says so and asks again", async () => {
    const { api } = fakeApi({ signedIn: true, planUsage: false, scopes: ["openid"], pending: null, account: { email: "ada@example.com" } });
    render(<ChatGptConnect info={info} api={api} />);
    expect(await screen.findByText(/isn't allowed to use your ChatGPT plan/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith(info, { allowPlanUsage: true }));
  });

  it("a usage limit points to ChatGPT settings; a failed sign-in shows the engine's sentence", async () => {
    const limited = fakeApi({ signedIn: true, planUsage: true, scopes: [], pending: null, usageLimit: { at: "2026-10-09T12:00:00.000Z" } });
    render(<ChatGptConnect info={info} api={limited.api} />);
    expect(await screen.findByText("Usage limit reached")).toBeTruthy();
    expect(screen.getByText("Review your plan or this app's limit in ChatGPT settings.")).toBeTruthy();
    cleanup();
    const failed = fakeApi({ ...SIGNED_OUT, lastError: "The sign-in was declined in the browser, so Knowledge Vault cannot use your ChatGPT plan. You can try again any time." });
    render(<ChatGptConnect info={info} api={failed.api} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/declined in the browser/);
  });

  it("an unconfirmed revocation: signed out here, and told how to make sure", async () => {
    const { api } = fakeApi({ signedIn: true, planUsage: true, scopes: [], pending: null }, false);
    render(<ChatGptConnect info={info} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/ChatGPT did not confirm that the sign-in was revoked/)).toBeTruthy();
  });
});
