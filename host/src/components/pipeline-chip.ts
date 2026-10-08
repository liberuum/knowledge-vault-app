import type { PipelineStatus } from "../vaults.js";

export type ChipTone = "quiet" | "busy" | "ok" | "warn" | "action";
export type ChipAction = "models" | "setup" | "runs";
export type ChipDescription = { label: string; tone: ChipTone; action?: ChipAction; actionLabel?: string };

/**
 * The pipeline in the user's words — "processing" — with the one action that
 * fixes the state (spec §5.2, §9): no model → Settings › Models; no pipeline →
 * set it up; a failed run, a paused or erroring trigger → the runs in Workflow
 * Studio.
 */
export function describePipeline(status: PipelineStatus): ChipDescription {
  if (status.state === "unconfigured") return { label: "Processing off", tone: "action", action: "models", actionLabel: "Set up a model" };
  if (status.state === "missing") return { label: "Processing not set up", tone: "action", action: "setup", actionLabel: "Set up" };
  if (status.state === "stale") return { label: "Processing needs an update", tone: "action", action: "setup", actionLabel: "Update" };
  if (status.trigger?.lastError) return { label: "Processing: trigger error", tone: "warn", action: "runs", actionLabel: "See runs" };
  if (status.trigger && status.trigger.status !== "ENABLED") return { label: "Processing paused", tone: "quiet", action: "runs", actionLabel: "See runs" };
  const run = status.lastRun;
  if (run?.status === "RUNNING") return { label: "Processing…", tone: "busy" };
  if (run?.status === "FAILED") {
    // The error in plain words when the engine can tell what it means; the action stays the runs.
    const labels: Record<string, string> = {
      "no-funds": "Processing stopped: your model provider account is out of credit",
      "bad-key": "Processing stopped: your model provider refused the API key",
      "rate-limited": "Processing stopped: your model provider is rate-limiting requests",
      "slow-model": "Processing stopped: the model did not answer in time",
      "model-missing": "Processing stopped: the model is not available at your provider",
      "model-refused": "Processing stopped: the model refused the request",
    };
    return { label: (run.problem && labels[run.problem.kind]) ?? "Last processing run failed", tone: "warn", action: "runs", actionLabel: "See runs" };
  }
  if (run?.status === "SUCCEEDED") return { label: "Processing up to date", tone: "ok" };
  return { label: "Processing ready", tone: "ok" };
}
