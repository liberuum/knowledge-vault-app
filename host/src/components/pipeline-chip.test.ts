import { describe, expect, it } from "vitest";
import { describePipeline } from "./pipeline-chip.js";

const ready = (over: Record<string, unknown> = {}) => ({ state: "ready" as const, workflowId: "wf", connectionId: "c", trigger: { status: "ENABLED", lastPollAt: null, lastError: null }, ...over });

describe("describePipeline — the user's word is processing", () => {
  it("names each state in the user's vocabulary with the one action that fixes it", () => {
    expect(describePipeline({ state: "unconfigured" })).toEqual({ label: "Processing off", tone: "action", action: "models", actionLabel: "Set up a model" });
    expect(describePipeline({ state: "missing" })).toEqual({ label: "Processing not set up", tone: "action", action: "setup", actionLabel: "Set up" });
    expect(describePipeline({ state: "stale", reason: "the model settings changed", workflowId: "wf", connectionId: "c" })).toEqual({ label: "Processing needs an update", tone: "action", action: "setup", actionLabel: "Update" });
    expect(describePipeline(ready())).toEqual({ label: "Processing ready", tone: "ok" });
    expect(describePipeline(ready({ lastRun: { id: "r", status: "RUNNING", startedAt: null, endedAt: null, error: null } }))).toEqual({ label: "Processing…", tone: "busy" });
    expect(describePipeline(ready({ lastRun: { id: "r", status: "SUCCEEDED", startedAt: null, endedAt: null, error: null } }))).toEqual({ label: "Processing up to date", tone: "ok" });
    expect(describePipeline(ready({ lastRun: { id: "r", status: "FAILED", startedAt: null, endedAt: null, error: "no model" } }))).toEqual({ label: "Last processing run failed", tone: "warn", action: "runs", actionLabel: "See runs" });
    expect(describePipeline(ready({ trigger: { status: "DISABLED", lastPollAt: null, lastError: null } }))).toEqual({ label: "Processing paused", tone: "quiet", action: "runs", actionLabel: "See runs" });
    expect(describePipeline(ready({ trigger: { status: "ENABLED", lastPollAt: null, lastError: "poll failed" } }))).toEqual({ label: "Processing: trigger error", tone: "warn", action: "runs", actionLabel: "See runs" });
  });

  it("names what a failed run's error means, in plain words", () => {
    const failed = (problem?: { kind: "no-funds" | "bad-key" | "slow-model" | "rate-limited" | "model-refused" | "model-missing"; message: string }) =>
      ({ state: "ready", workflowId: "wf", connectionId: "c", trigger: { status: "ENABLED", lastPollAt: null, lastError: null }, lastRun: { id: "r", status: "FAILED", startedAt: null, endedAt: null, error: "x", problem } }) as const;
    expect(describePipeline(failed({ kind: "no-funds", message: "out of credit" }))).toEqual({ label: "Processing stopped: your model provider account is out of credit", tone: "warn", action: "runs", actionLabel: "See runs" });
    expect(describePipeline(failed({ kind: "bad-key", message: "refused" })).label).toBe("Processing stopped: your model provider refused the API key");
    expect(describePipeline(failed({ kind: "slow-model", message: "slow" })).label).toBe("Processing stopped: the model did not answer in time");
    expect(describePipeline(failed({ kind: "rate-limited", message: "429" })).action).toBe("runs");
    expect(describePipeline(failed())).toEqual({ label: "Last processing run failed", tone: "warn", action: "runs", actionLabel: "See runs" });
    expect(describePipeline(failed({ kind: "interrupted", message: "closed" } as never))).toMatchObject({ label: "Processing was interrupted when the app closed — it resumes on its own", tone: "quiet" });
  });
});
