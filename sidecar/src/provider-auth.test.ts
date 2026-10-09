import { describe, expect, it } from "vitest";
import { chatModelId, modelsUrl, providerHeaders, refusesKey } from "./provider-auth.js";

describe("provider auth", () => {
  it("sends Anthropic its own headers and every other provider a bearer, and nothing without a key", () => {
    expect(providerHeaders("https://api.anthropic.com/v1", "k")).toEqual({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
    expect(providerHeaders("https://api.openai.com/v1", "k")).toEqual({ authorization: "Bearer k" });
    expect(providerHeaders("https://generativelanguage.googleapis.com/v1beta/openai", "k")).toEqual({ authorization: "Bearer k" });
    expect(providerHeaders("https://api.anthropic.com/v1", undefined)).toEqual({});
  });
  it("asks for Anthropic's whole model list and takes Gemini's model ids as its chat does", () => {
    expect(modelsUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(modelsUrl("https://api.x.ai/v1")).toBe("https://api.x.ai/v1/models");
    expect(chatModelId("https://generativelanguage.googleapis.com/v1beta/openai", "models/gemini-2.5-flash")).toBe("gemini-2.5-flash");
    expect(chatModelId("https://openrouter.ai/api/v1", "models/x")).toBe("models/x");
  });
  it("counts a refused key however the provider says it: 401, 403, or a 400 about the key", () => {
    expect(refusesKey(401, "Incorrect API key provided")).toBe(true);
    expect(refusesKey(400, "Please pass a valid API key")).toBe(true); // Google
    expect(refusesKey(400, "Incorrect API key provided. You can obtain an API key from https://console.x.ai.")).toBe(true); // xAI
    expect(refusesKey(400, "anthropic-version: header is required")).toBe(false);
    expect(refusesKey(400, "model not found")).toBe(false);
  });
});
