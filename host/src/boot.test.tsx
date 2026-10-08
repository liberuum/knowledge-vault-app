// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Boot } from "./boot.js";
import type { SidecarStatus } from "./sidecar.js";

// boot.tsx needs only the theme hooks from reactor-browser; the real module drags the whole client in.
vi.mock("@powerhousedao/reactor-browser", () => ({
  initTheme: () => {},
  useTheme: () => ({ theme: "dark", isSystem: false, setTheme: () => {} }),
}));

afterEach(() => cleanup());

function fakeWatcher() {
  let cb: ((s: SidecarStatus) => void) | undefined;
  return {
    watch: (on: (s: SidecarStatus) => void) => {
      cb = on;
      return () => {
        cb = undefined;
      };
    },
    emit: (s: SidecarStatus) => act(() => cb?.(s)),
  };
}
const info = { origin: "http://127.0.0.1:4301", graphqlUrl: "http://127.0.0.1:4301/graphql", controlOrigin: "http://127.0.0.1:4302", controlToken: "t" };

describe("Boot", () => {
  it("shows the engine starting, then the vault app once the shell reports ready", async () => {
    const w = fakeWatcher();
    const load = vi.fn(async () => ({ App: () => <p>the app</p>, client: {} as never }));
    render(<Boot watch={w.watch} load={load} />);
    expect(screen.getByText("Starting the engine…")).toBeTruthy();
    w.emit({ state: "ready", info });
    await waitFor(() => expect(screen.getByText("the app")).toBeTruthy());
    expect(load).toHaveBeenCalledWith(info);
    expect(document.documentElement.dataset.baiTheme).toBe("dark");
  });

  it("reports an engine that exited instead of waiting forever", () => {
    const w = fakeWatcher();
    render(<Boot watch={w.watch} load={vi.fn()} />);
    w.emit({ state: "exited", code: 1 });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("The engine stopped")).toBeTruthy();
    expect(screen.getByText(/Exit code 1/)).toBeTruthy();
  });

  it("shows the supervisor restarting a crashed engine, in the landing's frame", () => {
    const w = fakeWatcher();
    render(<Boot watch={w.watch} load={vi.fn()} />);
    w.emit({ state: "restarting", attempt: 1, delayMs: 1000 });
    expect(screen.getByText("Restarting the engine…")).toBeTruthy();
  });

  it("returns to the landing after a delete-all, even when the window reloaded before Settings saw the result", () => {
    window.location.hash = "#/settings/vaults";
    window.sessionStorage.setItem("kv.go-home", "1");
    const w = fakeWatcher();
    render(<Boot watch={w.watch} load={vi.fn()} />);
    expect(window.location.hash).toBe("#/");
    expect(window.sessionStorage.getItem("kv.go-home")).toBeNull();
  });

  it("reports a vault app that failed to load", async () => {
    const w = fakeWatcher();
    render(<Boot watch={w.watch} load={vi.fn(async () => { throw new Error("chunk missing"); })} />);
    w.emit({ state: "ready", info });
    await waitFor(() => expect(screen.getByText("The vault app could not load")).toBeTruthy());
    expect(screen.getByText("chunk missing")).toBeTruthy();
  });
});

