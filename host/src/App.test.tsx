// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { declareDesktopHost, HOST_SLOT, setHostModel } from "./bootstrap.js";
import { announceModelsChanged } from "./model-declaration.js";

// App mounts the vault package's libraries and a screen per route; none of that matters to what App declares to the vault.
vi.mock("@powerhousedao/reactor-browser", () => ({ setRenown: () => {} }));
vi.mock("@powerhousedao/knowledge-note", () => ({}));
vi.mock("@powerhousedao/workflow", () => ({}));
vi.mock("./components/HostModals.js", () => ({ HostModals: () => null }));
vi.mock("./components/HostToasts.js", () => ({ HostToasts: () => null }));
vi.mock("./components/DownloadNotice.js", () => ({ DownloadNotice: () => null }));
vi.mock("./screens/Landing.js", () => ({ Landing: () => null }));
vi.mock("./screens/RemoteWorkspaceScreen.js", () => ({ RemoteWorkspaceScreen: () => null }));
// Settings says which section is open, so a case can tell where the app was taken.
vi.mock("./screens/Settings.js", async () => {
  const { createElement } = await import("react");
  return { Settings: ({ section }: { section: string }) => createElement("p", null, `Settings: ${section}`) };
});
vi.mock("./screens/WorkflowsScreen.js", () => ({ WorkflowsScreen: () => null }));
vi.mock("./screens/WorkspaceScreen.js", () => ({ WorkspaceScreen: () => null }));
const identity = vi.hoisted(() => ({ status: null as { authenticated: boolean; address?: string; did?: string } | null, error: null, refresh: async () => {} }));
vi.mock("./state/use-identity.js", () => ({ useIdentity: () => identity }));
// The real declaration and store, watched: the cases read the slot the vault package reads, and what App asked for.
vi.mock("./bootstrap.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./bootstrap.js")>();
  return { ...real, declareDesktopHost: vi.fn(real.declareDesktopHost), setHostModel: vi.fn(real.setHostModel) };
});

const info = { origin: "http://127.0.0.1:4301", graphqlUrl: "http://127.0.0.1:4301/graphql", controlOrigin: "http://127.0.0.1:4302", controlToken: "tok-1" };
type Declared = { switchboardOrigin: string; bearer?: () => Promise<string | undefined>; identity?: { address: string; did?: string }; model?: { baseUrl: string; model: string; label: string; headers: () => Record<string, string> } | null; openModelSettings?: () => void };
const slot = () => (globalThis as Record<string, unknown>)[HOST_SLOT] as Declared;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settings = (models: Record<string, unknown>) => ({ version: 1, models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna", hasKey: true, local: false, provider: "openrouter", ...models }, conversion: { mode: "local", remoteUrl: "" } });

/** What the engine's /settings says right now; the cases change it between a mount and an announcement. */
let settingsAnswer: () => Response;
const engine = vi.fn(async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  if (path === "/settings") return settingsAnswer();
  if (path === "/remote-vaults") return json({ vaults: [] });
  return json({ error: `unexpected ${path}` }, 404);
});
const settingsReads = () => engine.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/settings").length;
const mount = (props: Partial<Parameters<typeof App>[0]> = {}) => render(<App info={info} client={{} as never} {...props} />);

beforeEach(() => {
  vi.stubGlobal("fetch", engine);
  settingsAnswer = () => json(settings({}));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>)[HOST_SLOT];
  setHostModel(undefined); // the model is module state: one case's must not reach the next
  identity.status = null;
  vi.clearAllMocks();
  window.location.hash = "";
});

