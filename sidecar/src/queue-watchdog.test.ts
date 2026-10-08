import { describe, expect, it, vi } from "vitest";
import { planRepairs, repairQueue, type QueueTask } from "./queue-watchdog.js";

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
  it("ignores finished tasks and other task types", () => {
    expect(planRepairs([t({ status: "DONE", documentRef: "deleted" }), t({ status: "FAILED" }), t({ taskType: "enrichment", documentRef: "deleted" })], sources, NOW)).toEqual([]);
  });
});

describe("repairQueue", () => {
  function engine(tasks: QueueTask[], runStatus = "SUCCEEDED") {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      calls.push(body);
      if (body.query.includes("runsPage")) return { ok: true, json: async () => ({ data: { workflowRuntime: { runsPage: { items: [{ status: runStatus }] } } } }) };
      if (body.query.includes("document { state }") && body.variables.id === "vault1") return { ok: true, json: async () => ({ data: { document: { document: { state: { global: { nodes: [{ id: "q1", documentType: "bai/pipeline-queue" }, { id: "src1", documentType: "bai/source" }] } } } } } }) };
      if (body.query.includes("document { state }") && body.variables.id === "q1") return { ok: true, json: async () => ({ data: { document: { document: { state: { global: { tasks } } } } } }) };
      if (body.query.includes("execute(")) return { ok: true, json: async () => ({ data: { execute: { id: "q1" } } }) };
      if (body.query.includes("operations(")) {
        // as many applied operations as the last execute sent, none rejected
        const last = [...calls].reverse().find((c) => c.query.includes("execute("));
        const sent = (last?.variables.a as Array<{ type: string }>) ?? [];
        return { ok: true, json: async () => ({ data: { document: { document: { operations: { items: sent.map((a, index) => ({ index, error: null, action: { type: a.type } })), hash: "" } } } } }) };
      }
      throw new Error(`unexpected query: ${body.query}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
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
});
