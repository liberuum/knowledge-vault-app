import { isModelSetupProblem } from "../components/pipeline-chip.js";
import type { PipelineStatus } from "../vaults.js";

/** Notes are being written: a run is in progress or queued in the engine. */
export function isWriting(p: PipelineStatus | null): boolean {
  return p?.state === "ready" && (p.running ?? 0) > 0;
}

/** What processing is doing now, in a sentence (the guide's last screen; spec §1). */
export function processingLine(p: PipelineStatus | null, notes: number): string {
  if (!p) return "Checking the processing…";
  if (p.state === "unconfigured") return "Processing is not set up: choose an AI in Settings › Models.";
  if (p.state === "missing" || p.state === "stale") return "Processing needs setting up for this vault.";
  if (p.state === "starting") return "Processing starts in a moment.";
  const so = notes > 0 ? ` ${notes} note${notes === 1 ? "" : "s"} so far.` : "";
  if (isWriting(p)) return `Writing notes from your sources…${so}`;
  const failures = p.failures ?? [];
  const newest = failures[0];
  // A model-setup problem says what to fix; an interrupted run says it resumes on its own.
  if (newest?.problem && (isModelSetupProblem(newest.problem.kind) || newest.problem.kind === "interrupted")) return `${newest.problem.message}${so}`;
  if (failures.length) return `Processing failed for ${failures.length} source${failures.length === 1 ? "" : "s"}.${so}`;
  if (notes > 0) return `${notes} note${notes === 1 ? "" : "s"} written. More appear as each source is read.`;
  return "Your sources are queued; the first one starts within a minute.";
}
