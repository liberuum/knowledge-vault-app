import type { PipelineFailure, PipelineStatus, RunProblem } from "../vaults.js";

export type ChipTone = "quiet" | "busy" | "ok" | "warn" | "action";
export type ChipAction = "models" | "setup" | "runs";
/** `tooltip` is set on a row about a failure (the newest one, with its source); every other row keeps the chip's own. */
export type ChipDescription = { label: string; tone: ChipTone; action?: ChipAction; actionLabel?: string; tooltip?: string };

/** A model-setup problem: every run fails the same way until the model is fixed in Settings. */
const STOPPED: Partial<Record<RunProblem["kind"], string>> = {
  "no-funds": "Processing stopped: your model provider account is out of credit",
  "bad-key": "Processing stopped: your model provider refused the API key",
  "rate-limited": "Processing stopped: your model provider is rate-limiting requests",
  "slow-model": "Processing stopped: the model did not answer in time",
  "model-missing": "Processing stopped: the model is not available at your provider",
  "model-refused": "Processing stopped: the model refused the request",
};
export function isModelSetupProblem(kind: RunProblem["kind"]): boolean {
  return STOPPED[kind] !== undefined;
}

const sources = (n: number) => `${n} source${n === 1 ? "" : "s"}`;
/** The work in progress, with how many sources are left when the queue says. */
const progress = (waiting: number) => `Processing…${waiting > 0 ? ` ${sources(waiting)} to go` : ""}`;
/** The newest failure as the chip's tooltip: its source, then what went wrong. */
const failureTip = (f: PipelineFailure) => `“${f.source}”: ${f.problem?.message ?? f.error ?? "the run failed"}`;
const SEE_RUNS = { action: "runs", actionLabel: "See runs" } as const;

/**
 * The pipeline in the user's words, "processing", with the one action that fixes the state (spec §5.2, §9):
 * no model → Settings › Models; no pipeline → set it up; a failure, or a paused or erroring trigger → the runs in
 * Workflow Studio. Past the set-up states the chip reads the work, not the last run (spec §1). The first row that
 * matches wins: a model-setup failure, runs in progress (queued runs count), an interrupted run, other failures,
 * sources waiting, then finished.
 */
export function describePipeline(status: PipelineStatus): ChipDescription {
  if (status.state === "unconfigured") return { label: "Processing off", tone: "action", action: "models", actionLabel: "Set up a model" };
  if (status.state === "missing") return { label: "Processing not set up", tone: "action", action: "setup", actionLabel: "Set up" };
  if (status.state === "stale") return { label: "Processing needs an update", tone: "action", action: "setup", actionLabel: "Update" };
  if (status.state === "starting") return { label: "Processing starts in a moment", tone: "quiet" };
  // A workflow whose policy parks on failure (one edited in Studio) stops polling until it is published again.
  if (status.trigger?.status === "PARKED") return { label: "Processing paused after a failed run", tone: "warn", ...SEE_RUNS };
  if (status.trigger?.lastError) return { label: "Processing: trigger error", tone: "warn", ...SEE_RUNS };
  if (status.trigger && status.trigger.status !== "ENABLED") return { label: "Processing paused", tone: "quiet", ...SEE_RUNS };
  const running = status.running ?? 0;
  const waiting = status.waiting ?? 0;
  const failures = status.failures ?? [];
  const newest = failures[0];
  if (newest) {
    const tooltip = failureTip(newest);
    const stopped = newest.problem ? STOPPED[newest.problem.kind] : undefined;
    if (stopped) return { label: stopped, tone: "warn", ...SEE_RUNS, tooltip };
    if (running > 0) return { label: `${progress(waiting)} · ${failures.length} failed`, tone: "busy", ...SEE_RUNS, tooltip };
    if (newest.problem?.kind === "interrupted") return { label: "Processing was interrupted when the app closed — it resumes on its own", tone: "quiet", ...SEE_RUNS, tooltip };
    return { label: `Processing: ${sources(failures.length)} failed`, tone: "warn", ...SEE_RUNS, tooltip };
  }
  if (running > 0) return { label: progress(waiting), tone: "busy" };
  if (waiting > 0) return { label: `Processing: ${sources(waiting)} waiting`, tone: "quiet" };
  return { label: status.hasRuns ? "Processing up to date" : "Processing ready", tone: "ok" };
}
