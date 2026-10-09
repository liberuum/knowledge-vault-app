// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsApi } from "./Settings.js";
import { Settings } from "./Settings.js";
import { MODELS_CHANGED_EVENT } from "../model-declaration.js";
import type { SettingsSection } from "../shell/router.js";
import type { ConverterStatus, ModelSettings, SettingsPatch } from "../vaults.js";

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
// OpenRouter's sign-in runs in the system browser; the tests decide how it ends.
const openrouter = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("../api/openrouter.js", () => ({ signInWithOpenRouter: openrouter.signIn }));

const info = { origin: "http://127.0.0.1:4301", graphqlUrl: "http://127.0.0.1:4301/graphql", controlOrigin: "http://127.0.0.1:4302", controlToken: "t" };

/** The address each named service means (the engine's own table). */
const ADDRESS = { openrouter: "https://openrouter.ai/api/v1", openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1", gemini: "https://generativelanguage.googleapis.com/v1beta/openai", xai: "https://api.x.ai/v1" } as const;
/** ChatGPT is reached at OpenAI's address (settings.ts keeps a marker for it). */
const ADDRESS_OF = (provider: string) => (provider === "chatgpt" ? "https://api.openai.com/v1" : ADDRESS[provider as keyof typeof ADDRESS]);
const LOOPBACK = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])([:/]|$)/;
/** What the engine answers to a save: a named service means its own address; a loopback address is a model on this computer; any other address is another service. */
function engineAnswer(patch: SettingsPatch) {
  const m = patch.models;
  const endpoint = (m?.endpoint ?? ADDRESS_OF(m?.provider ?? "openrouter")).replace(/\/chat\/completions$/, "");
  const provider: ModelSettings["provider"] = m?.provider ?? (m?.endpoint ? (LOOPBACK.test(endpoint) ? "local" : "custom") : "openrouter");
  return { version: 1 as const, models: { endpoint, model: m?.model ?? "", hasKey: !!m?.apiKey, local: provider === "local", provider }, conversion: { mode: patch.conversion?.mode ?? ("local" as const), remoteUrl: patch.conversion?.remoteUrl ?? "" } };
}
/** Saved settings for a provider, as `fetchSettings` answers them. */
function savedWith(provider: ModelSettings["provider"], over: Partial<ModelSettings> = {}) {
  const endpoint = provider === "local" ? "http://127.0.0.1:8080/v1" : provider === "custom" ? "https://models.example.com/v1" : ADDRESS_OF(provider);
  return { version: 1 as const, models: { endpoint, model: "", hasKey: false, local: provider === "local", provider, ...over }, conversion: { mode: "off" as const, remoteUrl: "" } };
}
function api(over: Partial<SettingsApi> = {}): SettingsApi {
  return {
    fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 24 }]),
    renameVault: vi.fn(async (_i, id: string, name: string) => ({ id, slug: "a", name })),
    deleteVault: vi.fn(async () => {}),
    fetchSettings: vi.fn(async () => ({ version: 1 as const, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, provider: "openrouter" as const }, conversion: { mode: "local" as const, remoteUrl: "" } })),
    saveSettings: vi.fn(async (_i, patch: SettingsPatch) => engineAnswer(patch)),
    fetchStatus: vi.fn(async () => ({ ok: true as const, port: 4301, controlPort: 4302, appVersion: "0.1.0", protected: false, dataDir: "/home/u/.local/share/kv/vault", stackVersion: "6.2.3-dev.44", vaultPackageVersion: "1.0.54-dev.22" })),
    fetchProtection: vi.fn(async () => ({ protected: false, adminAddress: null })),
    probeLocalModels: vi.fn(async (_i, endpoint: string) => (endpoint.includes("8080") ? { ok: true as const, endpoint, models: ["lfm2.5-8b-a1b", "qwen3.8-flash-next"] } : { ok: false as const, endpoint, detail: "Could not reach " + endpoint + ": fetch failed" })),
    fetchModelCatalogFor: vi.fn(async () => ({
      ok: true as const,
      models: [
        { id: "claude-sonnet-5", name: "Claude Sonnet 5", free: false },
        { id: "claude-haiku-5", name: "Claude Haiku 5", free: false },
        { id: "text-embedding-test", name: "An embedding model", free: false },
      ],
    })),
    fetchModelCatalog: vi.fn(async () => ({
      ok: true as const,
      models: [
        { id: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna", contextLength: 400_000, promptPrice: 1.25, completionPrice: 10, free: false, jsonOutput: true, textOutput: true, outputs: ["text"], maxOutput: 128_000, quality: 38 },
        { id: "google/gemini-3-flash", name: "Google: Gemini 3 Flash", contextLength: 1_000_000, promptPrice: 0.3, completionPrice: 2.5, free: false, jsonOutput: true, textOutput: true, outputs: ["text"], maxOutput: 65_000, quality: 42 },
        { id: "meta/llama-5-8b:free", name: "Meta: Llama 5 8B (free)", contextLength: 128_000, promptPrice: 0, completionPrice: 0, free: true, jsonOutput: false, textOutput: true },
        { id: "stability/sd4", name: "Stability: SD4", contextLength: 8_000, promptPrice: 0.1, completionPrice: 0.1, free: false, jsonOutput: true, textOutput: false, quality: 10 },
        { id: "mistral/small-5:free", name: "Mistral: Small 5 (free)", contextLength: 128_000, promptPrice: 0, completionPrice: 0, free: true, jsonOutput: true, textOutput: true, outputs: ["text"], inputs: ["text"], maxOutput: 32_000, quality: 20 },
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
    // Another service: any OpenAI-compatible server, by its address (a loopback address would be a model on this computer)
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "http://192.168.1.20:11434/v1/chat/completions" } }); // what a provider page shows
    fireEvent.change(screen.getByLabelText("Model (required for processing)"), { target: { value: "llama3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { endpoint: "http://192.168.1.20:11434/v1/chat/completions", model: "llama3" } }));
    await waitFor(() => expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("http://192.168.1.20:11434/v1")); // the engine's normalised value is what the form shows
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenLastCalledWith(info, { models: { endpoint: "http://192.168.1.20:11434/v1", model: "llama3", apiKey: "sk-new" } }));
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
      fetchSettings: vi.fn(async () => ({ version: 1 as const, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: true, provider: "openrouter" as const }, conversion: { mode: "off" as const, remoteUrl: "" } })),
      // the engine keeps the stored key across a save that does not mention one
      saveSettings: vi.fn(async (_i, patch: SettingsPatch) => ({ version: 1 as const, models: { endpoint: patch.models?.endpoint ?? "https://openrouter.ai/api/v1", model: patch.models?.model ?? "", hasKey: true, provider: "openrouter" as const }, conversion: { mode: "off" as const, remoteUrl: "" } })),
    });
    render(<Harness api={a} start="models" />);
    const field = await screen.findByLabelText("Model (required for processing)");
    await waitFor(() => expect(a.fetchModelCatalog).toHaveBeenCalledWith(info, "https://openrouter.ai/api/v1"));
    expect(await screen.findByText(/3 of the 5 models your key gives you can do the vault/)).toBeTruthy();
    fireEvent.focus(field);
    const list = await screen.findByRole("listbox", { name: "Models" });
    // best-scored capable model first; the usable free one under Free; the image model and the free one without JSON are not offered at all
    const groups = within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Recommended for processing", "Free"]);
    expect(within(list).queryByText(/stability\/sd4/)).toBeNull();
    expect(within(list).queryByText(/meta\/llama-5-8b:free/)).toBeNull();
    const recommended = within(within(list).getByRole("group", { name: "Recommended for processing" })).getAllByRole("option").map((o) => o.textContent);
    expect(recommended[0]).toContain("google/gemini-3-flash");
    expect(recommended[0]).toContain("1M context");
    expect(recommended[0]).toContain("$0.3 / $2.5 per M tokens");
    expect(recommended[1]).toContain("openai/gpt-6-luna");
    expect(within(within(list).getByRole("group", { name: "Free" })).getByRole("option").textContent).toContain("free");
    // each entry says whether the model can answer in JSON, which processing needs
    expect(recommended[0]).toContain("fits processing");
    expect(within(within(list).getByRole("group", { name: "Free" })).getByRole("option").textContent).toContain("mistral/small-5:free");
    // typing searches every group
    fireEvent.change(field, { target: { value: "luna" } });
    expect(within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option")).toHaveLength(1);
    // choosing fills the field and saving sends the id
    fireEvent.click(screen.getByRole("option", { name: /openai\/gpt-6-luna/ }));
    expect((screen.getByLabelText("Model (required for processing)") as HTMLInputElement).value).toBe("openai/gpt-6-luna");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText(/OpenAI: GPT-6 Luna · 400k context · \$1.25 \/ \$10 per M tokens · fits processing/)).toBeTruthy();
    // clicking the field again shows the whole list, not just the chosen model, with it highlighted — so another can be picked without clearing
    fireEvent.click(screen.getByLabelText("Model (required for processing)"));
    const reopened = within(screen.getByRole("listbox", { name: "Models" })).getAllByRole("option");
    expect(reopened).toHaveLength(3);
    expect(reopened.find((o) => o.textContent?.includes("openai/gpt-6-luna"))?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: /google\/gemini-3-flash/ }));
    expect((screen.getByLabelText("Model (required for processing)") as HTMLInputElement).value).toBe("google/gemini-3-flash");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { provider: "openrouter", model: "google/gemini-3-flash" } }));
    expect(await screen.findByText("Saved")).toBeTruthy();
    // a model the list does not know can still be typed and saved
    fireEvent.change(screen.getByLabelText("Model (required for processing)"), { target: { value: "my/custom-model" } });
    expect(await screen.findByText(/No model matches/)).toBeTruthy();
  });

  it("plugs in a model running on this computer: connect, see what it serves, use it — no key", async () => {
    let saved: { version: 1; models: { endpoint: string; model: string; hasKey: boolean; local?: boolean; provider: "local" | "openrouter" | "openai" | "anthropic" | "gemini" | "xai" | "custom" }; conversion: { mode: "off"; remoteUrl: string } } = { version: 1, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, local: false, provider: "openrouter" }, conversion: { mode: "off", remoteUrl: "" } };
    const a = api({
      fetchSettings: vi.fn(async () => saved),
      saveSettings: vi.fn(async (_i, patch: SettingsPatch) => {
        const local = (patch.models?.endpoint ?? "").startsWith("http://127.");
        saved = { ...saved, models: { ...saved.models, ...patch.models, hasKey: false, local, provider: local ? "local" : saved.models.provider } as typeof saved.models };
        return saved;
      }),
    });
    render(<Harness api={a} start="models" />);
    fireEvent.click(await screen.findByRole("radio", { name: /On this computer/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Use a local model…" }));
    // a server that is not running says so
    fireEvent.change(screen.getByLabelText("Local server address"), { target: { value: "http://127.0.0.1:9999/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Could not connect: Could not reach/)).toBeTruthy();
    // the real one: connected, what it serves, choose, use
    fireEvent.change(screen.getByLabelText("Local server address"), { target: { value: "http://127.0.0.1:8080/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Connected to http://127.0.0.1:8080/v1 — serving lfm2.5-8b-a1b, qwen3.8-flash-next")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen3.8-flash-next" } });
    fireEvent.click(screen.getByRole("button", { name: "Use qwen3.8-flash-next" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { endpoint: "http://127.0.0.1:8080/v1", model: "qwen3.8-flash-next" } }));
    // now running on it: the state, a connection check, and no key needed
    expect(await screen.findByText(/Using a model on this computer:/)).toBeTruthy();
    expect(screen.getByText("Not needed for a model on this computer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("Connected to http://127.0.0.1:8080/v1 — serving lfm2.5-8b-a1b, qwen3.8-flash-next")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Validate" })).toBeTruthy();
  });

  it("lists a service's models as soon as its key is entered, before saving, and saves the one picked", async () => {
    const a = api({ fetchSettings: vi.fn(async () => savedWith("openai", { model: "", hasKey: false })) });
    render(<Harness api={a} start="models" />);
    fireEvent.change(await screen.findByLabelText("Service"), { target: { value: "anthropic" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-test" } });
    await waitFor(() => expect(a.fetchModelCatalogFor).toHaveBeenCalledWith(info, { provider: "anthropic", endpoint: "", apiKey: "sk-ant-test" }), { timeout: 3000 });
    fireEvent.click(await screen.findByRole("button", { name: "Show the models" }));
    expect(screen.queryByRole("option", { name: /text-embedding-test/ })).toBeNull(); // not a chat model
    fireEvent.click(await screen.findByRole("option", { name: /claude-sonnet-5/ }));
    expect((screen.getByLabelText("Model (required for processing)") as HTMLInputElement).value).toBe("claude-sonnet-5");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, expect.objectContaining({ models: expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-ant-test" }) })));
  });

  it("asks nothing of the provider without a saved key and says why", async () => {
    const a = api();
    render(<Harness api={a} start="models" />);
    await screen.findByLabelText("Model (required for processing)");
    expect(screen.getByText("Enter your API key to see the models it gives you.")).toBeTruthy();
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
      fetchSettings: vi.fn(async () => ({ version: 1 as const, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, provider: "openrouter" as const }, conversion: { mode: "remote" as const, remoteUrl: "http://10.0.0.5:5011" } })),
    });
    render(<Harness api={a} start="conversion" />);
    expect(await screen.findByText("Another server · Ready")).toBeTruthy();
    expect(screen.queryByText("Stopped")).toBeNull();
    cleanup();
    const windows: ConverterStatus = { ...converterReady, installed: { binding: { installed: true, version: "1.58.0", supported: true, platform: "win32-x64-msvc", reason: null }, models: { installed: false, supported: false, reason: "Installing the PDF models needs curl on this computer." } } };
    const b = api({ fetchConverter: vi.fn(async () => windows) });
    render(<Harness api={b} start="conversion" />);
    expect(await screen.findByText(/needs curl on this computer/)).toBeTruthy();
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
    const a = api({ fetchSettings: vi.fn(async () => ({ version: 1 as const, models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, provider: "openrouter" as const }, conversion: { mode: "local" as const, remoteUrl: "" }, ui: { closeToTray: true } })) });
    render(<Harness api={a} start="appearance" />);
    const box = (await screen.findByLabelText("Keep the engine running when the window closes")) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { ui: { closeToTray: false } }));
  });
});

/** The vault chat runs on the model saved here (the app declares it to the vault), so every save that can change it is announced. */
describe("Settings › Models tells the app when the model changes", () => {
  const listeners: Array<() => void> = [];
  function listen() {
    const heard = vi.fn();
    window.addEventListener(MODELS_CHANGED_EVENT, heard);
    listeners.push(() => window.removeEventListener(MODELS_CHANGED_EVENT, heard));
    return heard;
  }
  afterEach(() => {
    while (listeners.length) listeners.pop()?.();
  });
  const withKey = () => ({ version: 1 as const, models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna", hasKey: true, provider: "openrouter" as const }, conversion: { mode: "off" as const, remoteUrl: "" } });

  it("after the form saves, once per save", async () => {
    const heard = listen();
    const a = api();
    render(<Harness api={a} start="models" />);
    fireEvent.change(await screen.findByLabelText("Model (required for processing)"), { target: { value: "llama3" } });
    expect(heard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(heard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(2));
  });

  it("not when the save fails: the engine kept the old model", async () => {
    const heard = listen();
    const a = api({ saveSettings: vi.fn(async () => { throw new Error("The engine said no"); }) });
    render(<Harness api={a} start="models" />);
    fireEvent.change(await screen.findByLabelText("Model (required for processing)"), { target: { value: "llama3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save: The engine said no")).toBeTruthy();
    expect(heard).not.toHaveBeenCalled();
  });

  it("after a model on this computer is chosen", async () => {
    const heard = listen();
    const a = api();
    render(<Harness api={a} start="models" />);
    fireEvent.click(await screen.findByRole("radio", { name: /On this computer/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Use a local model…" }));
    fireEvent.change(screen.getByLabelText("Local server address"), { target: { value: "http://127.0.0.1:8080/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText(/Connected to http:\/\/127.0.0.1:8080\/v1/);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen3.8-flash-next" } });
    expect(heard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use qwen3.8-flash-next" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { endpoint: "http://127.0.0.1:8080/v1", model: "qwen3.8-flash-next" } }));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  });

  it("after the key is removed: a hosted model without its key is no longer one the chat can use", async () => {
    const heard = listen();
    const a = api({
      fetchSettings: vi.fn(async () => withKey()),
      saveSettings: vi.fn(async () => ({ ...withKey(), models: { ...withKey().models, hasKey: false } })),
    });
    render(<Harness api={a} start="models" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { apiKey: "" } }));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  });

  it("not for a change that cannot touch the model", async () => {
    const heard = listen();
    const a = api({ fetchSettings: vi.fn(async () => ({ ...withKey(), ui: { closeToTray: true } })) });
    render(<Harness api={a} start="appearance" />);
    fireEvent.click(await screen.findByLabelText("Keep the engine running when the window closes"));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { ui: { closeToTray: false } }));
    expect(heard).not.toHaveBeenCalled();
  });
});

/** Settings › Models chooses where the AI model comes from: a model on this computer, OpenRouter, or an API key for a named service. */
describe("Settings › Models chooses a provider", () => {
  const listeners: Array<() => void> = [];
  function listen() {
    const heard = vi.fn();
    window.addEventListener(MODELS_CHANGED_EVENT, heard);
    listeners.push(() => window.removeEventListener(MODELS_CHANGED_EVENT, heard));
    return heard;
  }
  beforeEach(() => {
    openrouter.signIn.mockReset();
  });
  afterEach(() => {
    while (listeners.length) listeners.pop()?.();
  });

  it("Models: choosing API key › Anthropic saves the provider and links to where keys come from", async () => {
    const a = api();
    render(<Harness api={a} start="models" />);
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "anthropic" } });
    expect(screen.getByRole("link", { name: "Get a key" }).getAttribute("href")).toBe("https://console.anthropic.com/settings/keys");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-1" } });
    fireEvent.change(screen.getByLabelText("Model (required for processing)"), { target: { value: "claude-sonnet-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { provider: "anthropic", model: "claude-sonnet-5", apiKey: "sk-ant-1" } }));
  });
  it("Models: Gemini warns about the free tier", async () => {
    render(<Harness api={api()} start="models" />);
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "gemini" } });
    expect(screen.getByText("Free tier: Google uses what you send to improve its products.")).toBeTruthy();
  });

  it("offers this computer, OpenRouter and an API key as cards in one radio group, and ChatGPT as its sign-in button below them", async () => {
    render(<Harness api={api()} start="models" />);
    const group = await screen.findByRole("radiogroup", { name: "AI model provider" });
    const cards = within(group).getAllByRole("radio");
    expect(cards.map((c) => c.textContent)).toEqual([
      "On this computer A model running here: free, private, no key.",
      "OpenRouter One account, hundreds of models, pay as you go.",
      "API key OpenAI, Anthropic, Google Gemini, xAI or another service.",
    ]);
    expect(within(group).getByRole("button", { name: /Continue with ChatGPT/ })).toBeTruthy(); // not a card until chosen
    expect(cards.map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]); // the saved provider is OpenRouter
    expect(cards.map((c) => c.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]); // one tab stop: the chosen card
    fireEvent.click(cards[2]!);
    expect(cards.map((c) => c.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(cards.map((c) => c.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
  });

  it.each([
    ["local", "On this computer"],
    ["openrouter", "OpenRouter"],
    ["openai", "API key"],
    ["anthropic", "API key"],
    ["gemini", "API key"],
    ["xai", "API key"],
    ["custom", "API key"],
  ] as const)("starts on the card the saved provider (%s) belongs to", async (provider, title) => {
    render(<Harness api={api({ fetchSettings: vi.fn(async () => savedWith(provider)) })} start="models" />);
    expect((await screen.findByRole("radio", { checked: true })).textContent).toMatch(new RegExp(`^${title}`));
  });

  it("starts the API key card on the saved service, and Another service on the saved address", async () => {
    render(<Harness api={api({ fetchSettings: vi.fn(async () => savedWith("anthropic", { model: "claude-sonnet-5", hasKey: true })) })} start="models" />);
    expect(((await screen.findByLabelText("Service")) as HTMLSelectElement).value).toBe("anthropic");
    expect((screen.getByLabelText("Model (required for processing)") as HTMLInputElement).value).toBe("claude-sonnet-5");
    cleanup();
    render(<Harness api={api({ fetchSettings: vi.fn(async () => savedWith("custom")) })} start="models" />);
    expect(((await screen.findByLabelText("Service")) as HTMLSelectElement).value).toBe("custom");
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("https://models.example.com/v1");
  });

  it("moves between the cards with the arrow keys, choosing as it goes — and leaves the arrows to the fields inside", async () => {
    render(<Harness api={api()} start="models" />);
    const [local, router, apiKey] = (await screen.findAllByRole("radio")) as [HTMLElement, HTMLElement, HTMLElement];
    const chosen = () => screen.getByRole("radio", { checked: true });
    fireEvent.keyDown(screen.getByLabelText("API key"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("API key"), { key: "ArrowLeft" });
    expect(chosen()).toBe(router); // an arrow typed in a field moves its cursor, not the choice
    router.focus();
    fireEvent.keyDown(router, { key: "ArrowDown" });
    expect(chosen()).toBe(apiKey);
    expect(document.activeElement).toBe(apiKey);
    fireEvent.keyDown(apiKey, { key: "ArrowRight" }); // after the last comes the first
    expect(chosen()).toBe(local);
    expect(document.activeElement).toBe(local);
    fireEvent.keyDown(local, { key: "ArrowUp" }); // before the first comes the last
    expect(chosen()).toBe(apiKey);
    fireEvent.keyDown(apiKey, { key: "ArrowLeft" });
    expect(chosen()).toBe(router);
    fireEvent.keyDown(router, { key: "Home" });
    expect(chosen()).toBe(local);
    fireEvent.keyDown(local, { key: "End" });
    expect(chosen()).toBe(apiKey);
    fireEvent.keyDown(apiKey, { key: "Tab" });
    expect(chosen()).toBe(apiKey);
  });

  it("shows only the chosen card's controls, under it", async () => {
    render(<Harness api={api()} start="models" />);
    // OpenRouter, the saved provider: sign in, or paste a key
    expect(await screen.findByRole("button", { name: "Sign in with OpenRouter" })).toBeTruthy();
    expect(screen.getByText("or paste a key")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.queryByLabelText("Service")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use a local model…" })).toBeNull();
    // API key: a menu of the services, and the key
    fireEvent.click(screen.getByRole("radio", { name: /API key/ }));
    const menu = screen.getByLabelText("Service") as HTMLSelectElement;
    expect(Array.from(menu.options).map((o) => o.textContent)).toEqual(["OpenAI", "Anthropic", "Google Gemini", "xAI", "Another service"]);
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with OpenRouter" })).toBeNull();
    expect(screen.queryByLabelText("Address")).toBeNull();
    // This computer: the local block alone — no key, no model field, no Save
    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    expect(screen.getByRole("button", { name: "Use a local model…" })).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.queryByLabelText("Model (required for processing)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with OpenRouter" })).toBeNull();
  });

  it.each([
    ["openai", "https://platform.openai.com/api-keys"],
    ["anthropic", "https://console.anthropic.com/settings/keys"],
    ["gemini", "https://aistudio.google.com/apikey"],
    ["xai", "https://console.x.ai"],
  ] as const)("links %s to where its keys come from, opening in the browser", async (service, href) => {
    render(<Harness api={api()} start="models" />);
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: service } });
    const link = screen.getByRole("link", { name: "Get a key" });
    expect(link.getAttribute("href")).toBe(href);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(screen.queryByText(/^Free tier:/) !== null).toBe(service === "gemini"); // the free-tier line belongs to Gemini alone
  });

  it("asks Another service for its address, and has no key link for it", async () => {
    render(<Harness api={api()} start="models" />);
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "custom" } });
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("link", { name: "Get a key" })).toBeNull();
    expect(screen.queryByText(/^Free tier:/)).toBeNull();
  });

  it("will not save Another service without its address: an empty one would send the engine back to OpenRouter", async () => {
    const heard = listen();
    const a = api();
    render(<Harness api={a} start="models" />);
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Model (required for processing)"), { target: { value: "my-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter the address of the service.");
    expect(a.saveSettings).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "https://models.example.com/v1" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { endpoint: "https://models.example.com/v1", model: "my-model", apiKey: "sk-x" } }));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves OpenRouter as the provider with the model, and the key only when one was pasted", async () => {
    const a = api();
    render(<Harness api={a} start="models" />);
    fireEvent.change(await screen.findByLabelText("Model (required for processing)"), { target: { value: "openai/gpt-6-luna" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenLastCalledWith(info, { models: { provider: "openrouter", model: "openai/gpt-6-luna" } }));
    expect(await screen.findByText("Saved")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-or-pasted" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(a.saveSettings).toHaveBeenLastCalledWith(info, { models: { provider: "openrouter", model: "openai/gpt-6-luna", apiKey: "sk-or-pasted" } }));
  });

  it("follows the engine's reading of what was saved: a loopback address is a model on this computer", async () => {
    render(<Harness api={api()} start="models" />);
    fireEvent.click(await screen.findByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "http://127.0.0.1:11434/v1" } });
    fireEvent.change(screen.getByLabelText("Model (required for processing)"), { target: { value: "llama3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Using a model on this computer:/)).toBeTruthy();
    expect(screen.getByRole("radio", { checked: true }).textContent).toMatch(/^On this computer/);
  });

  it("signs in to OpenRouter in the browser, saves the key it issues and tells the app", async () => {
    const heard = listen();
    let finish: (key: string) => void = () => {};
    openrouter.signIn.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const a = api();
    render(<Harness api={a} start="models" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with OpenRouter" }));
    expect(openrouter.signIn).toHaveBeenCalledWith(info);
    const waiting = await screen.findByRole("button", { name: "Waiting for the browser…" });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Finish signing in on the page that opened in your browser, then come back here.").getAttribute("role")).toBe("status");
    expect(a.saveSettings).not.toHaveBeenCalled();
    finish("sk-or-issued");
    await waitFor(() => expect(a.saveSettings).toHaveBeenCalledWith(info, { models: { provider: "openrouter", apiKey: "sk-or-issued" } }));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    // the form knows a key is saved now, and can sign in again
    expect(await screen.findByRole("button", { name: "Remove key" })).toBeTruthy();
    expect((screen.getByLabelText("API key") as HTMLInputElement).placeholder).toBe("Saved — leave empty to keep it");
    expect((screen.getByRole("button", { name: "Sign in with OpenRouter" }) as HTMLButtonElement).disabled).toBe(false);
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("says why the OpenRouter sign-in failed, saves nothing, and lets the user try again", async () => {
    const heard = listen();
    openrouter.signIn.mockRejectedValue(new Error("OpenRouter did not issue a key (400)."));
    const a = api();
    render(<Harness api={a} start="models" />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with OpenRouter" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not sign in: OpenRouter did not issue a key (400).");
    expect(a.saveSettings).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Sign in with OpenRouter" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps one primary action: signing in until a key is saved or pasted, then saving", async () => {
    render(<Harness api={api()} start="models" />);
    await screen.findByRole("radiogroup", { name: "AI model provider" });
    const primary = () => screen.getAllByRole("button").filter((b) => b.className.includes("kv-button-primary")).map((b) => b.textContent);
    expect(primary()).toEqual(["Sign in with OpenRouter"]);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-or-1" } });
    expect(primary()).toEqual(["Save"]);
    fireEvent.click(screen.getByRole("radio", { name: /API key/ }));
    expect(primary()).toEqual(["Save"]);
    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    expect(primary()).toEqual([]); // the local block brings its own
  });

  it("keeps what is saved with the provider it was saved for: another service is another key", async () => {
    const a = api({ fetchSettings: vi.fn(async () => savedWith("openai", { model: "gpt-6-luna", hasKey: true })) });
    render(<Harness api={a} start="models" />);
    const saved = "Saved — leave empty to keep it";
    expect(((await screen.findByLabelText("API key")) as HTMLInputElement).placeholder).toBe(saved);
    expect(screen.getByRole("button", { name: "Remove key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Validate" })).toBeTruthy();
    await waitFor(() => expect(a.fetchModelCatalog).toHaveBeenCalledWith(info, "https://api.openai.com/v1")); // the models the saved key gives
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "anthropic" } });
    expect((screen.getByLabelText("API key") as HTMLInputElement).placeholder).not.toBe(saved);
    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Validate" })).toBeNull();
    expect(screen.getByText("Enter your API key to see the models it gives you.")).toBeTruthy();
    expect(a.fetchModelCatalog).toHaveBeenCalledTimes(1); // the saved key was not tried against the other service
    fireEvent.click(screen.getByRole("radio", { name: /OpenRouter/ }));
    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /On this computer/ }));
    expect(screen.queryByRole("button", { name: "Validate" })).toBeNull();
    expect(screen.queryByText("Not needed for a model on this computer.")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /API key/ }));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "openai" } });
    expect((screen.getByLabelText("API key") as HTMLInputElement).placeholder).toBe(saved);
    expect(screen.getByRole("button", { name: "Remove key" })).toBeTruthy();
  });
});
