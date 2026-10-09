import { describe, expect, it, vi } from "vitest";
import { planRepairs, planSourceRepairs, repairQueue, type QueueTask } from "./queue-watchdog.js";

const t = (over: Partial<QueueTask>): QueueTask => ({ id: "t1", taskType: "claim", status: "PENDING", target: "Foreword", documentRef: "src1", currentPhase: "create", createdAt: "2026-10-08T10:00:00.000Z", updatedAt: null, handoffs: [], ...over });
const sources = new Set(["src1", "src2"]);
const NOW = "2026-10-08T10:30:00.000Z";

describe("planRepairs", () => {
  it("queues again a task a failed run left held (IN_PROGRESS, no handoff) once it has sat for the hold time", () => {
    const stuck = t({ id: "a", status: "IN_PROGRESS", updatedAt: "2026-10-08T10:05:00.000Z" });
    expect(planRepairs([stuck], sources, NOW)).toEqual([{ kind: "requeue", task: stuck, reason: "held with no progress; queued again" }]);
  });
  it("leaves a task alone while it is being worked on: held recently, or with a handoff already", () => {
    expect(planRepairs([t({ id: "a", status: "IN_PROGRESS", updatedAt: "2026-10-08T10:25:00.000Z" })], sources, NOW)).toEqual([]);
    expect(planRepairs([t({ id: "b", status: "IN_PROGRESS", updatedAt: "2026-10-08T10:05:00.000Z", handoffs: [{ phase: "create" }] })], sources, NOW)).toEqual([]);
  });
  it("drops a pending or held task whose source no longer exists — the trigger would never fire it", () => {
    const gone = t({ id: "c", documentRef: "deleted" });
    expect(planRepairs([gone], sources, NOW)).toEqual([{ kind: "drop", task: gone, reason: "the source no longer exists" }]);
  });
  it("on the start-up pass, queues again every held task at once — a closed app cut them off, whatever their phase", () => {
    const early = t({ id: "a", status: "IN_PROGRESS", updatedAt: "2026-10-08T10:29:00.000Z" });
    const midway = t({ id: "b", status: "IN_PROGRESS", currentPhase: "reflect", handoffs: [{ phase: "create" }], updatedAt: "2026-10-08T10:29:30.000Z" });
    expect(planRepairs([early, midway], sources, NOW, { startup: true }).map((r) => [r.kind, r.task.id, r.reason])).toEqual([
      ["requeue", "a", "the app was closed while it was being processed; queued again"],
      ["requeue", "b", "the app was closed while it was being processed; queued again"],
    ]);
  });
  it("ignores finished tasks and other task types", () => {
    expect(planRepairs([t({ status: "DONE", documentRef: "deleted" }), t({ status: "FAILED" }), t({ taskType: "enrichment", documentRef: "deleted" })], sources, NOW)).toEqual([]);
  });
});

describe("planSourceRepairs", () => {
  it("reopens a source marked extracted without claims and queues it; queues a source waiting with no task; leaves the rest", () => {
    const sources = [
      { id: "s1", name: "Lost", status: "EXTRACTED", claims: 0 },
      { id: "s2", name: "Done", status: "EXTRACTED", claims: 7 },
      { id: "s3", name: "Waiting", status: "EXTRACTING", claims: 0 },
      { id: "s4", name: "Queued", status: "EXTRACTING", claims: 0 },
      { id: "s5", name: "Inbox", status: "INBOX", claims: 0 },
    ];
    const tasks = [t({ id: "q", documentRef: "s4", status: "PENDING" }), t({ id: "old", documentRef: "s3", status: "FAILED" })];
    expect(planSourceRepairs(sources, tasks).map((r) => [r.kind, r.source.name])).toEqual([
      ["reopen", "Lost"],
      ["queue", "Lost"],
      ["queue", "Waiting"],
    ]);
  });
  it("leaves a source whose extraction ran to the end and found nothing: its stats say so", () => {
    const sources = [{ id: "s1", name: "Contacts page", status: "EXTRACTED", claims: 0, statsRecorded: true }];
    expect(planSourceRepairs(sources, [])).toEqual([]);
  });
});

