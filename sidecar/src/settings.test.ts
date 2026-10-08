import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeChatGpt } from "./chatgpt/store.js";
import { readLocalProtection, readModelKey, readSettings, setComponentRemoved, SettingsError, writeLocalProtection, writeSettings } from "./settings.js";

const dir = () => mkdtempSync(join(tmpdir(), "kv-settings-"));

describe("settings", () => {
  it("starts from defaults and never reports a key it does not have", () => {
    expect(readSettings(dir())).toEqual({
      version: 1,
      models: { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, local: false, provider: "openrouter" },
      conversion: { mode: "local", remoteUrl: "", removed: [] },
      ui: { closeToTray: true },
    });
  });
  it("keeps the window-close preference in config.json's ui section, beside other ui keys", () => {
    const d = dir();
    writeFileSync(join(d, "config.json"), JSON.stringify({ version: 1, ui: { lastVault: "v1" } }));
    expect(writeSettings(d, { ui: { closeToTray: false } }).ui).toEqual({ closeToTray: false });
    expect(JSON.parse(readFileSync(join(d, "config.json"), "utf8")).ui).toEqual({ lastVault: "v1", closeToTray: false });
    expect(readSettings(d).ui.closeToTray).toBe(false);
  });
  it("persists endpoint and model in config.json, the key in secrets/ with mode 0600, and reports only hasKey", () => {
    const d = dir();
    const out = writeSettings(d, { models: { endpoint: "http://127.0.0.1:11434/v1", model: "llama3", apiKey: "sk-secret" } });
    expect(out.models).toEqual({ endpoint: "http://127.0.0.1:11434/v1", model: "llama3", hasKey: true, local: true, provider: "local" });
    expect(JSON.stringify(readFileSync(join(d, "config.json"), "utf8"))).not.toContain("sk-secret");
    if (process.platform !== "win32") expect(statSync(join(d, "secrets", "llm.key")).mode & 0o777).toBe(0o600);
    expect(readModelKey(d)).toBe("sk-secret");
    expect(readSettings(d).models.hasKey).toBe(true);
  });
  it("keeps the key when the patch omits it and clears it on an empty string", () => {
    const d = dir();
    writeSettings(d, { models: { apiKey: "k1" } });
    writeSettings(d, { models: { model: "gpt" } });
    expect(readModelKey(d)).toBe("k1");
    writeSettings(d, { models: { apiKey: "" } });
    expect(readModelKey(d)).toBeUndefined();
    expect(existsSync(join(d, "secrets", "llm.key"))).toBe(false);
  });
  it("refuses a provider that is not one of the fixed services, including inherited object keys", () => {
    expect(() => writeSettings(dir(), { models: { provider: "constructor" as never } })).toThrow(SettingsError);
    expect(() => writeSettings(dir(), { models: { provider: "__proto__" as never } })).toThrow(SettingsError);
    expect(() => writeSettings(dir(), { models: { provider: "toString" as never } })).toThrow(SettingsError);
    expect(() => writeSettings(dir(), { models: { provider: "nope" as never } })).toThrow(SettingsError);
  });
  it("rejects a model endpoint that is not an http(s) URL — a key will be sent there", () => {
    expect(() => writeSettings(dir(), { models: { endpoint: "ftp://x" } })).toThrow(SettingsError);
    expect(() => writeSettings(dir(), { models: { endpoint: "openrouter.ai/api/v1" } })).toThrow(SettingsError);
  });
  it("persists the conversion mode and server, trimming a trailing slash", () => {
    const d = dir();
    const out = writeSettings(d, { conversion: { mode: "remote", remoteUrl: "http://127.0.0.1:5011/" } });
    expect(out.conversion).toEqual({ mode: "remote", remoteUrl: "http://127.0.0.1:5011", removed: [] });
    expect(writeSettings(d, { conversion: { mode: "off" } }).conversion).toEqual({ mode: "off", remoteUrl: "http://127.0.0.1:5011", removed: [] });
    expect(readSettings(d).conversion.mode).toBe("off");
  });
  it("refuses another server without a URL, a URL that is not http(s), and an unknown mode", () => {
    expect(() => writeSettings(dir(), { conversion: { mode: "remote" } })).toThrow(SettingsError);
    expect(() => writeSettings(dir(), { conversion: { mode: "remote", remoteUrl: "ftp://x" } })).toThrow(SettingsError);
    expect(() => writeSettings(dir(), { conversion: { mode: "docker" as never } })).toThrow(SettingsError);
  });
  it("preserves keys in config.json it does not own", () => {
    const d = dir();
    writeFileSync(join(d, "config.json"), JSON.stringify({ version: 1, ui: { theme: "dark" }, vaults: [] }));
    writeSettings(d, { models: { model: "x" } });
    const raw = JSON.parse(readFileSync(join(d, "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw.ui).toEqual({ theme: "dark" });
    expect(raw.vaults).toEqual([]);
  });
});

describe("local protection (spec §4.4: one switch for the local engine)", () => {
  it("is open by default, with no administrator", () => {
    expect(readLocalProtection(dir())).toEqual({ protected: false, adminAddress: null });
  });
  it("round-trips through config.json in camelCase and keeps the other sections", () => {
    const d = dir();
    writeSettings(d, { models: { model: "llama3" } });
    const out = writeLocalProtection(d, { protected: true, adminAddress: "0xabc" });
    expect(out).toEqual({ protected: true, adminAddress: "0xabc" });
    expect(readLocalProtection(d)).toEqual({ protected: true, adminAddress: "0xabc" });
    const text = readFileSync(join(d, "config.json"), "utf8");
    expect(text).toContain('"adminAddress"');
    expect(readSettings(d).models.model).toBe("llama3");
    // Switching back keeps the administrator on record.
    expect(writeLocalProtection(d, { protected: false, adminAddress: "0xabc" })).toEqual({ protected: false, adminAddress: "0xabc" });
  });
  it("refuses protection without an administrator", () => {
    expect(() => writeLocalProtection(dir(), { protected: true, adminAddress: null })).toThrow(SettingsError);
  });
});

describe("model endpoint normalisation (Review Focus #1: a pasted chat-completions URL)", () => {
  it("strips the completions/models path and trailing slashes, keeps a root endpoint as given", () => {
    const d = dir();
    expect(writeSettings(d, { models: { endpoint: "https://openrouter.ai/api/v1/chat/completions" } }).models.endpoint).toBe("https://openrouter.ai/api/v1");
    expect(writeSettings(d, { models: { endpoint: "http://localhost:11434/v1/" } }).models.endpoint).toBe("http://localhost:11434/v1");
    expect(writeSettings(d, { models: { endpoint: "https://api.example.com/v1/models?x=1#y" } }).models.endpoint).toBe("https://api.example.com/v1");
    expect(writeSettings(d, { models: { endpoint: "http://127.0.0.1:8080" } }).models.endpoint).toBe("http://127.0.0.1:8080");
  });
});

describe("removed converter components", () => {
  it("remembers a removal, forgets it on install, and keeps the rest of the conversion section", () => {
    const d = dir();
    writeSettings(d, { conversion: { mode: "remote", remoteUrl: "https://convert.example" } });
    setComponentRemoved(d, "models", true);
    setComponentRemoved(d, "models", true);
    expect(readSettings(d).conversion).toEqual({ mode: "remote", remoteUrl: "https://convert.example", removed: ["models"] });
    setComponentRemoved(d, "binding", true);
    setComponentRemoved(d, "models", false);
    expect(readSettings(d).conversion.removed).toEqual(["binding"]);
  });
  it("ignores anything but the two components", () => {
    const d = dir();
    writeFileSync(join(d, "config.json"), JSON.stringify({ version: 1, conversion: { mode: "local", removed: ["models", "docker", 3] } }));
    expect(readSettings(d).conversion.removed).toEqual(["models"]);
  });
});

describe("the model's provider", () => {
  it("is named from the endpoint", () => {
    const d = dir();
    expect(writeSettings(d, { models: { endpoint: "https://api.anthropic.com/v1/" } }).models.provider).toBe("anthropic");
    expect(writeSettings(d, { models: { endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/" } }).models.provider).toBe("gemini");
    expect(writeSettings(d, { models: { endpoint: "http://127.0.0.1:8084/v1" } }).models.provider).toBe("local");
    expect(writeSettings(d, { models: { endpoint: "https://llm.example.com/v1" } }).models.provider).toBe("custom");
  });
  it("a chosen provider without an endpoint takes the provider's address", () => {
    expect(writeSettings(dir(), { models: { provider: "xai" } }).models.endpoint).toBe("https://api.x.ai/v1");
  });
  it("an endpoint given with the provider wins", () => {
    expect(writeSettings(dir(), { models: { provider: "openai", endpoint: "https://proxy.example.com/v1" } }).models).toMatchObject({ endpoint: "https://proxy.example.com/v1", provider: "custom" });
  });
  it("the ChatGPT plan is marked, not inferred from OpenAI's address; its key is a sign-in allowed to use the plan", () => {
    const d = dir();
    expect(writeSettings(d, { models: { provider: "chatgpt", model: "gpt-6.1-sol" } }).models).toEqual({ endpoint: "https://api.openai.com/v1", model: "gpt-6.1-sol", hasKey: false, local: false, provider: "chatgpt" });
    expect(JSON.parse(readFileSync(join(d, "config.json"), "utf8")).models).toEqual({ endpoint: "https://api.openai.com/v1", model: "gpt-6.1-sol", provider: "chatgpt" });
    const tokens = { accessToken: "at", refreshToken: "rt", idToken: "id", tokenType: "Bearer", expiresAt: "2026-10-09T01:00:00.000Z", savedAt: "2026-10-09T00:00:00.000Z" };
    writeChatGpt(d, { version: 1, hostId: "urn:uuid:x", registrations: [], active: "c", tokens: { ...tokens, scopes: ["openid", "offline_access"] } });
    expect(readSettings(d).models.hasKey).toBe(false); // signed in, but not allowed to use the plan
    writeChatGpt(d, { version: 1, hostId: "urn:uuid:x", registrations: [], active: "c", tokens: { ...tokens, scopes: ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] } });
    expect(readSettings(d).models.hasKey).toBe(true);
    // A model or an API key saved alongside keeps the mark; another provider or an address drops it.
    expect(writeSettings(d, { models: { model: "gpt-6-mini", apiKey: "sk-openai" } }).models).toMatchObject({ provider: "chatgpt", hasKey: true });
    expect(writeSettings(d, { models: { provider: "openai" } }).models).toMatchObject({ endpoint: "https://api.openai.com/v1", provider: "openai", hasKey: true });
    writeSettings(d, { models: { provider: "chatgpt" } });
    expect(writeSettings(d, { models: { endpoint: "https://api.openai.com/v1" } }).models.provider).toBe("openai");
  });
});
