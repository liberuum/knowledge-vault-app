// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidecarInfo } from "../sidecar.js";
import type { VaultSummary } from "../vaults.js";
import { GettingStarted } from "./GettingStarted.js";

const info = { origin: "http://127.0.0.1:4201", controlOrigin: "http://127.0.0.1:4202", controlToken: "t" } as SidecarInfo;
const research: VaultSummary = { id: "v1", slug: "research", name: "Research", noteCount: 12, sourceCount: 2 };
function memoryStorage(entries: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(entries));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}
const remembered = (s: Storage) => JSON.parse(s.getItem("kv-getting-started:v1") ?? "{}") as Record<string, unknown>;
const everyStep = () =>
  memoryStorage({
    "kv-getting-started:v1": JSON.stringify({ readNotes: true, explored: { graph: true, search: true, processing: true } }),
    "bai-chat:v1:v1": JSON.stringify([{ messages: [{ role: "user", content: "What is in here?" }] }]),
  });
const primaries = (el: HTMLElement) => el.querySelectorAll(".kv-button-primary");
afterEach(() => cleanup());

describe("Getting started", () => {
  it("on the front page: where you are, the one next step, and the whole list a click away", () => {
    const storage = memoryStorage();
    const onOpenView = vi.fn();
    render(<GettingStarted info={info} vaults={[research]} modelReady storage={storage} onNewVault={vi.fn()} onOpenView={onOpenView} onWorkflows={vi.fn()} />);
    const card = screen.getByRole("region", { name: "Getting started" });
    expect(within(card).getByRole("progressbar", { name: "Getting started" }).getAttribute("aria-valuetext")).toBe("3 of 8 steps done");
    expect(within(card).getByText("3 of 8 steps done")).toBeTruthy();
    expect(within(card).getByText("Next step")).toBeTruthy();
    expect(within(card).getByText("Read your first notes")).toBeTruthy();
    // One highlighted action, and the other steps out of the way until asked for.
    expect(primaries(card)).toHaveLength(1);
    expect(within(card).queryByRole("button", { name: "Ask a question" })).toBeNull();

    const more = within(card).getByRole("button", { name: "Show all steps" });
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // A finished stage folds to its line; the next step is still the only highlighted button.
    const setUp = within(card).getByRole("button", { name: /Set up/ });
    expect(setUp.getAttribute("aria-expanded")).toBe("false");
    expect(setUp.textContent).toMatch(/Done/);
    expect(within(card).queryByText("Choose an AI model")).toBeNull();
    fireEvent.click(setUp);
    expect(within(card).getByText("Choose an AI model")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Ask a question" })).toBeTruthy();
    expect(primaries(card)).toHaveLength(1);

    fireEvent.click(within(card).getByRole("button", { name: "Open notes" }));
    expect(onOpenView).toHaveBeenCalledWith(research, "notes");
    expect(remembered(storage)).toMatchObject({ readNotes: true });
    expect(within(card).getByText("4 of 8 steps done")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Ask a question" }).className).toMatch(/kv-button-primary/);
  });

  it("while the first notes are written, watching the processing comes first, and the steps that read notes say why they wait", () => {
    const storage = memoryStorage();
    const onWorkflows = vi.fn();
    render(<GettingStarted info={info} vaults={[{ ...research, noteCount: 0, sourceCount: 1 }]} modelReady storage={storage} onNewVault={vi.fn()} onOpenView={vi.fn()} onWorkflows={onWorkflows} />);
    const card = screen.getByRole("region", { name: "Getting started" });
    expect(within(card).getByText("While your first notes are written")).toBeTruthy();
    expect(within(card).getByText("Watch the processing")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Show all steps" }));
    expect(within(card).getAllByText("Available once a source is processed.")).toHaveLength(4);
    fireEvent.click(within(card).getByRole("button", { name: "Watch it work" }));
    expect(onWorkflows).toHaveBeenCalledTimes(1);
    expect(remembered(storage)).toMatchObject({ explored: { processing: true } });
  });

  it("hides from the front page with an Undo, and Settings keeps it, with the switch that brings it back", () => {
    const storage = memoryStorage();
    const onOpenSettings = vi.fn();
    const { unmount } = render(<GettingStarted info={info} vaults={[research]} modelReady storage={storage} onNewVault={vi.fn()} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide Getting started" }));
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    const notice = screen.getByRole("status");
    expect(notice.textContent).toMatch(/Getting started is hidden/);
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("region", { name: "Getting started" })).toBeTruthy();
    expect(remembered(storage)).toMatchObject({ hidden: false });
    fireEvent.click(screen.getByRole("button", { name: "Hide Getting started" }));
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Settings › Getting started" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    unmount();

    // Settings: always the whole list, and the front-page switch, off now.
    render(<GettingStarted info={info} vaults={[research]} modelReady storage={storage} onNewVault={vi.fn()} onOpenView={vi.fn()} variant="settings" />);
    const settings = screen.getByRole("region", { name: "Getting started" });
    expect(within(settings).getByRole("button", { name: "Ask a question" })).toBeTruthy();
    const toggle = within(settings).getByRole("switch", { name: "Show on the front page" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(remembered(storage)).toMatchObject({ hidden: false });
  });

  it("every step done: a line, not a list — Hide this list, and the optional commands inside their own step", () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const storage = everyStep();
    render(<GettingStarted info={info} vaults={[research]} modelReady storage={storage} onNewVault={vi.fn()} />);
    const card = screen.getByRole("region", { name: "You're all set" });
    expect(within(card).getByText("Every step done")).toBeTruthy();
    expect(within(card).getByText(/One optional step is left/)).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Hide this list" }).className).toMatch(/kv-button-primary/);

    fireEvent.click(within(card).getByRole("button", { name: "Show the commands" }));
    const tools = within(card).getByText("Use your vault from Claude Code, Codex or Gemini CLI").closest("li")!;
    expect(within(tools).getByText("Claude Code")).toBeTruthy();
    expect(within(tools).getByText(/claude mcp add --transport http knowledge-vault http:\/\/127\.0\.0\.1:4201\/mcp/)).toBeTruthy();

    // With the list open, the header's close still hides it; folded back, the line's own button does.
    expect(within(card).getByRole("button", { name: "Hide Getting started" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Show less" }));
    fireEvent.click(within(card).getByRole("button", { name: "Hide this list" }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(remembered(storage)).toMatchObject({ hidden: true });
  });

  it("on a first run, the model comes first; and once the vault form is on screen, the step points to it instead of a second button", () => {
    const onModels = vi.fn();
    const { unmount } = render(<GettingStarted info={info} vaults={[]} modelReady={false} storage={memoryStorage()} onModels={onModels} onNewVault={vi.fn()} vaultFormOpen />);
    const card = screen.getByRole("region", { name: "Getting started" });
    expect(within(card).getByText("0 of 8 steps done")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Choose a model" }));
    expect(onModels).toHaveBeenCalledTimes(1);
    unmount();

    const onNewVault = vi.fn();
    const first = render(<GettingStarted info={info} vaults={[]} modelReady storage={memoryStorage()} onNewVault={onNewVault} vaultFormOpen />);
    expect(screen.getByText("Name it in the form above.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create a vault" })).toBeNull();
    first.unmount();
    render(<GettingStarted info={info} vaults={[]} modelReady storage={memoryStorage()} onNewVault={onNewVault} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a vault" }));
    expect(onNewVault).toHaveBeenCalledTimes(1);
  });
});