describe("repairQueue", () => {
  function engine(tasks: QueueTask[], runStatus = "SUCCEEDED", sourceStatus = "EXTRACTING", catchUp: { status: number; body?: unknown } = { status: 404 }) {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const caughtUp: unknown[] = [];
    const fetchImpl = vi.fn(async (u: unknown, init?: { body?: unknown }) => {
      if (String(u).endsWith("/api/@powerhousedao/knowledge-note/tasks/reconcile")) {
        caughtUp.push(JSON.parse(String(init?.body)));
        return { ok: catchUp.status < 300, status: catchUp.status, json: async () => catchUp.body ?? {} };
      }
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      calls.push(body);
      if (body.query.includes("runsPage")) return { ok: true, json: async () => ({ data: { workflowRuntime: { runsPage: { items: [{ status: runStatus, startedAt: "2026-10-08T10:20:00.000Z" }] } } } }) };
      if (body.query.includes("document { state }") && body.variables.id === "vault1") return { ok: true, json: async () => ({ data: { document: { document: { state: { global: { nodes: [{ id: "q1", documentType: "bai/pipeline-queue" }, { id: "src1", documentType: "bai/source" }] } } } } } }) };
      if (body.query.includes("document { state }") && body.variables.id === "q1") return { ok: true, json: async () => ({ data: { document: { document: { state: { global: { tasks } } } } } }) };
      if (body.query.includes("document { name state }") && body.variables.id === "src1") return { ok: true, json: async () => ({ data: { document: { document: { name: "Foreword", state: { global: { status: sourceStatus, extractedClaims: [] } } } } } }) };
      if (body.query.includes("execute(")) return { ok: true, json: async () => ({ data: { execute: { id: "q1" } } }) };
      if (body.query.includes("operations(")) {
        // as many applied operations as the last execute sent, none rejected
        const last = [...calls].reverse().find((c) => c.query.includes("execute("));
        const sent = (last?.variables.a as Array<{ type: string }>) ?? [];
        return { ok: true, json: async () => ({ data: { document: { document: { operations: { items: sent.map((a, index) => ({ index, error: null, action: { type: a.type } })), hash: "" } } } } }) };
      }
      throw new Error(`unexpected query: ${body.query}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls, caughtUp };
  }
  const deps = (fetchImpl: typeof fetch) => ({ origin: "http://127.0.0.1:4201", fetchImpl, now: () => NOW, newId: () => "new-id" });

  it("fails a stuck task and adds a fresh one for the same source; fails an orphan outright", async () => {
    const e = engine([t({ id: "stuck", status: "IN_PROGRESS", updatedAt: "2026-10-08T10:05:00.000Z" }), t({ id: "orphan", documentRef: "gone", target: "Old" }), t({ id: "fine", status: "PENDING" })]);
    expect(await repairQueue(deps(e.fetchImpl), "vault1", "wf-1")).toEqual({ requeued: ["Foreword"], dropped: ["Old"] });
    const exec = e.calls.find((c) => c.query.includes("execute("))!;
    const actions = (exec.variables.a as Array<{ type: string; input: Record<string, unknown> }>).map((a) => ({ type: a.type, input: a.input }));
    expect(actions).toEqual([
      { type: "FAIL_TASK", input: { taskId: "stuck", reason: "held with no progress; queued again", updatedAt: NOW } },
      { type: "ADD_TASK", input: { id: "new-id", taskType: "claim", target: "Foreword", documentRef: "src1", createdAt: NOW } },
      { type: "FAIL_TASK", input: { taskId: "orphan", reason: "the source no longer exists", updatedAt: NOW } },
    ]);
  });
  it("asks the vault to catch the queue up after its own repairs, and reports what moved", async () => {
    const e = engine([t({ id: "fine" })], "SUCCEEDED", "EXTRACTING", { status: 200, body: { advanced: [{ title: "Foreword", phases: ["create", "reflect"] }, { phases: [] }] } });
    expect(await repairQueue(deps(e.fetchImpl), "vault1", "wf-1")).toEqual({ requeued: [], dropped: [], caughtUp: ["Foreword: create, reflect", "?: "] });
    expect(e.caughtUp).toEqual([{ drive: "vault1", by: "desktop app" }]);
    // nothing moved: nothing reported
    const quiet = engine([t({ id: "fine" })], "SUCCEEDED", "EXTRACTING", { status: 200, body: {} });
    expect(await repairQueue(deps(quiet.fetchImpl), "vault1", "wf-1")).toEqual({ requeued: [], dropped: [] });
  });
  it("goes on without the catch-up on an engine that predates it, or when it fails", async () => {
    const old = engine([t({ id: "fine" })]);
    expect(await repairQueue(deps(old.fetchImpl), "vault1", "wf-1")).toEqual({ requeued: [], dropped: [] });
    expect(old.caughtUp).toHaveLength(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = engine([t({ id: "stuck", status: "IN_PROGRESS", updatedAt: "2026-10-08T10:05:00.000Z" })], "SUCCEEDED", "EXTRACTING", { status: 500 });
    expect((await repairQueue(deps(broken.fetchImpl), "vault1", "wf-1")).requeued).toEqual(["Foreword"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the vault's catch-up failed: the vault's catch-up answered 500/));
    warn.mockRestore();
  });
  it("does nothing while a run is in progress", async () => {
    const e = engine([t({ id: "stuck", status: "IN_PROGRESS", updatedAt: "2026-10-08T10:05:00.000Z" })], "RUNNING");
    expect(await repairQueue(deps(e.fetchImpl), "vault1", "wf-1")).toEqual({ requeued: [], dropped: [], skipped: "a run is in progress" });
    expect(e.calls.some((c) => c.query.includes("execute("))).toBe(false);
  });
  it("writes nothing when there is nothing to repair", async () => {
    const e = engine([t({ id: "fine" })]);
    expect(await repairQueue(deps(e.fetchImpl), "vault1", "wf-1")).toEqual({ requeued: [], dropped: [] });
    expect(e.calls.some((c) => c.query.includes("execute("))).toBe(false);
  });

  it("on start-up, a run that began before the engine did is not in progress, held tasks are queued again, and a source marked extracted without claims is reopened and queued", async () => {
    const e = engine([t({ id: "cut", status: "IN_PROGRESS", currentPhase: "reflect", handoffs: [{}], updatedAt: "2026-10-08T10:29:00.000Z" })], "RUNNING", "EXTRACTED");
    const r = await repairQueue(deps(e.fetchImpl), "vault1", "wf-1", { startup: true, engineStartedAt: "2026-10-08T10:25:00.000Z" });
    expect(r).toEqual({ requeued: ["Foreword"], dropped: [], reopened: ["Foreword"], queued: [] });
    const execs = e.calls.filter((c) => c.query.includes("execute("));
    expect(execs.map((c) => c.variables.id)).toEqual(["src1", "q1"]); // the source first, then the queue
    const sourceOps = (execs[0]!.variables.a as Array<{ type: string; input: unknown }>).map((a) => a.type);
    expect(sourceOps).toEqual(["SET_SOURCE_STATUS"]);
  });
  it("on start-up, a source waiting with no task at all gets one", async () => {
    const e = engine([], "SUCCEEDED", "EXTRACTING");
    const r = await repairQueue(deps(e.fetchImpl), "vault1", "wf-1", { startup: true, engineStartedAt: "2026-10-08T10:25:00.000Z" });
    expect(r).toEqual({ requeued: [], dropped: [], reopened: [], queued: ["Foreword"] });
    const exec = e.calls.find((c) => c.query.includes("execute("))!;
    expect((exec.variables.a as Array<{ type: string; input: { documentRef?: string } }>).map((a) => [a.type, a.input.documentRef])).toEqual([["ADD_TASK", "src1"]]);
  });
  it("outside start-up, a run that began before the engine did still counts as in progress only if it is newer than the engine", async () => {
    const e = engine([t({ id: "stuck", status: "IN_PROGRESS", updatedAt: "2026-10-08T10:05:00.000Z" })], "RUNNING");
    expect((await repairQueue(deps(e.fetchImpl), "vault1", "wf-1", { engineStartedAt: "2026-10-08T10:25:00.000Z" })).requeued).toEqual(["Foreword"]);
    expect((await repairQueue(deps(e.fetchImpl), "vault1", "wf-1", { engineStartedAt: "2026-10-08T10:15:00.000Z" })).skipped).toBe("a run is in progress");
  });
});
