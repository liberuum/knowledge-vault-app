import { describe, expect, it } from "vitest";
import { filterModels, fitForProcessing, formatContext, formatPrice, freeModels, offerableModels, recommendedModels, type CatalogModel } from "./model-picker.js";

const m = (id: string, over: Partial<CatalogModel> = {}): CatalogModel => ({ id, name: id, free: false, ...over });
const rich = (id: string, over: Partial<CatalogModel> = {}) => m(id, { contextLength: 200_000, promptPrice: 2, completionPrice: 10, jsonOutput: true, textOutput: true, outputs: ["text"], maxOutput: 64_000, quality: 30, ...over });

describe("the model picker's logic", () => {
  it("searches by every word of the query, in the id or the name, ignoring case", () => {
    const models = [m("openai/gpt-6-luna", { name: "OpenAI: GPT-6 Luna" }), m("anthropic/claude-sonnet-5", { name: "Anthropic: Claude Sonnet 5" }), m("google/gemini-3-flash")];
    expect(filterModels(models, "gpt luna").map((x) => x.id)).toEqual(["openai/gpt-6-luna"]);
    expect(filterModels(models, "ANTHROPIC").map((x) => x.id)).toEqual(["anthropic/claude-sonnet-5"]);
    expect(filterModels(models, "")).toHaveLength(3);
    expect(filterModels(models, "nope")).toEqual([]);
  });

  it("recommends models that can do the pipeline's job — JSON output, text, 64k+ context, a 16k reply — best first, cheaper among equals", () => {
    const models = [
      rich("good/pricey", { quality: 40, promptPrice: 15 }),
      rich("good/cheap", { quality: 40, promptPrice: 0.5 }),
      rich("ok/one", { quality: 25, promptPrice: 0.1 }),
      rich("small/context", { quality: 50, contextLength: 32_000 }),
      rich("short/reply", { quality: 50, maxOutput: 4_000 }),
      rich("no/json", { quality: 50, jsonOutput: false }),
      rich("image/only", { quality: 50, textOutput: false, outputs: ["image"] }),
      rich("music/one", { quality: 50, outputs: ["text", "audio"] }),
      rich("free/one:free", { quality: 50, free: true, promptPrice: 0 }),
      rich("router/varies", { quality: 50, promptPrice: undefined }),
      rich("unscored/one", { quality: undefined, promptPrice: 0.01 }),
      rich("good/cheap:batch", { quality: 40, promptPrice: 0.25 }),
    ];
    expect(recommendedModels(models).map((x) => x.id)).toEqual(["good/cheap", "good/pricey", "ok/one"]);
    expect(recommendedModels(models, 2).map((x) => x.id)).toEqual(["good/cheap", "good/pricey"]);
  });

  it("recommends nothing from a bare list that describes no model", () => {
    expect(recommendedModels([m("gpt-4.1"), m("llama3")])).toEqual([]);
  });

  it("formats prices and context for a glance, and stays quiet when the provider said nothing", () => {
    expect(formatPrice(rich("a"))).toBe("$2 / $10 per M tokens");
    expect(formatPrice(rich("b", { promptPrice: 0.15, completionPrice: 0.6 }))).toBe("$0.15 / $0.6 per M tokens");
    expect(formatPrice(m("c", { free: true }))).toBe("free");
    expect(formatPrice(m("d"))).toBeNull();
    expect(formatContext(rich("e", { contextLength: 1_050_000 }))).toBe("1.05M context");
    expect(formatContext(rich("f", { contextLength: 128_000 }))).toBe("128k context");
    expect(formatContext(m("g"))).toBeNull();
  });

  it("says whether the pipeline can use a model, and why not — a music model that also lists text is not a text model", () => {
    expect(fitForProcessing(rich("good"))).toEqual({ ok: true });
    expect(fitForProcessing(rich("google/lyria-3-pro-preview", { outputs: ["text", "audio"] }))).toEqual({ ok: false, reason: "makes audio, not a text model" });
    expect(fitForProcessing(rich("x", { jsonOutput: false }))).toEqual({ ok: false, reason: "no JSON output" });
    expect(fitForProcessing(rich("x", { inputs: ["audio"] }))).toEqual({ ok: false, reason: "does not take text input" });
    expect(fitForProcessing(rich("x", { inputs: ["text", "image"] }))).toEqual({ ok: true });
    expect(fitForProcessing(rich("x", { contextLength: 32_000 }))).toEqual({ ok: false, reason: "context too small for a whole source" });
    expect(fitForProcessing(rich("x", { maxOutput: 4_000 }))).toEqual({ ok: false, reason: "replies too short for an extraction" });
    expect(fitForProcessing(m("llama3"))).toEqual({ ok: null });
  });

  it("lists free models with the usable ones first", () => {
    const models = [rich("free/music:free", { free: true, outputs: ["text", "audio"] }), rich("free/text:free", { free: true })];
    expect(freeModels(models).map((x) => x.id)).toEqual(["free/text:free", "free/music:free"]);
  });

  it("offers only the models that can (or might) do the vault's work, and the chosen one whatever it is", () => {
    const models = [rich("good"), rich("music", { outputs: ["text", "audio"] }), rich("nojson", { jsonOutput: false }), m("llama3"), rich("chosen-bad", { jsonOutput: false })];
    expect(offerableModels(models, "chosen-bad").map((x) => x.id)).toEqual(["good", "llama3", "chosen-bad"]);
    expect(offerableModels(models, "").map((x) => x.id)).toEqual(["good", "llama3"]);
  });

  it("hides what a service lists beside its chat models when it says nothing about them", () => {
    const bare = (id: string): CatalogModel => ({ id, name: id, free: false });
    const listed = ["gpt-6-luna", "text-embedding-3-large", "tts-1", "whisper-1", "gpt-image-1", "omni-moderation-latest", "gpt-4o-realtime-preview", "claude-sonnet-5", "gemini-embedding-001", "aqa", "grok-4"].map(bare);
    expect(offerableModels(listed, "").map((m) => m.id)).toEqual(["gpt-6-luna", "claude-sonnet-5", "grok-4"]);
  });
});