describe("Boot — the engine restarts", () => {
  it("reloads the page once the engine is ready again after a restart — the app is re-booted for the engine it now is", async () => {
    const w = fakeWatcher();
    const load = vi.fn(async () => ({ App: () => <p>the app</p>, client: {} as never }));
    const onEngineRestarted = vi.fn();
    render(<Boot watch={w.watch} load={load} onEngineRestarted={onEngineRestarted} />);
    w.emit({ state: "ready", info });
    await waitFor(() => expect(screen.getByText("the app")).toBeTruthy());
    w.emit({ state: "starting" });
    expect(screen.getByText("Starting the engine…")).toBeTruthy();
    expect(onEngineRestarted).not.toHaveBeenCalled();
    w.emit({ state: "ready", info });
    await waitFor(() => expect(onEngineRestarted).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("while the engine starts, shows its stages from the lines the shell forwards, and the strip names the stage under way", async () => {
    const w = fakeWatcher();
    let onLine: ((line: string) => void) | undefined;
    const watchLog = (on: (line: string) => void) => {
      onLine = on;
      return () => {
        onLine = undefined;
      };
    };
    render(<Boot watch={w.watch} watchLog={watchLog} load={vi.fn(async () => ({ App: () => <p>the app</p>, client: {} as never, bearer: async () => "" }))} />);
    w.emit({ state: "starting" });
    expect(screen.getByRole("region", { name: "Starting the vault engine" })).toBeTruthy();
    expect(screen.getByText("Starting the engine").closest("li")!.getAttribute("data-state")).toBe("current");
    act(() => onLine?.("[sidecar] [10:08:38.77] [switchboard] Using PGlite (PG17) for reactor storage at /x/vault/reactor"));
    expect(screen.getByText("Opening your vaults").closest("li")!.getAttribute("data-state")).toBe("done");
    expect(screen.getByText("Waking the graph index").closest("li")!.getAttribute("data-state")).toBe("current");
    expect(screen.getByText("Waking the graph index…")).toBeTruthy(); // the strip's detail
    expect(screen.getByText("[switchboard] Using PGlite (PG17) for reactor storage at /x/vault/reactor")).toBeTruthy();
  });

  it("shows unpacking first when the shell says the engine is being unpacked", () => {
    const w = fakeWatcher();
    render(<Boot watch={w.watch} watchLog={() => () => {}} load={vi.fn(async () => ({ App: () => <p>the app</p>, client: {} as never, bearer: async () => "" }))} />);
    w.emit({ state: "starting", preparing: true });
    expect(screen.getByText("Unpacking the engine").closest("li")!.getAttribute("data-state")).toBe("current");
    expect(screen.getByText("Unpacking the engine…")).toBeTruthy();
  });
});

describe("loadApp: the first declaration already says which model the chat runs on", () => {
  const SLOT = "__knowledgeVaultHost";
  type Declared = { switchboardOrigin?: string; model?: { baseUrl: string; model: string; label: string; headers: () => Record<string, string> } | null; openModelSettings?: () => void };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const settings = (models: Record<string, unknown>) => ({ version: 1, models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna", hasKey: true, local: false, provider: "openrouter", ...models }, conversion: { mode: "local", remoteUrl: "" } });
  /** The engine's control server: /status, and /settings answering whatever the case says. */
  const engine = (settingsAnswer: () => Response) =>
    vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/status") return json({ ok: true, protected: false });
      if (path === "/settings") return settingsAnswer();
      return json({ error: `unexpected ${path}` }, 404);
    });
  /**
   * A fresh boot (loadApp keeps one load per engine, and the host's model is module state). loadApp imports the vault app and the
   * reactor on demand: the stand-in for the app records the host slot at the moment it is imported, which is when the real vault
   * package reads it (its boot runs on import). Resolves with the slot the vault app found.
   */
  async function boot(): Promise<Declared | undefined> {
    let found: Declared | undefined;
    vi.resetModules();
    vi.doMock("./App.js", () => {
      const slot = (globalThis as Record<string, unknown>)[SLOT];
      found = slot === undefined ? undefined : { ...(slot as Declared) };
      return { App: () => null, LIBS: [] };
    });
    vi.doMock("./reactor.js", () => ({ installReactor: () => ({}) }));
    delete (globalThis as Record<string, unknown>)[SLOT];
    const { loadApp } = await import("./boot.js");
    await loadApp(info);
    return found;
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>)[SLOT];
    window.location.hash = "";
  });
  // Not per case: an unmock and the next case's mock of the same module are resolved together, in no fixed order.
  afterAll(() => {
    vi.doUnmock("./App.js");
    vi.doUnmock("./reactor.js");
  });

  it("declares the model the engine's settings name, with the control token, before the vault package is imported", async () => {
    vi.stubGlobal("fetch", engine(() => json(settings({}))));
    const declared = await boot();
    expect(declared?.switchboardOrigin).toBe(info.origin);
    expect(declared?.model).toMatchObject({ baseUrl: "http://127.0.0.1:4302/llm/v1", model: "openai/gpt-6-luna", label: "openai/gpt-6-luna via OpenRouter" });
    expect(declared?.model?.headers()).toEqual({ authorization: "Bearer t" });
  });

  it("declares the opener with it, and the opener goes to Settings › Models", async () => {
    vi.stubGlobal("fetch", engine(() => json(settings({}))));
    const declared = await boot();
    expect(typeof declared?.openModelSettings).toBe("function");
    declared?.openModelSettings?.();
    expect(window.location.hash).toBe("#/settings/models");
  });

  it("with no model set up declares null, not nothing: the app manages the model, so the chat shows its set-up panel and never the browser's connect form", async () => {
    vi.stubGlobal("fetch", engine(() => json(settings({ model: "" }))));
    const declared = await boot();
    expect(declared).toHaveProperty("model", null);
    expect(typeof declared?.openModelSettings).toBe("function");
  });

  it("when the engine's settings do not answer, still declares null and still loads the app", async () => {
    vi.stubGlobal("fetch", engine(() => json({ error: "Not ready" }, 503)));
    const declared = await boot();
    expect(declared).toHaveProperty("model", null);
    expect(typeof declared?.openModelSettings).toBe("function");
    expect(declared?.switchboardOrigin).toBe(info.origin);
  });
});
