import { runtimeMissing } from "./pipelines.js";
import { execute, gql, toActions } from "./reactor-gql.js";

/**
 * After an update, the pieces the app ships (the vault piece, the stack's own) exist only at their new version, and
 * every workflow still pins the old one. The runtime runs the installed version in its place ("Pinned 1.0.54-dev.51
 * is not available; runs 1.0.54-dev.59 from local") and Studio shows each such block as stale until someone moves its
 * pin by hand, which nobody using the app would know to do. At start, every workflow in the app's Workflows drive has
 * those pins moved to the version that runs: what runs does not change, the stale pins go.
 *
 * Only blocks the runtime resolves from the app's own pieces (source "local") move, and only when it calls the
 * installed version a stand-in for the pin: "compatible" (newer, on the same line) or "installed" (a piece that runs
 * only as installed). A "fallback" (an older version than the pin, or another major line) still runs, with a warning
 * on the run, and is left for a person to look at. A workflow with unpublished edits in Studio is left alone, as
 * pipelines.ts followTemplate leaves it: publishing would publish the edits too. One never published has its draft
 * moved and stays unpublished. The workflow's status is never touched; publishing, like every publish, lifts a park.
 */

/** A block as the runtime resolves it for the editor (`workflowRuntime.blockResolutions`: the draft's blocks). */
export type BlockResolution = {
  stepId: string;
  kind: string;
  pieceName: string;
  pieceVersion: string;
  resolvedVersion: string | null;
  source: string | null;
  match: string;
};

export type PiecePinsDeps = {
  origin: string;
  fetchImpl: typeof fetch;
  workflowsDrive: () => Promise<{ id: string }>;
  now?: () => string;
  /** Between checks while the engine has no workflow runtime yet (another holder's lease is running out). */
  sleep?: (ms: number) => Promise<void>;
  /** Runs one workflow's change under the lock of the vault that owns it (pipelines.ts forWorkflow). */
  lock?: <T>(workflowId: string, work: () => Promise<T>) => Promise<T>;
};

/** A crashed engine's lease runs out within a minute (6.2.3-dev.51); the pass waits twice that, checking every 5 s. */
const RUNTIME_CHECKS = 24;
const RUNTIME_CHECK_MS = 5_000;

/** The blocks to move, each to the version the runtime runs for it. */
export function stalePins(blocks: readonly BlockResolution[]): Array<{ stepId: string; to: string }> {
  return blocks.flatMap((b) =>
    b.source === "local" && (b.match === "compatible" || b.match === "installed") && b.resolvedVersion && b.resolvedVersion !== b.pieceVersion
      ? [{ stepId: b.stepId, to: b.resolvedVersion }]
      : [],
  );
}

type WorkflowState = { version?: number; published?: { version?: number } | null; trigger?: { id: string } | null; steps?: Array<{ id: string }> };
type StateOf<T> = { document: { document: { state: { global: T } } } };
const STATE = `query($id: String!) { document(idOrSlug: $id) { document { state } } }`;

export async function followPiecePins(deps: PiecePinsDeps): Promise<{ updated: string[]; skipped: string[]; failed: string[] }> {
  const out = { updated: [] as string[], skipped: [] as string[], failed: [] as string[] };
  const f = deps.fetchImpl;
  const now = deps.now ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const lock = deps.lock ?? (<T>(_workflowId: string, work: () => Promise<T>) => work());

  const drive = await deps.workflowsDrive();
  const nodes = (await gql<StateOf<{ nodes?: Array<{ id: string; kind: string; documentType?: string }> }>>(deps.origin, STATE, { id: drive.id }, f)).document.document.state.global.nodes ?? [];
  const workflows = nodes.filter((n) => n.kind === "file" && n.documentType === "powerhouse/workflow").map((n) => n.id);
  if (workflows.length === 0) return out;

  for (let check = 1; ; check++) {
    try {
      await gql(deps.origin, `{ workflowRuntime { __typename } }`, {}, f);
      break;
    } catch (error) {
      if (!runtimeMissing(error)) throw error;
      if (check >= RUNTIME_CHECKS) throw new Error("the workflow runtime did not start; the pins are checked again at the next start");
      await sleep(RUNTIME_CHECK_MS);
    }
  }

  for (const id of workflows) {
    try {
      const result = await lock(id, async (): Promise<"current" | "skipped" | "updated"> => {
        const { blockResolutions } = (
          await gql<{ workflowRuntime: { blockResolutions: BlockResolution[] } }>(
            deps.origin,
            `query($w: String!) { workflowRuntime { blockResolutions(workflowId: $w) { stepId kind pieceName pieceVersion resolvedVersion source match } } }`,
            { w: id },
            f,
          )
        ).workflowRuntime;
        const stale = stalePins(blockResolutions);
        if (stale.length === 0) return "current";
        const state = (await gql<StateOf<WorkflowState>>(deps.origin, STATE, { id }, f)).document.document.state.global;
        if (state.published && state.version !== state.published.version) return "skipped";
        const steps = new Set((state.steps ?? []).map((s) => s.id));
        const ops: Array<{ type: string; input: unknown }> = [];
        for (const pin of stale) {
          if (state.trigger && pin.stepId === state.trigger.id) ops.push({ type: "SET_TRIGGER_PIECE_VERSION", input: { pieceVersion: pin.to } });
          else if (steps.has(pin.stepId)) ops.push({ type: "UPDATE_STEP", input: { id: pin.stepId, pieceVersion: pin.to } });
        }
        if (ops.length === 0) return "current";
        // The runtime runs the published workflow: published again, as it was, with the new pins.
        if (state.published) ops.push({ type: "PUBLISH_WORKFLOW", input: { publishedAt: now() } });
        await execute(deps.origin, id, toActions(ops, now), f);
        return "updated";
      });
      if (result === "updated") out.updated.push(id);
      if (result === "skipped") out.skipped.push(id);
    } catch (error) {
      console.warn(`[piece-pins] workflow ${id} keeps its pins until the next start: ${error instanceof Error ? error.message : String(error)}`);
      out.failed.push(id);
    }
  }
  return out;
}
