import { describe, expect, it, vi } from "vitest";
import { createDocument, deleteDocument, execute, toActions } from "./reactor-gql.js";

const ORIGIN = "http://127.0.0.1:4201";
type Call = { query: string; variables: Record<string, unknown> };
type Op = { index: number; scope: "document" | "global"; error: string | null; action: { id: string; type: string } };
/**
 * A reactor like the installed one. A fresh document already holds CREATE_DOCUMENT and UPGRADE_DOCUMENT in the
 * `document` scope, with their own index sequence. Executed actions land in `global` with theirs. A rejected action is
 * recorded with its error, and the rest of the batch still applies. `operations()` answers every scope unless
 * `filter: { scopes: […] }` narrows it, from `$since` on when given, and at most `paging.limit` items.
 * `history` gives a document that many earlier global operations. `writeAfter` has another writer add a failed
 * operation right after each batch, as the runtime records runs on a workflow. `states` answers `document { state }`.
 */
export function fakeReactor(opts: { rejectType?: string; rejectWith?: string; history?: number; writeAfter?: string; states?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const ops = new Map<string, Op[]>();
  let n = 0;
  const opsOf = (id: string): Op[] => {
    let list = ops.get(id);
    if (!list) {
      list = Array.from({ length: opts.history ?? 0 }, (_, i): Op => ({ index: i, scope: "global", error: null, action: { id: `earlier-${i}`, type: "SET_WORKFLOW_NAME" } }));
      ops.set(id, list);
    }
    return list;
  };
  const globalCount = (id: string) => opsOf(id).filter((o) => o.scope === "global").length;
  const reply = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    const q = body.query;
    const ns = /(Connection|Workflow)\s*\{/.exec(q)?.[1];
    if (q.includes("createDocument") && ns) {
      const id = `doc${++n}`;
      ops.set(id, [
        { index: 0, scope: "document", error: null, action: { id: `create-${id}`, type: "CREATE_DOCUMENT" } },
        { index: 1, scope: "document", error: null, action: { id: `upgrade-${id}`, type: "UPGRADE_DOCUMENT" } },
      ]);
      return reply({ [ns]: { createDocument: { id } } });
    }
    if (q.includes("execute(")) {
      const id = body.variables.id as string;
      const list = opsOf(id);
      for (const a of body.variables.a as Array<{ id: string; type: string }>) list.push({ index: globalCount(id), scope: "global", error: a.type === opts.rejectType ? (opts.rejectWith ?? "rejected") : null, action: { id: a.id, type: a.type } });
      if (opts.writeAfter) list.push({ index: globalCount(id), scope: "global", error: "another writer's failure", action: { id: `other-${list.length}`, type: opts.writeAfter } });
      return reply({ execute: { id } });
    }
    if (q.includes("revisionsList")) {
      const id = body.variables.id as string;
      return reply({ document: { document: { revisionsList: [{ scope: "document", revision: opsOf(id).filter((o) => o.scope === "document").length }, { scope: "global", revision: globalCount(id) }] } } });
    }
    if (q.includes("operations(")) {
      const id = body.variables.id as string;
      const scoped = /scopes:\s*\[\s*"global"\s*\]/.test(q) ? opsOf(id).filter((o) => o.scope === "global") : opsOf(id);
      const since = typeof body.variables.since === "number" ? body.variables.since : 0;
      const limit = Number(/limit:\s*(\d+)/.exec(q)?.[1] ?? Infinity);
      const items = [...scoped].filter((o) => o.index >= since).sort((a, b) => a.index - b.index).slice(0, limit).map(({ index, error, action }) => ({ index, error, action }));
      return reply({ document: { document: { operations: { items, hasNextPage: false, cursor: null } } } });
    }
    if (q.includes("document { state }")) return reply({ document: { document: { state: { global: opts.states?.[body.variables.id as string] ?? {} } } } });
    if (q.includes("deleteDocument")) return reply({ deleteDocument: true });
    throw new Error(`unexpected query: ${q}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, ops };
}

describe("reactor-gql", () => {
  it("creates a document through the model's namespace and returns its id", async () => {
    const { fetchImpl, calls } = fakeReactor();
    expect(await createDocument(ORIGIN, "powerhouse/connection", "Research — Knowledge Vault", "wfdrive", fetchImpl)).toBe("doc1");
    expect(calls[0]!.query).toMatch(/Connection\s*\{\s*createDocument\(name: \$name, parentIdOrSlug: \$parent\)\s*\{\s*id\s*\}/);
    expect(calls[0]!.variables).toEqual({ name: "Research — Knowledge Vault", parent: "wfdrive" });
    await expect(createDocument(ORIGIN, "bai/unknown", "x", "w", fetchImpl)).rejects.toThrow(/bai\/unknown/);
  });
  it("turns template operations into actions the reactor accepts", () => {
    const actions = toActions([{ type: "SET_CONFIG", input: { config: { a: 1 } } }], () => "2026-10-07T10:00:00.000Z");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "SET_CONFIG", input: { config: { a: 1 } }, scope: "global", timestampUtcMs: "2026-10-07T10:00:00.000Z" });
    expect(actions[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("reads back only the global scope, so a rejected FIRST operation is seen and named", async () => {
    const ok = fakeReactor();
    const id = await createDocument(ORIGIN, "powerhouse/workflow", "W", "d", ok.fetchImpl);
    await execute(ORIGIN, id, toActions([{ type: "SET_WORKFLOW_NAME", input: { name: "W" } }, { type: "PUBLISH_WORKFLOW", input: {} }]), ok.fetchImpl);
    const readBack = ok.calls.find((c) => c.query.includes("operations("))!;
    expect(readBack.query).toMatch(/filter:\s*\{\s*scopes:\s*\["global"\]/);
    // the document scope's two operations must not be mistaken for the batch
    const bad = fakeReactor({ rejectType: "SET_WORKFLOW_NAME", rejectWith: "Name is empty" });
    const id2 = await createDocument(ORIGIN, "powerhouse/workflow", "W", "d", bad.fetchImpl);
    await expect(execute(ORIGIN, id2, toActions([{ type: "SET_WORKFLOW_NAME", input: { name: "" } }, { type: "PUBLISH_WORKFLOW", input: {} }]), bad.fetchImpl)).rejects.toThrow(/SET_WORKFLOW_NAME.*Name is empty/);
    const later = fakeReactor({ rejectType: "PUBLISH_WORKFLOW", rejectWith: "Workflow has no steps" });
    const id3 = await createDocument(ORIGIN, "powerhouse/workflow", "W", "d", later.fetchImpl);
    await expect(execute(ORIGIN, id3, toActions([{ type: "SET_WORKFLOW_NAME", input: { name: "W" } }, { type: "PUBLISH_WORKFLOW", input: {} }]), later.fetchImpl)).rejects.toThrow(/PUBLISH_WORKFLOW.*Workflow has no steps/);
  });
  it("reads back only what was written after the revision it read first, matched to the batch by action id", async () => {
    // 600 earlier operations: a read of the first 500 would never reach the batch, and its rejection would go unseen
    const long = fakeReactor({ history: 600, rejectType: "ADD_STEP", rejectWith: "A step with this id already exists" });
    await expect(execute(ORIGIN, "wf", toActions([{ type: "REMOVE_STEP", input: { id: "s1" } }, { type: "ADD_STEP", input: { id: "s1" } }]), long.fetchImpl)).rejects.toThrow(/ADD_STEP.*already exists/);
    const readBack = long.calls.find((c) => c.query.includes("operations("))!;
    expect(readBack.query).toMatch(/sinceRevision:\s*\$since/);
    expect(readBack.variables).toEqual({ id: "wf", since: 600 });
    // the revision is read before the write
    const revisionRead = long.calls.findIndex((c) => c.query.includes("revisionsList"));
    expect(revisionRead).toBeGreaterThanOrEqual(0);
    expect(revisionRead).toBeLessThan(long.calls.findIndex((c) => c.query.includes("execute(")));
    // another writer's operation after the batch (the runtime records each run on its workflow) is not taken for one of ours
    const busy = fakeReactor({ writeAfter: "SET_LAST_RUN" });
    await expect(execute(ORIGIN, "wf", toActions([{ type: "SET_WORKFLOW_NAME", input: { name: "W" } }]), busy.fetchImpl)).resolves.toBeUndefined();
  });
  it("deletes a document", async () => {
    const { fetchImpl, calls } = fakeReactor();
    await deleteDocument(ORIGIN, "doc9", fetchImpl);
    expect(calls[0]!.query).toContain("deleteDocument(idOrSlug: $id");
    expect(calls[0]!.variables).toEqual({ id: "doc9" });
  });
});
