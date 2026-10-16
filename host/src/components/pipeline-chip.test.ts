import { describe, expect, it } from "vitest";
import type { PipelineFailure, PipelineStatus, RunProblem } from "../vaults.js";
import { describePipeline, isModelSetupProblem } from "./pipeline-chip.js";

const trigger = { status: "ENABLED", lastPollAt: null, lastError: null };
const ready = (over: Record<string, unknown> = {}) => ({ state: "ready", workflowId: "wf", connectionId: "c", trigger, running: 0, waiting: 0, failures: [], hasRuns: false, ...over }) as PipelineStatus;
const failure = (over: Partial<PipelineFailure> = {}): PipelineFailure => ({ runId: "r1", source: "Foreword", at: "2026-10-15T19:36:00.000Z", error: "boom", ...over });
const problem = (kind: RunProblem["kind"], message = "why"): RunProblem => ({ kind, message });
const seeRuns = { action: "runs", actionLabel: "See runs" } as const;

describe("describePipeline — the user's word is processing", () => {
  it("names each state before the work in the user's vocabulary with the one action that fixes it", () => {
    expect(describePipeline({ state: "unconfigured" })).toEqual({ label: "Processing off", tone: "action", action: "models", actionLabel: "Set up a model" });
    expect(describePipeline({ state: "missing" })).toEqual({ label: "Processing not set up", tone: "action", action: "setup", actionLabel: "Set up" });
    expect(describePipeline({ state: "starting" })).toEqual({ label: "Processing starts in a moment", tone: "quiet" });
    // A park also writes the trigger's lastError; the park is what the person needs to know.
    expect(describePipeline(ready({ trigger: { status: "PARKED", lastPollAt: null, lastError: "Workflow parked after run r1" } }))).toEqual({ label: "Processing paused after a failed run", tone: "warn", ...seeRuns });
    expect(describePipeline({ state: "stale", reason: "the model settings changed", workflowId: "wf", connectionId: "c" })).toEqual({ label: "Processing needs an update", tone: "action", action: "setup", actionLabel: "Update" });
    expect(describePipeline(ready({ trigger: { status: "DISABLED", lastPollAt: null, lastError: null } }))).toEqual({ label: "Processing paused", tone: "quiet", ...seeRuns });
    expect(describePipeline(ready({ trigger: { status: "ENABLED", lastPollAt: null, lastError: "poll failed" } }))).toEqual({ label: "Processing: trigger error", tone: "warn", ...seeRuns });
  });

  it("reads the work: running (queued runs too), waiting, then finished", () => {
    expect(describePipeline(ready())).toEqual({ label: "Processing ready", tone: "ok" });
    expect(describePipeline(ready({ hasRuns: true }))).toEqual({ label: "Processing up to date", tone: "ok" });
    expect(describePipeline(ready({ running: 3, waiting: 869, hasRuns: true }))).toEqual({ label: "Processing… 869 sources to go", tone: "busy" });
    expect(describePipeline(ready({ running: 1, waiting: 1 }))).toEqual({ label: "Processing… 1 source to go", tone: "busy" });
    // The count is unknown (the queue could not be read) or already 0: just "Processing…".
    expect(describePipeline(ready({ running: 1, waiting: null }))).toEqual({ label: "Processing…", tone: "busy" });
    expect(describePipeline(ready({ running: 1, waiting: 0 }))).toEqual({ label: "Processing…", tone: "busy" });
    expect(describePipeline(ready({ waiting: 869, hasRuns: true }))).toEqual({ label: "Processing: 869 sources waiting", tone: "quiet" });
    expect(describePipeline(ready({ waiting: 1 }))).toEqual({ label: "Processing: 1 source waiting", tone: "quiet" });
    expect(describePipeline(ready({ waiting: null, hasRuns: true }))).toEqual({ label: "Processing up to date", tone: "ok" });
  });

  it("an answer without the work — what setting the pipeline up returns — reads ready", () => {
    expect(describePipeline({ state: "ready", workflowId: "wf", connectionId: "c" })).toEqual({ label: "Processing ready", tone: "ok" });
  });

  it("names a model-setup failure first, in plain words, even while other runs go on", () => {
    const labels: Record<"no-funds" | "bad-key" | "rate-limited" | "slow-model" | "model-missing" | "model-refused", string> = {
      "no-funds": "Processing stopped: your model provider account is out of credit",
      "bad-key": "Processing stopped: your model provider refused the API key",
      "rate-limited": "Processing stopped: your model provider is rate-limiting requests",
      "slow-model": "Processing stopped: the model did not answer in time",
      "model-missing": "Processing stopped: the model is not available at your provider",
      "model-refused": "Processing stopped: the model refused the request",
    };
    for (const [kind, label] of Object.entries(labels)) {
      const status = ready({ running: 2, waiting: 10, failures: [failure({ problem: problem(kind as keyof typeof labels, "The provider said no.") })] });
      expect(describePipeline(status)).toEqual({ label, tone: "warn", ...seeRuns, tooltip: "“Foreword”: The provider said no." });
      expect(isModelSetupProblem(kind as keyof typeof labels)).toBe(true);
    }
    expect(isModelSetupProblem("interrupted")).toBe(false);
    expect(isModelSetupProblem("deadline")).toBe(false);
  });

  it("counts other failures beside the work in progress, and offers the runs only then", () => {
    expect(describePipeline(ready({ running: 1, waiting: 869, failures: [failure(), failure({ runId: "r0", source: "Old notes" })] }))).toEqual({ label: "Processing… 869 sources to go · 2 failed", tone: "busy", ...seeRuns, tooltip: "“Foreword”: boom" });
    expect(describePipeline(ready({ running: 1, waiting: null, failures: [failure()] })).label).toBe("Processing… · 1 failed");
  });

  it("an interrupted run resumes on its own; other failures count until their source stops waiting", () => {
    const closed = "The app was closed while this source was being processed; it is processed again on its own.";
    expect(describePipeline(ready({ waiting: 869, failures: [failure({ problem: problem("interrupted", closed) })] }))).toEqual({ label: "Processing was interrupted when the app closed — it resumes on its own", tone: "quiet", ...seeRuns, tooltip: `“Foreword”: ${closed}` });
    expect(describePipeline(ready({ waiting: 869, failures: [failure()] }))).toEqual({ label: "Processing: 1 source failed", tone: "warn", ...seeRuns, tooltip: "“Foreword”: boom" });
    // The newest failure decides the row; a deadline is not a model-setup problem.
    const late = "The run took longer than the pipeline's time limit (set in Workflow Studio) and was stopped.";
    expect(describePipeline(ready({ failures: [failure({ problem: problem("deadline", late) }), failure({ runId: "r0", problem: problem("interrupted") })] }))).toEqual({ label: "Processing: 2 sources failed", tone: "warn", ...seeRuns, tooltip: `“Foreword”: ${late}` });
    // No message and no error: the tooltip still names the source.
    expect(describePipeline(ready({ failures: [failure({ error: null })] })).tooltip).toBe("“Foreword”: the run failed");
  });
});
