import { describe, expect, it } from "vitest";
import { onboardingStart, railState } from "./onboarding-state.js";
import type { ModelSettings } from "../vaults.js";

const none: ModelSettings = { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, provider: "openrouter" };
const local: ModelSettings = { endpoint: "http://127.0.0.1:8084/v1", model: "gpt-oss-20b", hasKey: false, local: true, provider: "local" };
const start = (over: Partial<Parameters<typeof onboardingStart>[0]>) => onboardingStart({ models: none, vaults: [], remoteVaults: 0, progress: null, ...over });

describe("onboardingStart", () => {
  it("opens the guide on a new install, and at the first vault once a model is set", () => {
    expect(start({})).toEqual({ open: "welcome" });
    expect(start({ models: local })).toEqual({ open: "vault" });
    expect(start({ models: { ...none, model: "openai/gpt-6-luna" } })).toEqual({ open: "welcome" }); // no key yet
  });
  it("resumes where the guide was, in its own vault", () => {
    expect(start({ models: local, vaults: [{ id: "v1" }], progress: { vault: "v1", step: "notes" } })).toEqual({ open: "notes", vault: "v1" });
  });
  it("never opens for an install that had vaults before the guide, and records that", () => {
    expect(start({ vaults: [{ id: "old" }] })).toEqual({ record: "done" });
    expect(start({ vaults: [{ id: "old" }], progress: { vault: "deleted", step: "sources" } })).toEqual({ record: "done" });
    expect(start({ remoteVaults: 1 })).toEqual({ record: "done" });
  });
  it("stays closed once finished or skipped", () => {
    expect(start({ onboarding: "skipped" })).toBeNull();
    expect(start({ onboarding: "done", vaults: [{ id: "v1" }], progress: { vault: "v1", step: "notes" } })).toBeNull();
  });
  it("lights the rail up to the current step", () => {
    expect((["ai", "vault", "sources", "notes"] as const).map((s) => railState("notes", s))).toEqual(["done", "done", "done", "current"]);
    expect(railState("welcome", "ai")).toBe("todo");
  });
});
