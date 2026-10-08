// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