describe("App declares the app's model to the vault", () => {
  it("reads the engine's settings and declares the model with the opener, for the local engine", async () => {
    mount();
    await waitFor(() => expect(slot().model).toMatchObject({ baseUrl: "http://127.0.0.1:4302/llm/v1", model: "openai/gpt-6-luna", label: "openai/gpt-6-luna via OpenRouter" }));
    expect(slot().model?.headers()).toEqual({ authorization: "Bearer tok-1" });
    expect(typeof slot().openModelSettings).toBe("function");
    expect(slot().switchboardOrigin).toBe(info.origin);
  });

  it("the opener it declares takes the app to Settings › Models, called from outside the app's React tree", async () => {
    window.location.hash = "#/vault/abc";
    const view = mount();
    await waitFor(() => expect(typeof slot().openModelSettings).toBe("function"));
    expect(view.queryByText("Settings: models")).toBeNull();
    slot().openModelSettings?.();
    expect(window.location.hash).toBe("#/settings/models");
    expect(await view.findByText("Settings: models")).toBeTruthy();
  });

  it("declares again, with the new model, when Settings › Models announces a save", async () => {
    mount();
    await waitFor(() => expect(slot().model?.model).toBe("openai/gpt-6-luna"));
    settingsAnswer = () => json(settings({ model: "google/gemini-3-flash" }));
    act(() => announceModelsChanged());
    await waitFor(() => expect(slot().model).toMatchObject({ model: "google/gemini-3-flash", label: "google/gemini-3-flash via OpenRouter" }));
  });

  it("declares null once the model is no longer set up (a hosted model whose key was removed): the chat shows its set-up panel", async () => {
    mount();
    await waitFor(() => expect(slot().model?.model).toBe("openai/gpt-6-luna"));
    settingsAnswer = () => json(settings({ hasKey: false }));
    act(() => announceModelsChanged());
    await waitFor(() => expect(slot().model).toBeNull());
    expect(typeof slot().openModelSettings).toBe("function");
  });

  it("keeps the last model when the engine does not answer, and does not fail", async () => {
    mount();
    await waitFor(() => expect(slot().model?.model).toBe("openai/gpt-6-luna"));
    const before = settingsReads();
    settingsAnswer = () => json({ error: "Not ready" }, 503);
    act(() => announceModelsChanged());
    await waitFor(() => expect(settingsReads()).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 25)); // the refused answer settles
    expect(slot().model?.model).toBe("openai/gpt-6-luna");
  });

  it("declares again for another engine: its gateway address and its bearer", async () => {
    const view = mount();
    await waitFor(() => expect(slot().model?.baseUrl).toBe("http://127.0.0.1:4302/llm/v1"));
    const other = { ...info, origin: "http://127.0.0.1:5301", controlOrigin: "http://127.0.0.1:5302", controlToken: "tok-2" };
    view.rerender(<App info={other} client={{} as never} />);
    await waitFor(() => expect(slot().model?.baseUrl).toBe("http://127.0.0.1:5302/llm/v1"));
    expect(slot().model?.headers()).toEqual({ authorization: "Bearer tok-2" });
    expect(slot().switchboardOrigin).toBe(other.origin);
  });

  it("ignores an answer that comes after the engine changed", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const staleAnswer = json(settings({ model: "first/engine" }));
    engine.mockImplementationOnce(async () => {
      await gate; // the first engine answers last
      return staleAnswer;
    });
    const view = mount();
    await waitFor(() => expect(settingsReads()).toBe(1));
    settingsAnswer = () => json(settings({ model: "second/engine" }));
    view.rerender(<App info={{ ...info, controlOrigin: "http://127.0.0.1:5302", controlToken: "tok-2" }} client={{} as never} />);
    await waitFor(() => expect(slot().model?.model).toBe("second/engine"));
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(slot().model?.model).toBe("second/engine");
    expect(slot().model?.baseUrl).toBe("http://127.0.0.1:5302/llm/v1");
  });

  it("while a remote vault is open it only stores the model: the remote screen is the sole declarer, and the local engine is declared again, with the model, when it is closed", async () => {
    window.location.hash = "#/remote/r1";
    declareDesktopHost("https://switchboard.example", {}); // what the remote screen declares
    vi.mocked(declareDesktopHost).mockClear();
    mount();
    await waitFor(() => expect(setHostModel).toHaveBeenCalledWith(expect.objectContaining({ model: "openai/gpt-6-luna" }), expect.any(Function)));
    expect(declareDesktopHost).not.toHaveBeenCalled();
    expect(slot().switchboardOrigin).toBe("https://switchboard.example");
    act(() => {
      window.location.hash = "#/";
    });
    await waitFor(() => expect(slot().switchboardOrigin).toBe(info.origin));
    expect(slot().model).toMatchObject({ model: "openai/gpt-6-luna" });
  });

  it("an answer asked before a sign-in landed does not erase the sign-in: the model is declared together with who is signed in now", async () => {
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    engine.mockImplementationOnce(async () => {
      await gate; // asked while nobody was signed in, answered last
      return json(settings({}));
    });
    const view = mount();
    await waitFor(() => expect(settingsReads()).toBe(1));
    identity.status = { authenticated: true, address: "0xabc", did: "did:pkh:eip155:1:0xabc" };
    view.rerender(<App info={info} client={{} as never} />);
    await waitFor(() => expect(slot().identity).toEqual({ address: "0xabc", did: "did:pkh:eip155:1:0xabc" }));
    releaseFirst();
    await waitFor(() => expect(slot().model?.model).toBe("openai/gpt-6-luna"));
    await new Promise((resolve) => setTimeout(resolve, 25)); // the late answer settles
    expect(slot().identity).toEqual({ address: "0xabc", did: "did:pkh:eip155:1:0xabc" });
    expect(slot().model?.model).toBe("openai/gpt-6-luna");
  });

  it("declares the model with the user's bearer for a protected engine, and an answer asked under an older bearer does not bring it back", async () => {
    const first = async () => "jwt-1";
    const second = async () => "jwt-2";
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    engine.mockImplementationOnce(async () => {
      await gate; // asked under the first bearer, answered last
      return json(settings({}));
    });
    const view = mount({ bearer: first });
    await waitFor(() => expect(settingsReads()).toBe(1));
    expect(slot().bearer).toBe(first);
    view.rerender(<App info={info} client={{} as never} bearer={second} />);
    await waitFor(() => expect(slot().bearer).toBe(second));
    releaseFirst();
    await waitFor(() => expect(slot().model?.model).toBe("openai/gpt-6-luna"));
    await new Promise((resolve) => setTimeout(resolve, 25)); // the late answer settles
    expect(slot().bearer).toBe(second);
    expect(slot().model?.model).toBe("openai/gpt-6-luna");
  });
});
