// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsApi } from "./Settings.js";
import { Settings } from "./Settings.js";
import type { SettingsSection } from "../shell/router.js";
import type { ConverterStatus, SettingsPatch } from "../vaults.js";

const converterReady: ConverterStatus = {
  mode: "local",
  state: "ready",
  url: "http://127.0.0.1:5999",
  localUrl: "http://127.0.0.1:5999",
  pid: 4242,
  exitCode: null,
  restarts: 0,
  logPath: "/home/u/.local/share/kv/vault/logs/converter.log",
  health: { ok: true, backend: "pdfjs", binding: false, ready: false, formats: ["pdf", "md", "markdown", "txt"] },
  error: null,
  installed: { binding: { installed: false, version: null, supported: true, platform: "linux-x64-gnu", reason: null }, models: { installed: false, supported: true, reason: null } },
  job: null,
};
import { useIdentity, type IdentityApi } from "../state/use-identity.js";
import { useState } from "react";

const theme = vi.hoisted(() => ({ setTheme: vi.fn(), current: "dark" as string, isSystem: false }));
vi.mock("@powerhousedao/reactor-browser", () => ({
  useTheme: () => ({ theme: theme.current, isSystem: theme.isSystem, setTheme: theme.setTheme }),
}));

const info = { origin: "http://127.0.0.1:4301", graphqlUrl: "http://127.0.0.1:4301/graphql", controlOrigin: "http://127.0.0.1:4302", controlToken: "t" };
function api(over: Partial<SettingsApi> = {}): SettingsApi {
  return {
    fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 24 }]),
    renameVault: vi.fn(async (_i, id: string, name: string) => ({ id, slug: "a", name })),
    deleteVault: vi.fn(async () => {}),
    fetchSettings: vi.fn(async () => ({ version: 1 as const, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false }, conversion: { mode: "local" as const, remoteUrl: "" } })),
    saveSettings: vi.fn(async (_i, patch: SettingsPatch) => ({ version: 1 as const, models: { endpoint: (patch.models?.endpoint ?? "https://openrouter.ai/api/v1").replace(/\/chat\/completions$/, ""), model: patch.models?.model ?? "", hasKey: !!patch.models?.apiKey }, conversion: { mode: patch.conversion?.mode ?? ("local" as const), remoteUrl: patch.conversion?.remoteUrl ?? "" } })),
    fetchStatus: vi.fn(async () => ({ ok: true as const, port: 4301, controlPort: 4302, appVersion: "0.1.0", protected: false, dataDir: "/home/u/.local/share/kv/vault", stackVersion: "6.2.3-dev.44", vaultPackageVersion: "1.0.54-dev.22" })),
    fetchProtection: vi.fn(async () => ({ protected: false, adminAddress: null })),
    fetchModelCatalog: vi.fn(async () => ({
      ok: true as const,
      models: [
        { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", contextLength: 400_000, promptPrice: 1.25, completionPrice: 10, free: false, jsonOutput: true, textOutput: true, maxOutput: 128_000, quality: 38 },
        { id: "google/gemini-3-flash", name: "Google: Gemini 3 Flash", contextLength: 1_000_000, promptPrice: 0.3, completionPrice: 2.5, free: false, jsonOutput: true, textOutput: true, maxOutput: 65_000, quality: 42 },
        { id: "meta/llama-5-8b:free", name: "Meta: Llama 5 8B (free)", contextLength: 128_000, promptPrice: 0, completionPrice: 0, free: true, jsonOutput: false, textOutput: true },
        { id: "stability/sd4", name: "Stability: SD4", contextLength: 8_000, promptPrice: 0.1, completionPrice: 0.1, free: false, jsonOutput: true, textOutput: false, quality: 10 },
      ],
    })),
    validateModels: vi.fn(async () => ({ ok: false, detail: "The provider refused the key: Invalid API key", warning: "This server is on your local network; restart the app after saving so the engine may reach it." })),
    setProtection: vi.fn(async (_i, wanted: boolean) => ({ restarting: true, protected: wanted, adminAddress: "0xabc" })),
    fetchConverter: vi.fn(async () => converterReady),
    restartConverter: vi.fn(async () => converterReady),
    installConverter: vi.fn(async (_i, component) => ({
      ...converterReady,
      job: { component, phase: "downloading" as const, percent: 42, bytes: 42, total: 100, message: "Downloading docling.rs-linux-x64-gnu — 42 %", error: null, startedAt: "2026-10-06T00:00:00.000Z", finishedAt: null },
    })),
    removeConverter: vi.fn(async () => converterReady),
    fetchBackups: vi.fn(async () => ({ backups: [{ name: "2026-10-07T12-00-00Z-6.2.3-dev.44", path: "/b/1", bytes: 12_000_000, stackVersion: "6.2.3-dev.44", createdAt: "2026-10-07T12:00:00.000Z" }], lastAction: { action: "backup" as const, ok: true, detail: "Backed up 12 MB as 2026-10-07T12-00-00Z-6.2.3-dev.44.", at: "2026-10-07T12:00:01.000Z" } })),
    requestBackup: vi.fn(async () => ({ restarting: true })),
    requestRestore: vi.fn(async () => ({ restarting: true })),
    requestDeleteAll: vi.fn(async () => ({ restarting: true })),
    exportVault: vi.fn(async () => ({ path: "/home/u/.local/share/kv/vault/exports/a-2026", documents: 24, bytes: 1000 })),
    fetchLogTail: vi.fn(async () => ["[sidecar] ready", "Authorization: Bearer abc.def", "model key sk-or-123"]),
    ...over,
  };
}
const identityApi: IdentityApi = {
  fetchAuthStatus: vi.fn(async () => ({ authenticated: false, appDid: "did:key:z", renownUrl: "https://www.renown.id", pending: null })),
  startLogin: vi.fn(async () => ({ alreadyAuthenticated: false })),
  cancelLogin: vi.fn(async () => ({})),
  logout: vi.fn(async () => ({})),
};
function Harness({ api: a, start = "vaults" }: { api: SettingsApi; start?: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(start);
  const identity = useIdentity(info, identityApi);
  return <Settings info={info} section={section} onSection={setSection} onBack={() => {}} onOpenWorkflows={() => {}} api={a} identity={identity} />;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Settings", () => {
  it("lists the sections, shows the vaults, and deletes one through the typed confirmation", async () => {
    const a = api();
    render(<Harness api={a} />);
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vaults" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getByText("24 notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.change(screen.getByLabelText("Type the vault’s name to confirm"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete vault" }));
    await waitFor(() => expect(a.deleteVault).toHaveBeenCalledWith(info, "v1"));
    await waitFor(() => expect(screen.getByText("No vaults yet.")).toBeTruthy());
  });

  it("saves model settings with the key only when one was entered, and switches the theme", async () => {
    const a = api();
    render(<Harness api={a} start="models" />);
    const endpoint = await screen.findByLabelText("Endpoint");
    fireEvent.change(endpoint, { target: { value: "http://127.0.0.1:11434/v1/chat/completions" } }); // what a provider page shows
    fireEvent.change(screen.getByLabelText("Model (required for processing)"), { target: { value: "llama3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "llama3" } }));
    await waitFor(() => expect((screen.getByLabelText("Endpoint") as HTMLInputElement).value).toBe("http://127.0.0.1:11434/v1")); // the engine's normalised value is what the form shows
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenLastCalledWith(info, { models: { endpoint: "http://127.0.0.1:11434/v1", model: "llama3", apiKey: "sk-new" } }));
    expect(await screen.findByRole("button", { name: "Remove key" })).toBeTruthy();
    // Validate asks the engine to try the saved settings against the provider and shows its verdict.
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() => expect(a.validateModels).toHaveBeenCalledWith(info));
    expect(await screen.findByText("The provider refused the key: Invalid API key")).toBeTruthy();
    expect(screen.getByText(/on your local network/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByLabelText(/^Light/));
    expect(theme.setTheme).toHaveBeenCalledWith("light");
  });

  it("offers the provider's models in a searchable list once a key is saved, recommended ones first, and keeps free text", async () => {
    const a = api({
      fetchSettings: vi.fn(async () => ({ version: 1 as const, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: true }, conversion: { mode: "off" as const, remoteUrl: "" } })),
      // the engine keeps the stored key across a save that does not mention one
      saveSettings: vi.fn(async (_i, patch: SettingsPatch) => ({ version: 1 as const, models: { endpoint: patch.models?.endpoint ?? "https://openrouter.ai/api/v1", model: patch.models?.model ?? "", hasKey: true }, conversion: { mode: "off" as const, remoteUrl: "" } })),
    });
    render(<Harness api={a} start="models" />);
    const field = await screen.findByLabelText("Model (required for processing)");
    await waitFor(() => expect(a.fetchModelCatalog).toHaveBeenCalledWith(info, "https://openrouter.ai/api/v1"));
    expect(await screen.findByText(/4 models available — type to search/)).toBeTruthy();
    fireEvent.focus(field);
    const list = await screen.findByRole("listbox", { name: "Models" });
    // best-scored capable model first; the free one under Free; the image model only under All models
    const groups = within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Recommended for processing", "Free", "All models"]);
    const recommended = within(within(list).getByRole("group", { name: "Recommended for processing" })).getAllByRole("option").map((o) => o.textContent);
    expect(recommended[0]).toContain("google/gemini-3-flash");
    expect(recommended[0]).toContain("1M context");
    expect(recommended[0]).toContain("$0.3 / $2.5 per M tokens");
    expect(recommended[1]).toContain("openai/gpt-6-luna");
    expect(within(within(list).getByRole("group", { name: "Free" })).getByRole("option").textContent).toContain("free");
    // typing searches every group
    fireEvent.change(field, { target: { value: "luna" } });
    expect(within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option")).toHaveLength(1);
    // choosing fills the field and saving sends the id
    fireEvent.click(screen.getByRole("option", { name: /openai\/gpt-6-luna/ }));
    expect((screen.getByLabelText("Model (required for processing)") as HTMLInputElement).value).toBe("openai/gpt-6-luna");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText(/OpenAI: GPT-6 Luna · 400k context · \$1.25 \/ \$10 per M tokens/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" } }));
    expect(await screen.findByText("Saved")).toBeTruthy();
    // a model the list does not know can still be typed and saved
    fireEvent.change(screen.getByLabelText("Model (required for processing)"), { target: { value: "my/custom-model" } });
    expect(await screen.findByText(/No model matches/)).toBeTruthy();
  });

  it("asks nothing of the provider without a saved key and says why", async () => {
    const a = api();
    render(<Harness api={a} start="models" />);
    await screen.findByLabelText("Model (required for processing)");
    expect(screen.getByText("Save your API key to pick from the models it gives you.")).toBeTruthy();
    expect(a.fetchModelCatalog).not.toHaveBeenCalled();
  });

  it("shows diagnostics with the copy blocks for the CLI and MCP, and the versions in About", async () => {
    const a = api();
    render(<Harness api={a} start="diagnostics" />);
    expect(await screen.findByText(/Ready on port 4301/)).toBeTruthy();
    expect(screen.getByText("switchboard init --url http://127.0.0.1:4301/graphql --name local-vault --use-profile")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:4301/mcp")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(await screen.findByText("6.2.3-dev.44")).toBeTruthy();
    expect(screen.getByText("1.0.54-dev.22")).toBeTruthy();
  });

  it("shows the converter's state and what it reads, restarts it, and switches where documents convert", async () => {
    const a = api();
    render(<Harness api={a} start="conversion" />);
    const nav = Array.from(screen.getByRole("navigation", { name: "Settings sections" }).querySelectorAll("button")).map((b) => b.textContent);
    expect(nav.indexOf("Conversion")).toBe(nav.indexOf("Models") + 1);
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByText(/^Reads PDF, Markdown and plain text files\./)).toBeTruthy();
    expect(screen.getByText(/binding, which is not installed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(a.restartConverter).toHaveBeenCalledWith(info));

    fireEvent.click(screen.getByLabelText(/^Another server/));
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "http://10.0.0.5:5011" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { conversion: { mode: "remote", remoteUrl: "http://10.0.0.5:5011" } }));
    fireEvent.click(screen.getByLabelText(/^Off/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenLastCalledWith(info, { conversion: { mode: "off", remoteUrl: "http://10.0.0.5:5011" } }));
    expect(a.fetchConverter).toHaveBeenCalledTimes(3); // on open, after each save
  });

  it("names the exit code and the log when the converter is down", async () => {
    const down: ConverterStatus = { ...converterReady, state: "down", url: null, localUrl: null, pid: null, exitCode: 1, restarts: 1, health: null, error: "the converter exited with code 1 twice within 30 s" };
    const a = api({ fetchConverter: vi.fn(async () => down) });
    render(<Harness api={a} start="conversion" />);
    expect(await screen.findByText("Not responding")).toBeTruthy();
    expect(screen.getByText(/exited with code 1 twice/)).toBeTruthy();
    expect(screen.getByText(/converter\.log/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
  });

  it("offers the binding, gates the models on it, starts an install and shows its progress", async () => {
    const a = api();
    render(<Harness api={a} start="conversion" />);
    expect(await screen.findByRole("button", { name: "Install binding" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install models" })).toBeNull();
    expect(screen.getByText("Needs the converter binding first.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install binding" }));
    await waitFor(() => expect(a.installConverter).toHaveBeenCalledWith(info, "binding"));
    expect(await screen.findByText("Downloading docling.rs-linux-x64-gnu — 42 %")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Converter binding install progress" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install binding" })).toBeNull();
  });

  it("shows an installed binding with its version and offers to remove it, and the models become installable", async () => {
    const withBinding: ConverterStatus = { ...converterReady, installed: { binding: { installed: true, version: "1.58.0", supported: true, platform: "linux-x64-gnu", reason: null }, models: { installed: false, supported: true, reason: null } }, health: { ...converterReady.health, binding: true, formats: ["pdf", "md", "docx", "pptx", "xlsx"] } };
    const a = api({ fetchConverter: vi.fn(async () => withBinding) });
    render(<Harness api={a} start="conversion" />);
    expect(await screen.findByText("Installed · version 1.58.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove binding" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install models" })).toBeTruthy();
    expect(screen.getByText(/^Reads PDF, Markdown, Word, slides and spreadsheets files\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove binding" }));
    await waitFor(() => expect(a.removeConverter).toHaveBeenCalledWith(info, "binding"));
  });

  it("explains why the binding is not available on this platform and offers nothing to install", async () => {
    const mac: ConverterStatus = { ...converterReady, installed: { binding: { installed: false, version: null, supported: false, platform: null, reason: "The converter for macOS is coming — text PDFs, Markdown and plain text work now." }, models: { installed: false, supported: true, reason: null } } };
    const a = api({ fetchConverter: vi.fn(async () => mac) });
    render(<Harness api={a} start="conversion" />);
    expect(await screen.findByText(/converter for macOS is coming/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install binding" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Install models" })).toBeNull();
  });

  it("headlines another server by its answer, and names why the models cannot be installed here", async () => {
    const remote: ConverterStatus = { ...converterReady, mode: "remote", state: "off", url: "http://10.0.0.5:5011", localUrl: null, pid: null, health: { ok: true, backend: "docling.rs", binding: true, ready: true, formats: ["pdf", "docx"] } };
    const a = api({
      fetchConverter: vi.fn(async () => remote),
      fetchSettings: vi.fn(async () => ({ version: 1 as const, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false }, conversion: { mode: "remote" as const, remoteUrl: "http://10.0.0.5:5011" } })),
    });
    render(<Harness api={a} start="conversion" />);
    expect(await screen.findByText("Another server · Ready")).toBeTruthy();
    expect(screen.queryByText("Stopped")).toBeNull();
    cleanup();
    const windows: ConverterStatus = { ...converterReady, installed: { binding: { installed: true, version: "1.58.0", supported: true, platform: "win32-x64-msvc", reason: null }, models: { installed: false, supported: false, reason: "The PDF models need a Unix shell to install; Windows support arrives with its converter binding." } } };
    const b = api({ fetchConverter: vi.fn(async () => windows) });
    render(<Harness api={b} start="conversion" />);
    expect(await screen.findByText(/need a Unix shell/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install models" })).toBeNull();
  });

  it("backs up now, lists the backups with the last action, restores one after confirming, and says the engine restarts", async () => {
    const a = api();
    render(<Harness api={a} />);
    expect(await screen.findByText("2026-10-07T12-00-00Z-6.2.3-dev.44")).toBeTruthy();
    expect(screen.getByText(/Backed up 12 MB/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore this backup" }));
    await waitFor(() => expect(a.requestRestore).toHaveBeenCalledWith(info, "2026-10-07T12-00-00Z-6.2.3-dev.44"));
    expect(await screen.findByText(/Restarting the engine… the restore runs/)).toBeTruthy();
    // while the engine restarts, nothing else can be scheduled
    expect((screen.getByRole("button", { name: "Back up now" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const b = api();
    render(<Harness api={b} />);
    await screen.findByText("2026-10-07T12-00-00Z-6.2.3-dev.44");
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(b.requestBackup).toHaveBeenCalledWith(info));
    expect(await screen.findByText(/Restarting the engine… the backup runs/)).toBeTruthy();
  });
  it("exports a vault as documents and shows where it went", async () => {
    const a = api();
    render(<Harness api={a} />);
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(a.exportVault).toHaveBeenCalledWith(info, "v1"));
    expect(await screen.findByText("/home/u/.local/share/kv/vault/exports/a-2026")).toBeTruthy();
  });
  it("deletes all local data only once delete is typed, keeping the backups unless asked", async () => {
    const a = api();
    render(<Harness api={a} />);
    await screen.findByText("Alpha");
    const button = screen.getByRole("button", { name: "Delete all local data" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type delete to confirm"), { target: { value: "delete" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(a.requestDeleteAll).toHaveBeenCalledWith(info, false));
  });
  it("shows the engine's last lines in Diagnostics and copies diagnostics without secrets", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const a = api();
    render(<Harness api={a} start="diagnostics" />);
    expect(await screen.findByText(/\[sidecar\] ready/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = String((writeText.mock.calls[0] as unknown[])[0]);
    expect(copied).toContain("6.2.3-dev.44");
    expect(copied).toContain("[sidecar] ready");
    for (const secret of ["sk-or", "Bearer", "abc.def", "token"]) expect(copied).not.toContain(secret);
  });
  it("says update checks are off until the app has a release feed", async () => {
    render(<Harness api={api()} start="about" />);
    expect(await screen.findByText("Update checks are off until the app has a release feed.")).toBeTruthy();
  });
  it("keeps the engine running when the window closes, unless switched off in Appearance", async () => {
    const a = api({ fetchSettings: vi.fn(async () => ({ version: 1 as const, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false }, conversion: { mode: "local" as const, remoteUrl: "" }, ui: { closeToTray: true } })) });
    render(<Harness api={a} start="appearance" />);
    const box = (await screen.findByLabelText("Keep the engine running when the window closes")) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { ui: { closeToTray: false } }));
  });
});
