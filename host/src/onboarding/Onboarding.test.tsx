// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarInfo } from "../sidecar.js";
import type { AppSettings, LocalDiscovery } from "../vaults.js";

vi.mock("../vaults.js", async (original) => ({
  ...(await original<typeof import("../vaults.js")>()),
  fetchVaults: vi.fn(),
  fetchSettings: vi.fn(),
  discoverLocalModels: vi.fn(),
}));
vi.mock("./api.js", async (original) => ({
  ...(await original<typeof import("./api.js")>()),
  createGuideVault: vi.fn(),
  finishOnboarding: vi.fn(async () => {}),
}));
const vaults = await import("../vaults.js");
const api = await import("./api.js");
const { Onboarding } = await import("./Onboarding.js");

const info = { origin: "http://127.0.0.1:4201", controlOrigin: "http://127.0.0.1:4202", controlToken: "t" } as SidecarInfo;
const unconfigured: AppSettings = {
  version: 1,
  models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, local: false, provider: "openrouter" },
  conversion: { mode: "local", remoteUrl: "" },
} as AppSettings;
const twoFound: LocalDiscovery = {
  servers: [
    {
      endpoint: "http://127.0.0.1:11434/v1",
      port: 11434,
      provider: "Ollama",
      parallel: 1,
      models: [
        { id: "llama3.2:3b", loaded: false, contextLength: 8192, vision: false },
        { id: "qwen3:14b", loaded: true, contextLength: 40960, vision: false },
      ],
    },
  ],
  gpu: { kind: "dedicated", bytes: 16e9, name: "GPU" },
  hint: "",
};
function guide(step: "welcome" | "ai" | "vault", onStep = vi.fn()) {
  render(<Onboarding info={info} step={step} onStep={onStep} onFinish={vi.fn()} onVisit={vi.fn()} onRuns={vi.fn()} onLeave={vi.fn()} />);
  return onStep;
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the setup guide", () => {
  it("welcome: what the app does, how long setting it up takes, and one button", () => {
    const onStep = guide("welcome");
    expect(screen.getByRole("heading", { name: "Turn your documents into connected notes" })).toBeTruthy();
    expect(screen.getByText("4 short steps · a few minutes")).toBeTruthy();
    expect(screen.getByText("Your files and notes stay on this computer.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Setup steps" })).toBeNull(); // the track starts with the first step
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(onStep).toHaveBeenCalledWith("ai", undefined);
  });

  it("the track says where you are; a vault is used in one click, or named from an idea and created", async () => {
    vi.mocked(vaults.fetchVaults).mockResolvedValue([{ id: "v1", slug: "liberuum", name: "Liberuum", noteCount: 86, sourceCount: 4 }]);
    vi.mocked(api.createGuideVault).mockResolvedValue({ vault: { id: "v2", name: "Research" }, pipeline: { state: "ready" } } as Awaited<ReturnType<typeof api.createGuideVault>>);
    const onStep = guide("vault");
    const track = screen.getByRole("list", { name: "Setup steps" });
    const items = within(track).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["AI model (done)", "2First vault", "3Add sources", "4First notes"]);
    expect(items[1]!.getAttribute("aria-current")).toBe("step");
    expect(items[0]!.getAttribute("data-state")).toBe("done");

    fireEvent.click(await screen.findByRole("button", { name: "Use Liberuum" }));
    expect(onStep).toHaveBeenCalledWith("sources", "v1");

    const ideas = screen.getByRole("group", { name: "Name ideas" });
    fireEvent.click(within(ideas).getByRole("button", { name: "Research" }));
    expect((screen.getByLabelText("Or create a new vault") as HTMLInputElement).value).toBe("Research");
    expect(within(ideas).getByRole("button", { name: "Research" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Create vault" }));
    await waitFor(() => expect(api.createGuideVault).toHaveBeenCalledWith(info, "Research"));
    await waitFor(() => expect(onStep).toHaveBeenCalledWith("sources", "v2"));
  });

  it("the AI step: what was found first, the suggestion named, the plan sign-in labelled as the alternative, and the promise", async () => {
    vi.mocked(vaults.fetchSettings).mockResolvedValue(unconfigured);
    vi.mocked(vaults.discoverLocalModels).mockResolvedValue(twoFound);
    guide("ai");
    expect(await screen.findByText("Found on this computer")).toBeTruthy();
    const suggested = screen.getByText("Suggested");
    expect(suggested.closest("label")?.textContent).toMatch(/qwen3:14b/);
    expect(screen.getAllByText("Suggested")).toHaveLength(1);
    expect(screen.getByText("It reads each source and writes the notes, and the vault's chat uses it too.")).toBeTruthy();
    expect(screen.getByText("Or use your AI plan")).toBeTruthy();
    expect(screen.getByText("Nothing leaves this computer.")).toBeTruthy();
  });
});
