import { describe, expect, it } from "vitest";
import { describeFromKnowledge, modelKey } from "./model-knowledge.js";

const bare = (id: string) => ({ id, name: id, free: false });

describe("model knowledge", () => {
  it("spells a model one way however its provider names it", () => {
    expect(modelKey("anthropic/claude-sonnet-4.5")).toBe(modelKey("claude-sonnet-4-5-20250929"));
    expect(modelKey("google/gemini-2.5-flash")).toBe(modelKey("models/gemini-2.5-flash"));
    expect(modelKey("openai/gpt-4.1:batch")).toBe(modelKey("gpt-4.1"));
  });

  it("fills in what a provider's own list leaves out, and nothing it cannot match", () => {
    const [flash, robot] = describeFromKnowledge("https://generativelanguage.googleapis.com/v1beta/openai", [bare("gemini-2.5-flash"), bare("gemini-robotics-er-2-preview")]);
    expect(flash).toMatchObject({ id: "gemini-2.5-flash", jsonOutput: true, describedBy: "catalog" });
    expect(flash?.contextLength).toBeGreaterThan(64_000);
    expect(robot).toEqual(bare("gemini-robotics-er-2-preview"));
    // OpenRouter and other services describe their own models: left as they are.
    expect(describeFromKnowledge("https://openrouter.ai/api/v1", [bare("gemini-2.5-flash")])[0]).toEqual(bare("gemini-2.5-flash"));
  });
});
