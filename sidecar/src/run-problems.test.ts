import { describe, expect, it } from "vitest";
import { classifyRunError } from "./run-problems.js";

const wrap = (inner: string) => `Step "extract" failed: KnowledgeVaultApiError: Stage "candidates" failed: ${inner} (done before it: read: …)`;

describe("classifyRunError", () => {
  it("names an account out of credit (402), with the model", () => {
    const p = classifyRunError(wrap("The model provider refused to ask openai/gpt-6-luna (402): You requested up to 32000 tokens, but can only afford 11082."));
    expect(p).toEqual({ kind: "no-funds", message: "Your model provider refused the request: the account is out of credit.", model: "openai/gpt-6-luna" });
  });
  it("names a refused key, a rate limit, a missing model, and a refusal", () => {
    expect(classifyRunError(wrap("The model provider refused to ask x/y (401): Invalid API key"))?.kind).toBe("bad-key");
    expect(classifyRunError(wrap("The model provider refused to ask x/y (429): Rate limit exceeded"))?.kind).toBe("rate-limited");
    expect(classifyRunError(wrap("The model provider refused to ask x/y (404): No endpoints found"))?.kind).toBe("model-missing");
    expect(classifyRunError(wrap("The model provider refused to ask google/lyria-3-pro-preview (400): Provider returned error"))).toEqual({ kind: "model-refused", message: "google/lyria-3-pro-preview refused the request (HTTP 400); it may not suit processing.", model: "google/lyria-3-pro-preview" });
  });
  it("names a model too slow to answer", () => {
    const p = classifyRunError(wrap("dots-studio/dots-3-note-preview:free did not answer within 120 s, twice. Run the step again, or choose a faster model."));
    expect(p?.kind).toBe("slow-model");
    expect(p?.message).toContain("did not answer in time");
  });
  it("says nothing about errors it does not understand, or no error", () => {
    expect(classifyRunError("Step \"connect\" failed: something else entirely")).toBeNull();
    expect(classifyRunError(null)).toBeNull();
  });
  it("recognises a run the app's closing cut off", () => {
    expect(classifyRunError("Reactor stopped before the run finished; steps completed before then were journaled")?.kind).toBe("interrupted");
  });
});
