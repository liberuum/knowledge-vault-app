import { describe, expect, it, vi } from "vitest";
import { followPiecePins, type BlockResolution } from "./piece-pins.js";

const NOW = "2026-11-05T16:30:00.000Z";
const VAULT = "@powerhousedao/piece-knowledge-vault";
type Call = { query: string; variables: Record<string, unknown> };
type Workflow = { version: number; published: { version: number } | null; trigger: { id: string } | null; steps: Array<{ id: string }>; blocks: BlockResolution[] };

const block = (stepId: string, over: Partial<BlockResolution> = {}): BlockResolution => ({
  stepId,
  kind: "action",
  pieceName: VAULT,
  pieceVersion: "1.0.54-dev.51",
  resolvedVersion: "1.0.54-dev.59",
  source: "local",
  match: "compatible",
  ...over,
});
/** The Liberuum pipeline after its trigger was moved by hand in Studio: the five steps still pin dev.51. */
const pipeline = (): Workflow => ({
  version: 33,
  published: { version: 33 },
  trigger: { id: "trig" },
  steps: ["extract", "connect", "place", "verify", "health"].map((id) => ({ id })),
  blocks: [block("trig", { kind: "trigger", pieceVersion: "1.0.54-dev.59", match: "exact" }), ...["extract", "connect", "place", "verify", "health"].map((id) => block(id))],
});

/** The engine as the pass sees it: the Workflows drive, each workflow's state and block resolutions, and `execute`. */
function fakeEngine(workflows: Record<string, Workflow>, opts: { runtimeMissingFor?: number; rejectTypesFor?: Record<string, string[]> } = {}) {
  const calls: Call[] = [];
  const written = new Map<string, Array<{ id: string; type: string; input: unknown }>>();
  const ops = new Map<string, Array<{ index: number; error: string | null; action: { id: string; type: string } }>>();
  let runtimeChecks = 0;
  const reply = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
  const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    const q = body.query;
    const id = String(body.variables.id ?? body.variables.w ?? "");
    if (q.includes("workflowRuntime")) {
      // While another holder's lease runs out the engine has no runtime: HTTP 400, the field unknown.
      if (runtimeChecks++ < (opts.runtimeMissingFor ?? 0)) return { ok: false, status: 400, json: async () => ({ errors: [{ message: 'Cannot query field "workflowRuntime" on type "Query".' }] }) };
      if (q.includes("blockResolutions")) return reply({ workflowRuntime: { blockResolutions: workflows[id]!.blocks } });
      return reply({ workflowRuntime: { __typename: "WorkflowRuntimeQueries" } });
    }
    if (q.includes("revisionsList")) return reply({ document: { document: { revisionsList: [{ scope: "global", revision: (ops.get(id) ?? []).length }] } } });
    if (q.includes("execute(")) {
      const list = ops.get(id) ?? [];
      const reject = new Set(opts.rejectTypesFor?.[id] ?? []);
      for (const a of body.variables.a as Array<{ id: string; type: string; input: unknown }>) {
        list.push({ index: list.length, error: reject.has(a.type) ? `${a.type} refused` : null, action: { id: a.id, type: a.type } });
        written.set(id, [...(written.get(id) ?? []), a]);
      }
      ops.set(id, list);
      return reply({ execute: { id } });
    }
    if (q.includes("operations(")) return reply({ document: { document: { operations: { items: (ops.get(id) ?? []).filter((o) => o.index >= Number(body.variables.since ?? 0)) } } } });
    if (q.includes("document { state }")) {
      if (id === "drive-wf") {
        const nodes = [
          { id: "home", kind: "folder", name: "A · Liberuum — Vault pipeline", parentFolder: null },
          { id: "conn-1", kind: "file", name: "Liberuum", documentType: "powerhouse/connection", parentFolder: null },
          ...Object.keys(workflows).map((w) => ({ id: w, kind: "file", name: w, documentType: "powerhouse/workflow", parentFolder: "home" })),
        ];
        return reply({ document: { document: { state: { global: { nodes } } } } });
      }
      const { blocks: _blocks, ...global } = workflows[id]!;
      return reply({ document: { document: { state: { global } } } });
    }
    throw new Error(`unexpected query: ${q}`);
  }) as unknown as typeof fetch;
  /** What a workflow was sent, as type and input. */
  const sent = (wf: string) => (written.get(wf) ?? []).map(({ type, input }) => ({ type, input }));
  return { fetchImpl, calls, sent };
}

function run(engine: ReturnType<typeof fakeEngine>, over: Partial<Parameters<typeof followPiecePins>[0]> = {}) {
  return followPiecePins({ origin: "http://127.0.0.1:4201", fetchImpl: engine.fetchImpl, workflowsDrive: async () => ({ id: "drive-wf" }), now: () => NOW, sleep: async () => {}, ...over });
}