describe("named reasons and the default model", () => {
  it("says why a model nothing describes cannot do the work, and leaves the rest unchecked", async () => {
    const { fitForProcessing } = await import("./model-picker.js");
    const bare = (id: string) => ({ id, name: id, free: false });
    expect(fitForProcessing(bare("antigravity-preview-09-2026"))).toEqual({ ok: false, reason: "an agent model, not for chat or processing" });
    expect(fitForProcessing(bare("gemini-3.8-flash-tts"))).toEqual({ ok: false, reason: "speech or live audio, not a text model" });
    expect(fitForProcessing(bare("gemini-pro-latest"))).toEqual({ ok: null });
  });

  it("chooses the best value among the recommended, else the best-rated fit, never an unchecked one", async () => {
    const { defaultModel } = await import("./model-picker.js");
    const fit = { free: false, jsonOutput: true, textOutput: true, outputs: ["text"], contextLength: 200_000, maxOutput: 32_000 };
    const dear = { ...fit, id: "dear", name: "dear", quality: 70, promptPrice: 10, completionPrice: 50 };
    const cheap = { ...fit, id: "cheap", name: "cheap", quality: 60, promptPrice: 0.3, completionPrice: 2.5 };
    expect(defaultModel([dear, cheap])?.id).toBe("cheap");
    const weak = { ...fit, id: "weak", name: "weak", quality: 20, promptPrice: 0.05, completionPrice: 0.2 };
    expect(defaultModel([dear, weak])?.id).toBe("dear");
    expect(defaultModel([{ ...fit, id: "unpriced", name: "unpriced", quality: 50 }])?.id).toBe("unpriced");
    expect(defaultModel([{ id: "mystery", name: "mystery", free: false }])).toBeUndefined();
  });
});
