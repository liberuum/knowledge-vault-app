// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarInfo } from "../sidecar.js";

vi.mock("../vaults.js", async (original) => ({
  ...(await original<typeof import("../vaults.js")>()),
  fetchVaults: vi.fn(),
  fetchPipeline: vi.fn(),
  fetchConverter: vi.fn(),
}));
vi.mock("./api.js", async (original) => ({
  ...(await original<typeof import("./api.js")>()),
  listStarters: vi.fn(),
  addStarter: vi.fn(),
  finishOnboarding: vi.fn(async () => {}),
}));
const vaults = await import("../vaults.js");
const api = await import("./api.js");
const { WorkflowsStep } = await import("./WorkflowsStep.js");
const { Onboarding } = await import("./Onboarding.js");
const { addedLine, STARTERS } = await import("./starters.js");

const info = { origin: "http://127.0.0.1:4201", controlOrigin: "http://127.0.0.1:4202", controlToken: "t" } as SidecarInfo;
const ready = { state: "ready", workflowId: "wf-pipeline", connectionId: "c1" } as const;
const feedOn = { workflowId: "wf-feed", starter: "feed", label: "Feed: example.com", name: "Research — Feed: example.com", createdAt: "2026-10-15T10:00:00.000Z", status: "ENABLED" } as const;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.mocked(vaults.fetchVaults).mockResolvedValue([{ id: "v1", slug: "research", name: "Research", noteCount: 0, sourceCount: 2 }]);
  vi.mocked(vaults.fetchPipeline).mockResolvedValue(ready);
  vi.mocked(api.listStarters).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the Workflow Studio side trip", () => {
  it("answers what Studio is with the vault's own processing, how one starts, then offers the templates", async () => {
    const onStudio = vi.fn();
    render(<WorkflowsStep info={info} vaultId="v1" onBack={vi.fn()} onStudio={onStudio} />);
    expect(screen.getByRole("heading", { name: "Let your vault fill itself" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["What Workflow Studio is", "How you start one", "Start from a template"]);
    const flow = screen.getByRole("list", { name: "Your vault's processing, as a workflow" });
    expect(within(flow).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Source queuedtrigger", "Extract claimsstep 1", "Connect notesstep 2", "Place in mapsstep 3", "Check notesstep 4"]);
    expect(await screen.findByText("Running in your vault")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "See it in Studio" }));
    expect(onStudio).toHaveBeenCalledWith("wf-pipeline");
    expect(screen.getByRole("link", { name: "700+ more" }).getAttribute("href")).toBe("https://www.activepieces.com/pieces");
    expect(screen.getAllByRole("button", { expanded: false }).map((b) => b.querySelector("strong")?.textContent)).toEqual(STARTERS.map((s) => s.title));
  });

  it("opens a template in place, adds it with what was typed, and says what happened and what comes next", async () => {
    vi.mocked(api.addStarter).mockResolvedValue({ ...feedOn, added: 3 });
    const onStudio = vi.fn();
    render(<WorkflowsStep info={info} vaultId="v1" onBack={vi.fn()} onStudio={onStudio} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow a blog or newsletter/ }));
    expect(screen.getByRole("button", { name: /Follow a blog or newsletter/ }).getAttribute("aria-expanded")).toBe("true");
    const add = await screen.findByRole("button", { name: "Add to Research" });
    expect((add as HTMLButtonElement).disabled).toBe(true); // nothing typed yet
    fireEvent.change(screen.getByLabelText("The feed's address"), { target: { value: " example.com/feed " } });
    const processing = screen.getByLabelText("Turn what arrives into notes");
    expect(processing.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(processing);
    fireEvent.click(add);
    await waitFor(() => expect(api.addStarter).toHaveBeenCalledWith(info, "v1", { starter: "feed", feedUrl: "example.com/feed", process: false, backfill: true }));
    expect(await screen.findByText("3 recent posts added to Sources › Feeds. New posts arrive within 15 minutes of being published.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open it in Studio" }));
    expect(onStudio).toHaveBeenCalledWith("wf-feed");
  });

  it("shows the engine's reason on the card when a key or address is refused, and keeps what was typed", async () => {
    vi.mocked(api.addStarter).mockRejectedValue(new Error("Granola did not accept that key: Invalid API key."));
    render(<WorkflowsStep info={info} vaultId="v1" onBack={vi.fn()} onStudio={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Bring in your meeting notes/ }));
    const key = screen.getByLabelText("Granola API key") as HTMLInputElement;
    expect(key.type).toBe("password");
    fireEvent.change(key, { target: { value: "grn_bad" } });
    fireEvent.click(await screen.findByRole("button", { name: "Add to Research" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not accept that key/);
    expect(key.value).toBe("grn_bad");
    expect(key.getAttribute("aria-invalid")).toBe("true");
  });

  it("lists what is already on under its template, and turns the templates off until the vault has processing", async () => {
    vi.mocked(api.listStarters).mockResolvedValue([feedOn]);
    const onStudio = vi.fn();
    const first = render(<WorkflowsStep info={info} vaultId="v1" onBack={vi.fn()} onStudio={onStudio} />);
    const running = await screen.findByRole("list", { name: "Follow a blog or newsletter: on in this vault" });
    expect(within(running).getByText("Feed: example.com")).toBeTruthy();
    fireEvent.click(within(running).getByRole("button", { name: "Open" }));
    expect(onStudio).toHaveBeenCalledWith("wf-feed");
    first.unmount();

    vi.mocked(vaults.fetchPipeline).mockResolvedValue({ state: "unconfigured" });
    render(<WorkflowsStep info={info} vaultId="v1" onBack={vi.fn()} onStudio={vi.fn()} />);
    expect(await screen.findByText("Templates need this vault's processing")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Follow research on a topic/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is a side trip of the guide: the rail keeps First notes lit, Skip stays hidden, and Back returns to the overview", () => {
    const onStep = vi.fn();
    render(<Onboarding info={info} step="workflows" vaultId="v1" onStep={onStep} onFinish={vi.fn()} onVisit={vi.fn()} onRuns={vi.fn()} onLeave={vi.fn()} />);
    const track = screen.getByRole("list", { name: "Setup steps" });
    expect(within(track).getAllByRole("listitem")[3]!.getAttribute("aria-current")).toBe("step");
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Where you are" })).getByText("Side trip")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to setup" }));
    expect(onStep).toHaveBeenCalledWith("notes", "v1");
  });

  it("words the result for what was asked", () => {
    const papers = STARTERS.find((s) => s.id === "papers")!;
    const base = { ...feedOn, starter: "papers" as const };
    expect(addedLine(papers, { ...base, added: 1 }, true)).toBe("1 new paper added to Sources › Papers. New papers are looked for every hour.");
    expect(addedLine(papers, { ...base, added: 0 }, true)).toBe("It is on, and found nothing to add yet. New papers are looked for every hour.");
    expect(addedLine(papers, { ...base, added: 0 }, false)).toBe("It is on. New papers are looked for every hour.");
  });
});