describe("followPiecePins", () => {
  it("moves the steps still pinned to a version the app no longer ships to the one that runs, and publishes", async () => {
    const engine = fakeEngine({ "wf-pipeline": pipeline() });
    const out = await run(engine);
    expect(out).toEqual({ updated: ["wf-pipeline"], skipped: [], failed: [] });
    expect(engine.sent("wf-pipeline")).toEqual([
      ...["extract", "connect", "place", "verify", "health"].map((id) => ({ type: "UPDATE_STEP", input: { id, pieceVersion: "1.0.54-dev.59" } })),
      { type: "PUBLISH_WORKFLOW", input: { publishedAt: NOW } },
    ]);
  });

  it("moves the trigger with SET_TRIGGER_PIECE_VERSION when it is the stale pin, and never touches the status", async () => {
    const wf = pipeline();
    wf.blocks = [block("trig", { kind: "trigger" })];
    const engine = fakeEngine({ "wf-reweave": wf });
    await run(engine);
    expect(engine.sent("wf-reweave")).toEqual([
      { type: "SET_TRIGGER_PIECE_VERSION", input: { pieceVersion: "1.0.54-dev.59" } },
      { type: "PUBLISH_WORKFLOW", input: { publishedAt: NOW } },
    ]);
    expect(engine.sent("wf-reweave").some((op) => op.type === "SET_WORKFLOW_STATUS")).toBe(false);
  });

  it("pins an installed-only piece to the version installed", async () => {
    const wf = pipeline();
    wf.blocks = [block("extract", { match: "installed" })];
    const engine = fakeEngine({ "wf-1": wf });
    await run(engine);
    expect(engine.sent("wf-1")[0]).toEqual({ type: "UPDATE_STEP", input: { id: "extract", pieceVersion: "1.0.54-dev.59" } });
  });

  it("leaves exact pins, pieces from other sources and fallbacks as they are: nothing is written", async () => {
    const wf = pipeline();
    wf.blocks = [
      block("trig", { kind: "trigger", pieceVersion: "1.0.54-dev.59", match: "exact" }),
      // An Activepieces piece is fetched at the version it pins; the app does not ship it.
      block("extract", { pieceName: "@activepieces/piece-rss", pieceVersion: "0.7.0", resolvedVersion: "0.7.1", source: "activepieces" }),
      // An older version than the pin, or another major line: a person should look before it is pinned.
      block("connect", { pieceVersion: "2.0.0", resolvedVersion: "1.0.54-dev.59", match: "fallback" }),
      // Nothing can run it.
      block("place", { resolvedVersion: null, source: null, match: "missing" }),
    ];
    const engine = fakeEngine({ "wf-1": wf });
    expect(await run(engine)).toEqual({ updated: [], skipped: [], failed: [] });
    expect(engine.calls.some((c) => c.query.includes("execute("))).toBe(false);
  });

  it("leaves a workflow with unpublished edits in Studio alone, since publishing would publish them too", async () => {
    const wf = pipeline();
    wf.version = 34;
    const engine = fakeEngine({ "wf-edited": wf });
    expect(await run(engine)).toEqual({ updated: [], skipped: ["wf-edited"], failed: [] });
    expect(engine.calls.some((c) => c.query.includes("execute("))).toBe(false);
  });

  it("pins the draft of a workflow never published, without publishing it", async () => {
    const wf = pipeline();
    wf.published = null;
    wf.blocks = [block("verify")];
    const engine = fakeEngine({ "wf-draft": wf });
    await run(engine);
    expect(engine.sent("wf-draft")).toEqual([{ type: "UPDATE_STEP", input: { id: "verify", pieceVersion: "1.0.54-dev.59" } }]);
  });

  it("waits for the workflow runtime while another holder's lease runs out, then pins", async () => {
    const engine = fakeEngine({ "wf-pipeline": pipeline() }, { runtimeMissingFor: 2 });
    const sleep = vi.fn(async () => {});
    expect((await run(engine, { sleep })).updated).toEqual(["wf-pipeline"]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up for this start when the runtime does not come, and writes nothing", async () => {
    const engine = fakeEngine({ "wf-pipeline": pipeline() }, { runtimeMissingFor: 1000 });
    await expect(run(engine)).rejects.toThrow(/workflow runtime/);
    expect(engine.calls.some((c) => c.query.includes("execute("))).toBe(false);
  });

  it("one workflow the engine refuses does not stop the others", async () => {
    const engine = fakeEngine({ "wf-a": pipeline(), "wf-b": pipeline() }, { rejectTypesFor: { "wf-a": ["UPDATE_STEP"] } });
    const out = await run(engine);
    expect(out).toEqual({ updated: ["wf-b"], skipped: [], failed: ["wf-a"] });
  });

  it("makes each change under the lock of the vault that owns the workflow", async () => {
    const engine = fakeEngine({ "wf-pipeline": pipeline() });
    const order: string[] = [];
    const lock = vi.fn(async <T,>(workflowId: string, work: () => Promise<T>) => {
      order.push(`lock ${workflowId}`);
      const result = await work();
      order.push(`unlock ${workflowId}`);
      return result;
    });
    await run(engine, { lock });
    expect(order).toEqual(["lock wf-pipeline", "unlock wf-pipeline"]);
    expect(engine.sent("wf-pipeline")).toHaveLength(6);
  });

  it("reads only workflows: folders and connections in the drive are passed over", async () => {
    const engine = fakeEngine({});
    expect(await run(engine)).toEqual({ updated: [], skipped: [], failed: [] });
    expect(engine.calls.filter((c) => c.query.includes("blockResolutions"))).toHaveLength(0);
  });
});
