import { describe, expect, it, vi } from "vitest";
import { fetchModelCatalog, normaliseCatalog } from "./models-validate.js";

const f = (status: number, body: unknown) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;

describe("the model catalog", () => {
  it("normalises OpenRouter's rich list: name, context, prices per million, free, JSON and text support", () => {
    const [m] = normaliseCatalog([
      {
        id: "openai/gpt-6.1-sol-pro",
        name: "OpenAI: GPT-6.1 Sol Pro",
        context_length: 1_050_000,
        pricing: { prompt: "0.000002", completion: "0.00001" },
        supported_parameters: ["max_tokens", "response_format", "structured_outputs"],
        architecture: { output_modalities: ["text"] },
        top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 },
        benchmarks: { artificial_analysis: { intelligence_index: 38.1 } },
      },
    ]);
    expect(m).toEqual({ id: "openai/gpt-6.1-sol-pro", name: "OpenAI: GPT-6.1 Sol Pro", contextLength: 1_050_000, promptPrice: 2, completionPrice: 10, free: false, jsonOutput: true, textOutput: true, outputs: ["text"], maxOutput: 128_000, quality: 38.1 });
  });

  it("marks free models, image-only models and models without JSON output", () => {
    const models = normaliseCatalog([
      { id: "x/y:free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["max_tokens"], architecture: { output_modalities: ["text"] } },
      { id: "img/gen", pricing: { prompt: "0.00001", completion: "0.00002" }, supported_parameters: ["response_format"], architecture: { output_modalities: ["image"] } },
    ]);
    expect(models[0]).toMatchObject({ free: true, jsonOutput: false, textOutput: true, name: "x/y:free" });
    expect(models[1]).toMatchObject({ free: false, jsonOutput: true, textOutput: false, outputs: ["image"] });
  });

  it("keeps every output of a model that makes more than text (a music model also says 'text')", () => {
    const [m] = normaliseCatalog([{ id: "google/lyria-3-pro-preview", supported_parameters: ["response_format"], architecture: { output_modalities: ["text", "audio"] } }]);
    expect(m).toMatchObject({ jsonOutput: true, textOutput: true, outputs: ["text", "audio"] });
  });

  it("treats a negative price (OpenRouter's routers: 'varies') as unknown, not free", () => {
    const [m] = normaliseCatalog([{ id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } }]);
    expect(m).toMatchObject({ free: false, promptPrice: undefined, completionPrice: undefined });
  });

  it("keeps a bare list (OpenAI, Ollama) usable: ids only, nothing claimed about the rest", () => {
    const models = normaliseCatalog([{ id: "gpt-4.1", object: "model", owned_by: "openai" }, { id: "llama3:latest" }, { nope: 1 }, null]);
    expect(models).toEqual([
      { id: "gpt-4.1", name: "gpt-4.1", free: false, contextLength: undefined, promptPrice: undefined, completionPrice: undefined, jsonOutput: undefined, textOutput: undefined, outputs: undefined, maxOutput: undefined, quality: undefined },
      { id: "llama3:latest", name: "llama3:latest", free: false, contextLength: undefined, promptPrice: undefined, completionPrice: undefined, jsonOutput: undefined, textOutput: undefined, outputs: undefined, maxOutput: undefined, quality: undefined },
    ]);
  });

  it("asks the provider with the key and relays a refusal", async () => {
    const ok = f(200, { data: [{ id: "a" }] });
    expect(await fetchModelCatalog("https://openrouter.ai/api/v1/", "sk-x", ok)).toEqual({ ok: true, models: [expect.objectContaining({ id: "a" })] });
    const [url, init] = (ok as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-x");
    expect(await fetchModelCatalog("https://openrouter.ai/api/v1", "bad", f(401, { error: { message: "Invalid API key" } }))).toEqual({ ok: false, detail: "The provider refused the key: Invalid API key" });
  });
});
