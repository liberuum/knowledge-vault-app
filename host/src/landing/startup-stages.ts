/**
 * What the engine is doing while it starts, derived from its output lines (the shell forwards
 * them as `sidecar:log` until the engine is ready). The landing shows these as a checklist so a
 * start that takes a while — the first launch on Windows unpacks the engine, a large store takes
 * seconds to open — is visibly moving rather than a blank page.
 *
 * Milestones come from lines the Switchboard and the engine print today; the classifier only
 * ever moves forward, so a missing marker (no vault yet, hence no graph index) costs nothing.
 */
export type StageId = "unpack" | "start" | "store" | "package" | "vaults" | "index" | "api" | "pipeline" | "ready";
export type Stage = { id: StageId; label: string };

export const STAGES: readonly Stage[] = [
  { id: "unpack", label: "Unpacking the engine" },
  { id: "start", label: "Starting the engine" },
  { id: "store", label: "Checking your store" },
  { id: "package", label: "Loading the Knowledge Vault package" },
  { id: "vaults", label: "Opening your vaults" },
  { id: "index", label: "Waking the graph index" },
  { id: "api", label: "Registering the API" },
  { id: "pipeline", label: "Starting the pipeline runtime" },
  { id: "ready", label: "Ready" },
];

const MARKERS: readonly { id: StageId; test: RegExp }[] = [
  { id: "store", test: /\[sidecar\] checking the store/ },
  { id: "package", test: /\[package-manager\] Loading packages/ },
  { id: "vaults", test: /Using PGlite .* for reactor storage|Using Postgres for reactor storage/ },
  { id: "index", test: /\[GraphIndexer\] Processor created/ },
  { id: "api", test: /Registered \/graphql supergraph/ },
  { id: "pipeline", test: /Workflow runtime started/ },
];

export function stageOfLine(line: string): StageId | null {
  for (const m of MARKERS) if (m.test.test(line)) return m.id;
  return null;
}

export type Progress = { reached: number; latest: string | null };

const NOISE = /^\s*$|^\s*["{}\]]|^\s*\}|DeprecationWarning|--trace-deprecation/;
const PREFIX = /^(\[sidecar\]\s*)?(\[\d\d:\d\d:\d\d(\.\d+)?\]\s*)?/;

/** The next progress after one engine line: never backwards, with the line kept as the detail unless it is noise. */
export function advance(progress: Progress, rawLine: string): Progress {
  const line = rawLine.replace(/\r?\n$/, "");
  if (NOISE.test(line)) return progress;
  const stage = stageOfLine(line);
  const index = stage ? STAGES.findIndex((s) => s.id === stage) : -1;
  return { reached: Math.max(progress.reached, index), latest: line.replace(PREFIX, "").trim() || progress.latest };
}

export const indexOf = (id: StageId) => STAGES.findIndex((s) => s.id === id);

/** The label of the stage under way: unpacking while the shell unpacks, else the one after the last milestone passed. */
export function currentStageIndex(progress: Progress, preparing: boolean): number {
  if (preparing && progress.reached < 0) return 0;
  // Unpacking only happens while the shell says so; otherwise the first stage under way is the start itself.
  return Math.max(1, Math.min(progress.reached + 1, STAGES.length - 1));
}

export function currentStageLabel(progress: Progress, preparing: boolean): string {
  return STAGES[currentStageIndex(progress, preparing)]?.label ?? "Starting the engine";
}
