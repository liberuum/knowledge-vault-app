// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announceModelsChanged, MODELS_CHANGED_EVENT, modelDeclaration, modelLabel, openModelSettings } from "./model-declaration.js";
import { useRoute } from "./shell/router.js";

const info = { origin: "http://127.0.0.1:4201", graphqlUrl: "http://127.0.0.1:4201/graphql", controlOrigin: "http://127.0.0.1:4202", controlToken: "ctl" };
const models = (over: Partial<{ endpoint: string; model: string; hasKey: boolean; local: boolean; provider: "local" | "openrouter" | "anthropic" | "custom" }>) => ({ endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna", hasKey: true, local: false, provider: "openrouter" as const, ...over });

describe("modelDeclaration", () => {
  it("points the vault at the gateway with the control token", () => {
    const d = modelDeclaration(info, models({}));
    expect(d).toMatchObject({ baseUrl: "http://127.0.0.1:4202/llm/v1", model: "openai/gpt-6-luna", label: "openai/gpt-6-luna via OpenRouter" });
    expect(d?.headers?.()).toEqual({ authorization: "Bearer ctl" });
  });
  it("a local model needs no key; no model, or a hosted one without a key, is not set up", () => {
    expect(modelDeclaration(info, models({ provider: "local", local: true, hasKey: false, model: "gpt-oss-20b", endpoint: "http://127.0.0.1:8084/v1" }))?.label).toBe("gpt-oss-20b on this computer");
    expect(modelDeclaration(info, models({ model: "" }))).toBeNull();
    expect(modelDeclaration(info, models({ hasKey: false }))).toBeNull();
  });
  it("names each provider plainly", () => {
    expect(modelLabel(models({ provider: "anthropic", model: "claude-sonnet-5" }))).toBe("claude-sonnet-5 via Anthropic");
    expect(modelLabel(models({ provider: "custom", model: "m" }))).toBe("m via your model server");
  });
  it("a model name of only spaces is no model", () => {
    expect(modelDeclaration(info, models({ model: "   " }))).toBeNull();
  });
  it("each engine gets its own gateway address and its own bearer", () => {
    const other = { ...info, controlOrigin: "http://127.0.0.1:5202", controlToken: "other" };
    const here = modelDeclaration(info, models({}));
    const there = modelDeclaration(other, models({}));
    expect(here?.baseUrl).toBe("http://127.0.0.1:4202/llm/v1");
    expect(there?.baseUrl).toBe("http://127.0.0.1:5202/llm/v1");
    expect(here?.headers?.()).toEqual({ authorization: "Bearer ctl" });
    expect(there?.headers?.()).toEqual({ authorization: "Bearer other" });
  });
});

describe("announceModelsChanged", () => {
  it("tells whoever listens on the window, once per call", () => {
    const heard = vi.fn();
    globalThis.addEventListener(MODELS_CHANGED_EVENT, heard);
    announceModelsChanged();
    expect(heard).toHaveBeenCalledTimes(1);
    announceModelsChanged();
    expect(heard).toHaveBeenCalledTimes(2);
    globalThis.removeEventListener(MODELS_CHANGED_EVENT, heard);
  });
});

describe("openModelSettings", () => {
  afterEach(() => {
    window.location.hash = "";
  });
  it("opens Settings › Models by the hash alone, and the router follows it with no React state in between", async () => {
    window.location.hash = "#/vault/abc";
    const { result } = renderHook(() => useRoute());
    expect(result.current[0]).toEqual({ name: "vault", id: "abc" });
    openModelSettings();
    expect(window.location.hash).toBe("#/settings/models");
    await waitFor(() => expect(result.current[0]).toEqual({ name: "settings", section: "models" }));
  });
  it("is harmless when Settings › Models is already open", () => {
    window.location.hash = "#/settings/models";
    openModelSettings();
    expect(window.location.hash).toBe("#/settings/models");
  });
});
