import { describe, expect, it } from "vitest";
import type { PipelineFailure, PipelineStatus } from "../vaults.js";
import { isWriting, processingLine } from "./processing-line.js";

const ready = (over: Record<string, unknown> = {}) => ({ state: "ready", workflowId: "wf", connectionId: "c", running: 0, waiting: 0, failures: [], hasRuns: true, ...over }) as PipelineStatus;
const failure = (over: Partial<PipelineFailure> = {}): PipelineFailure => ({ runId: "r", source: "Foreword", at: null, error: "boom", ...over });

describe("the guide's processing line reads the work", () => {
  it("says notes are being written while a run is in progress or queued", () => {
    expect(processingLine(ready({ running: 2, waiting: 869 }), 3)).toBe("Writing notes from your sources… 3 notes so far.");
    expect(isWriting(ready({ running: 1 }))).toBe(true);
    expect(isWriting(ready())).toBe(false);
    expect(isWriting({ state: "ready", workflowId: "wf", connectionId: "c" })).toBe(false); // the answer to a set-up
    expect(isWriting(null)).toBe(false);
  });

  it("gives a model-setup failure's own message, an interrupted run's own message, else counts the failed sources", () => {
    expect(processingLine(ready({ failures: [failure({ problem: { kind: "bad-key", message: "Your model provider refused the API key." } })] }), 0)).toBe("Your model provider refused the API key.");
    expect(processingLine(ready({ failures: [failure({ problem: { kind: "interrupted", message: "The app was closed while this source was being processed; it is processed again on its own." } })] }), 1)).toBe("The app was closed while this source was being processed; it is processed again on its own. 1 note so far.");
    expect(processingLine(ready({ failures: [failure()] }), 0)).toBe("Processing failed for 1 source.");
    expect(processingLine(ready({ failures: [failure(), failure({ runId: "r0" })] }), 4)).toBe("Processing failed for 2 sources. 4 notes so far.");
  });

  it("keeps the other lines as they were", () => {
    expect(processingLine(null, 0)).toBe("Checking the processing…");
    expect(processingLine({ state: "unconfigured" }, 0)).toBe("Processing is not set up: choose an AI in Settings › Models.");
    expect(processingLine({ state: "missing" }, 0)).toBe("Processing needs setting up for this vault.");
    expect(processingLine({ state: "starting" }, 0)).toBe("Processing starts in a moment.");
    expect(processingLine(ready(), 5)).toBe("5 notes written. More appear as each source is read.");
    expect(processingLine(ready({ waiting: 3 }), 0)).toBe("Your sources are queued; the first one starts within a minute.");
  });
});
