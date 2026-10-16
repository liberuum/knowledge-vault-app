import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPipelineManager, documentGone, readPipelines, templateDigest, templatePolicy, templatePollSeconds, workflowDigest, writePipelines, type PipelineManagerDeps, type PipelineRecord } from "./pipelines.js";
import type { PipelineTemplate, WorkflowTemplate } from "./templates.js";

const template = { version: 1, exportedAt: "x", placeholders: [], connection: { documentType: "powerhouse/connection", operations: [] }, workflow: { documentType: "powerhouse/workflow", operations: [] } } as unknown as PipelineTemplate;
const reweaveTemplate = { version: 1, exportedAt: "x", placeholders: [], workflow: { documentType: "powerhouse/workflow", operations: [{ type: "SET_WORKFLOW_NAME", input: { name: "{{WORKFLOW_NAME}}" } }] } } as unknown as WorkflowTemplate;
/** The batches written to one document, in order. */
const batches = (calls: Call[], id: string) => calls.filter((c) => c.query.includes("execute(") && c.variables.id === id).map((c) => c.variables.a as Array<{ type: string; input: unknown }>);
type Call = { query: string; variables: Record<string, unknown> };

/** The engine's GraphQL as the manager sees it: secrets, documents and their operations, trigger states, runs. */
function fakeEngine(triggers: Array<{ workflowId: string; status: string }> = []) {
  const calls: Call[] = [];
  let secrets = 0;
  const connectionConfig: Record<string, unknown> = { base_url: "http://127.0.0.1:4201", llm_base_url: "https://openrouter.ai/api/v1", llm_default_model: "openai/gpt-6-luna", llm_api_key: "secret://v1:2" };
  /** Documents whose writes (`execute`) the engine refuses, the way it answers a refused request: a GraphQL `errors` array. */
  const failExecuteFor = new Set<string>();
  /** Operation types a reducer rejects: the operation is recorded with its error and the rest of the batch still applies, as in the reactor. */
  const rejectTypes = new Set<string>();
  /** A document's global state by id; any other answers as a connection holding `connectionConfig`. */
  const states: Record<string, Record<string, unknown>> = {};
  /** Documents deleted in Studio: reading one gets the reactor's "not found". */
  const gone = new Set<string>();
  /** Documents the engine cannot read just now. */
  const unreadable = new Set<string>();
  const ops = new Map<string, Array<{ index: number; error: string | null; action: { id: string; type: string } }>>();
  const reply = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
  const refuse = (message: string) => ({ ok: true, json: async () => ({ errors: [{ message }] }) });
  const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    const q = body.query;
    const id = String(body.variables.id);
    if (q.includes("createSecret")) return reply({ workflowRuntime: { createSecret: { ref: `secret://v1:${++secrets}` } } });
    if (q.includes("deleteSecret")) return reply({ workflowRuntime: { deleteSecret: true } });
    if (q.includes("deleteDocument")) return reply({ deleteDocument: true });
    if (q.includes("createDocument")) return reply({ Connection: { createDocument: { id: "conn-new" } } });
    if (q.includes("execute(")) {
      if (failExecuteFor.has(id)) return refuse(`the engine refused the write to ${id}`);
      const list = ops.get(id) ?? [];
      for (const a of body.variables.a as Array<{ id: string; type: string }>) list.push({ index: list.length, error: rejectTypes.has(a.type) ? `${a.type} refused` : null, action: { id: a.id, type: a.type } });
      ops.set(id, list);
      return reply({ execute: { id } });
    }
    if (q.includes("revisionsList")) return reply({ document: { document: { revisionsList: [{ scope: "global", revision: (ops.get(id) ?? []).length }] } } });
    if (q.includes("operations(")) return reply({ document: { document: { operations: { items: (ops.get(id) ?? []).filter((o) => o.index >= Number(body.variables.since ?? 0)), hasNextPage: false, cursor: null } } } });
    if (q.includes("document { state }")) {
      if (gone.has(id)) return refuse(`Failed to fetch document: Document ${id} not found`);
      if (unreadable.has(id)) return refuse("connect ECONNREFUSED 127.0.0.1:4201");
      return reply({ document: { document: { state: { global: states[id] ?? { config: connectionConfig } } } } });
    }
    if (q.includes("triggerStates")) {
      return reply({ workflowRuntime: { triggerStates: triggers.map((t) => ({ ...t, lastPollAt: "2026-10-07T10:00:00.000Z", lastError: null })), runsPage: { items: [{ id: `run-${body.variables.w}`, status: "FAILED", startedAt: "2026-10-07T09:59:00.000Z", endedAt: "2026-10-07T09:59:30.000Z", error: "no model here" }] } } });
    }
    throw new Error(`unexpected query: ${q}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, connectionConfig, failExecuteFor, rejectTypes, states, gone, unreadable };
}
function deps(over: Partial<PipelineManagerDeps> & { hasKey?: boolean; signedIn?: boolean; model?: string; endpoint?: string; triggers?: Array<{ workflowId: string; status: string }> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "kv-pipelines-"));
  const engine = fakeEngine(over.triggers);
  const instantiate = vi.fn(async () => ({ workflowId: "wf-1", connectionId: "conn-1" }));
  const hasKey = over.hasKey ?? true;
  const d: PipelineManagerDeps = {
    dataDir,
    origin: "http://127.0.0.1:4201",
    fetchImpl: engine.fetchImpl,
    template,
    gateway: { url: () => "http://127.0.0.1:4202/llm/v1", key: "gw-key" },
    pieceVersion: "1.0.54-dev.23",
    readSettings: () => ({ version: 1, models: { endpoint: over.endpoint ?? "https://openrouter.ai/api/v1", model: over.model ?? "openai/gpt-6-luna", hasKey, local: (over.endpoint ?? "").startsWith("http://127.") }, conversion: { mode: "local", remoteUrl: "" } }),
    readModelKey: () => (hasKey ? "sk-or-secret" : undefined),
    identity: {
      status: async () => ({ authenticated: over.signedIn ?? true }),
      token: async (expiresIn: number) => ({ token: `jwt-${expiresIn}` }),
    },
    workflowsDrive: async () => ({ id: "wfdrive" }),
    vaultName: async (id: string) => (id === "vault1" ? "Research" : "Team wiki"),
    instantiate,
    now: () => "2026-10-07T10:00:00.000Z",
    ...over,
  };
  return { d, dataDir, engine, instantiate, manager: createPipelineManager(d) };
}

describe("pipeline records", () => {
  it("round-trip through pipelines.json in the data dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "kv-pipelines-"));
    expect(readPipelines(dir)).toEqual({});
    writePipelines(dir, { vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" }, createdAt: "2026-10-07T10:00:00.000Z" } });
    expect(readPipelines(dir).vault1?.workflowId).toBe("wf-1");
  });
});

describe("pipeline manager — ensure", () => {
  it("sets up a pipeline for a model on this computer without a key — its connection gets a placeholder the server ignores", async () => {
    const { manager, engine, instantiate } = deps({ hasKey: false, endpoint: "http://127.0.0.1:8080/v1", model: "lfm2.5-8b-a1b" });
    expect((await manager.ensure("vault1")).state).toBe("ready");
    const secrets = engine.calls.filter((c) => c.query.includes("createSecret")).map((c) => c.variables.v);
    expect(secrets[1]).toBe("gw-key"); // the pipeline holds the gateway key; the gateway supplies the local placeholder
    expect(instantiate).toHaveBeenCalledWith(expect.objectContaining({ llm: { baseUrl: "http://127.0.0.1:4202/llm/v1", model: "lfm2.5-8b-a1b" } }));
  });
  it("does nothing without a model key: unconfigured, and the engine is never asked", async () => {
    const { manager, engine, instantiate } = deps({ hasKey: false });
    expect(await manager.ensure("vault1")).toEqual({ state: "unconfigured" });
    expect(engine.calls).toEqual([]);
    expect(instantiate).not.toHaveBeenCalled();
  });
  it("stores the engine token (90 days, minted by the identity) and the model key as runtime secrets, instantiates the template, and records the pipeline", async () => {
    const { manager, engine, instantiate, dataDir } = deps();
    expect(await manager.ensure("vault1")).toEqual({ state: "ready", workflowId: "wf-1", connectionId: "conn-1" });
    const secrets = engine.calls.filter((c) => c.query.includes("createSecret")).map((c) => c.variables);
    expect(secrets).toEqual([
      { v: `jwt-${90 * 86_400}`, l: "Research — engine token" },
      { v: "gw-key", l: "Research — model gateway key" },
    ]);
    expect(instantiate).toHaveBeenCalledWith(expect.objectContaining({
      origin: "http://127.0.0.1:4201",
      vaultName: "Research",
      driveId: "vault1",
      workflowsDriveId: "wfdrive",
      secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" },
      llm: { baseUrl: "http://127.0.0.1:4202/llm/v1", model: "openai/gpt-6-luna" },
      pieceVersion: "1.0.54-dev.23",
    }));
    expect(readPipelines(dataDir).vault1).toEqual({ workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" }, createdAt: "2026-10-07T10:00:00.000Z", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" } , modelFromConnection: true, templateDigest: templateDigest(template), gatewayKeyed: true });
  });
  it("uses a placeholder token for an open engine with nobody signed in — the engine ignores bearers there", async () => {
    const { manager, engine } = deps({ signedIn: false });
    await manager.ensure("vault1");
    expect(engine.calls.find((c) => c.query.includes("createSecret"))!.variables.v).toBe("open");
  });
  it("an Update of a pipeline whose workflow was deleted in Studio creates it anew, removing what was left first", async () => {
    const { manager, engine, instantiate } = deps();
    await manager.ensure("vault1");
    engine.gone.add("wf-1");
    await manager.ensure("vault1");
    expect(instantiate).toHaveBeenCalledTimes(2);
    expect(engine.calls.filter((c) => c.query.includes("deleteDocument")).map((c) => c.variables.id).sort()).toEqual(["conn-1", "wf-1"]);
    expect(engine.calls.filter((c) => c.query.includes("deleteSecret")).map((c) => c.variables.ref).sort()).toEqual(["secret://v1:1", "secret://v1:2"]);
  });
});

describe("pipeline manager — Update in place", () => {
  afterEach(() => vi.restoreAllMocks());
  /** A template with what an Update replays: the connection's name, config and secrets; the workflow's trigger, step, edge and policy. */
  const inPlace = {
    version: 1,
    exportedAt: "x",
    placeholders: [],
    connection: {
      documentType: "powerhouse/connection",
      operations: [
        { type: "SET_CONNECTION_NAME", input: { name: "{{CONNECTION_NAME}}" } },
        { type: "SET_CONFIG", input: { config: { base_url: "{{SWITCHBOARD_ORIGIN}}", llm_default_model: "{{LLM_MODEL}}", llm_base_url: "{{LLM_BASE_URL}}" } } },
        { type: "SET_SECRET_REF", input: { id: "tok", ref: "{{TOKEN_SECRET_REF}}", name: "token" } },
        { type: "SET_SECRET_REF", input: { id: "llm", ref: "{{LLM_SECRET_REF}}", name: "llm_api_key" } },
      ],
    },
    workflow: {
      documentType: "powerhouse/workflow",
      operations: [
        { type: "SET_WORKFLOW_NAME", input: { name: "{{WORKFLOW_NAME}}" } },
        { type: "SET_TRIGGER", input: { id: "trig", config: { drive: "{{DRIVE_ID}}" }, connectionId: "{{CONNECTION_ID}}" } },
        { type: "ADD_STEP", input: { id: "s1", config: { model: "{{LLM_MODEL}}" }, connectionId: "{{CONNECTION_ID}}" } },
        { type: "ADD_EDGE", input: { id: "e1", from: "trig", to: "s1", port: "next" } },
        { type: "SET_POLICY", input: { concurrency: "PARALLEL" } },
        { type: "PUBLISH_WORKFLOW", input: { publishedAt: "{{NOW}}" } },
        { type: "SET_WORKFLOW_STATUS", input: { status: "ENABLED" } },
      ],
    },
  } as unknown as PipelineTemplate;
  /** The pipeline's workflow as it runs: published, with the template's step and edge. */
  const running = { status: "ENABLED", steps: [{ id: "s1" }], edges: [{ id: "e1" }], published: { version: 3 } };
  const editTypes = ["REMOVE_EDGE", "REMOVE_STEP", "SET_WORKFLOW_NAME", "SET_TRIGGER", "ADD_STEP", "ADD_EDGE", "SET_POLICY"];
  const deletedSecrets = (calls: Call[]) => calls.filter((c) => c.query.includes("deleteSecret")).map((c) => c.variables.ref);

  it("keeps the workflow, its id and its connection: new secrets first, the workflow edited then published, the connection, the record, the old secrets last", async () => {
    const h = deps({ template: inPlace });
    await h.manager.ensure("vault1");
    h.engine.states["wf-1"] = { ...running, steps: [{ id: "s1" }, { id: "s-studio" }] };
    const order: string[] = [];
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { query, variables } = JSON.parse(String(init?.body)) as Call;
      if (query.includes("createSecret")) order.push("create a secret");
      else if (query.includes("execute(")) order.push(`write ${String(variables.id)}`);
      else if (query.includes("deleteSecret")) order.push(`delete ${String(variables.ref)} (the record holds ${readPipelines(h.dataDir).vault1?.secretRefs.token})`);
      return h.d.fetchImpl(url, init);
    }) as unknown as typeof fetch;

    expect(await createPipelineManager({ ...h.d, fetchImpl }).ensure("vault1")).toEqual({ state: "ready", workflowId: "wf-1", connectionId: "conn-1" });
    expect(order).toEqual([
      "create a secret",
      "create a secret",
      "write wf-1",
      "write wf-1",
      "write conn-1",
      "delete secret://v1:1 (the record holds secret://v1:3)",
      "delete secret://v1:2 (the record holds secret://v1:3)",
    ]);
    expect(h.instantiate).toHaveBeenCalledTimes(1); // the first setup only
    expect(h.engine.calls.filter((c) => c.query.includes("deleteDocument"))).toEqual([]);

    const [edits, publish] = batches(h.engine.calls, "wf-1");
    expect(edits!.map((a) => a.type)).toEqual(["REMOVE_EDGE", "REMOVE_STEP", "REMOVE_STEP", "SET_WORKFLOW_NAME", "SET_TRIGGER", "ADD_STEP", "ADD_EDGE", "SET_POLICY"]);
    expect(edits!.find((a) => a.type === "SET_TRIGGER")!.input).toEqual({ id: "trig", config: { drive: "vault1" }, connectionId: "conn-1" });
    expect(edits!.find((a) => a.type === "ADD_STEP")!.input).toEqual({ id: "s1", config: { model: "" }, connectionId: "conn-1" });
    expect(publish!.map((a) => [a.type, a.input])).toEqual([["PUBLISH_WORKFLOW", { publishedAt: "2026-10-07T10:00:00.000Z" }], ["SET_WORKFLOW_STATUS", { status: "ENABLED" }]]);

    const connection = batches(h.engine.calls, "conn-1").at(-1)!;
    expect(connection.map((a) => a.type)).toEqual(["SET_CONNECTION_NAME", "SET_CONFIG", "SET_SECRET_REF", "SET_SECRET_REF"]);
    expect(connection[1]!.input).toEqual({ config: { base_url: "http://127.0.0.1:4201", llm_default_model: "openai/gpt-6-luna", llm_base_url: "http://127.0.0.1:4202/llm/v1", llm_locality: "hosted" } });
    expect(connection.slice(2).map((a) => a.input)).toEqual([{ id: "tok", ref: "secret://v1:3", name: "token" }, { id: "llm", ref: "secret://v1:4", name: "llm_api_key" }]);

    expect(readPipelines(h.dataDir).vault1).toEqual({
      workflowId: "wf-1",
      connectionId: "conn-1",
      secretRefs: { token: "secret://v1:3", llm: "secret://v1:4" },
      createdAt: "2026-10-07T10:00:00.000Z",
      models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" },
      token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" },
      modelFromConnection: true,
      templateDigest: templateDigest(inPlace),
      gatewayKeyed: true,
    });
  });

  it("a rejected workflow edit puts the workflow back as last published, never publishes, and leaves the record and the old secrets", async () => {
    const h = deps({ template: inPlace });
    await h.manager.ensure("vault1");
    const before = readPipelines(h.dataDir).vault1;
    h.engine.states["wf-1"] = running;
    h.engine.rejectTypes.add("ADD_EDGE");
    await expect(h.manager.ensure("vault1")).rejects.toThrow(/ADD_EDGE was rejected/);
    expect(batches(h.engine.calls, "wf-1").map((b) => b.map((a) => a.type))).toEqual([editTypes, ["REVERT_TO_PUBLISHED"]]);
    expect(batches(h.engine.calls, "conn-1")).toHaveLength(1); // the first setup's model write only
    expect(readPipelines(h.dataDir).vault1).toEqual(before);
    expect(deletedSecrets(h.engine.calls)).toEqual(["secret://v1:3", "secret://v1:4"]);
  });

  it("a rejected connection write points the connection back at the record's secrets before the new ones go; the record stays", async () => {
    const h = deps({ template: inPlace });
    await h.manager.ensure("vault1");
    const before = readPipelines(h.dataDir).vault1;
    h.engine.states["wf-1"] = running;
    h.engine.rejectTypes.add("SET_CONNECTION_NAME");
    await expect(h.manager.ensure("vault1")).rejects.toThrow(/SET_CONNECTION_NAME was rejected/);
    // the workflow already matches the template, and is published
    expect(batches(h.engine.calls, "wf-1").map((b) => b.map((a) => a.type))).toEqual([editTypes, ["PUBLISH_WORKFLOW", "SET_WORKFLOW_STATUS"]]);
    const restore = batches(h.engine.calls, "conn-1").at(-1)!;
    expect(restore.map((a) => [a.type, a.input])).toEqual([["SET_SECRET_REF", { id: "tok", ref: "secret://v1:1", name: "token" }], ["SET_SECRET_REF", { id: "llm", ref: "secret://v1:2", name: "llm_api_key" }]]);
    expect(deletedSecrets(h.engine.calls)).toEqual(["secret://v1:3", "secret://v1:4"]);
    expect(readPipelines(h.dataDir).vault1).toEqual(before);
  });

  it("a connection deleted in Studio is made again from the template, and the workflow is pointed at it", async () => {
    const h = deps({ template: inPlace });
    await h.manager.ensure("vault1");
    h.engine.states["wf-1"] = running;
    h.engine.gone.add("conn-1");
    expect(await h.manager.ensure("vault1")).toEqual({ state: "ready", workflowId: "wf-1", connectionId: "conn-new" });
    expect(h.engine.calls.find((c) => c.query.includes("createDocument"))!.variables).toEqual({ name: "Research — Knowledge Vault", parent: "wfdrive" });
    const [edits] = batches(h.engine.calls, "wf-1");
    expect(edits!.find((a) => a.type === "SET_TRIGGER")!.input).toMatchObject({ connectionId: "conn-new" });
    expect(readPipelines(h.dataDir).vault1).toMatchObject({ workflowId: "wf-1", connectionId: "conn-new", secretRefs: { token: "secret://v1:3", llm: "secret://v1:4" } });
  });

  it("brings the Reweave notes workflow along: switched on again when the app had switched it off", async () => {
    const instantiateReweave = vi.fn(async () => ({ workflowId: "rw-1" }));
    const h = deps({ template: inPlace, reweaveTemplate, instantiateReweave });
    await h.manager.ensure("vault1");
    await h.manager.disableAll("the model key was removed");
    h.engine.states["rw-1"] = { status: "DISABLED" };
    expect((await h.manager.ensure("vault1")).state).toBe("ready");
    expect(batches(h.engine.calls, "rw-1").at(-1)!.map((a) => [a.type, a.input])).toEqual([["PUBLISH_WORKFLOW", { publishedAt: "2026-10-07T10:00:00.000Z" }], ["SET_WORKFLOW_STATUS", { status: "ENABLED" }]]);
    const record = readPipelines(h.dataDir).vault1!;
    expect(record.disabled).toBeUndefined();
    expect(record.reweave).toEqual({ workflowId: "rw-1", digest: workflowDigest(reweaveTemplate) });
    expect(instantiateReweave).toHaveBeenCalledTimes(1);
  });

  /** One change at a time per vault: an engine that answers a tick later, so concurrent work overlaps if nothing serializes it. */
  const slow = (h: ReturnType<typeof deps>) =>
    (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      await new Promise((r) => setTimeout(r, 1));
      return h.d.fetchImpl(url, init);
    }) as unknown as typeof fetch;
  const existing = (workflowId: string, connectionId: string): PipelineRecord => ({ workflowId, connectionId, secretRefs: { token: `t-${workflowId}`, llm: `l-${workflowId}` }, createdAt: "2026-10-01T00:00:00.000Z" });

  it("an Update and the start-up Reweave upkeep, together, make one Reweave notes workflow, not two", async () => {
    let made = 0;
    const instantiateReweave = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 60)); // long enough for the Update to reach its own Reweave step meanwhile
      return { workflowId: `rw-${++made}` };
    });
    const h = deps({ template: inPlace, reweaveTemplate, instantiateReweave });
    writePipelines(h.dataDir, { vault1: existing("wf-1", "conn-1") });
    h.engine.states["wf-1"] = running;
    const manager = createPipelineManager({ ...h.d, fetchImpl: slow(h) });
    const [, ensured] = await Promise.all([manager.followReweave(), manager.ensure("vault1")]);
    expect(ensured).toEqual({ state: "ready", workflowId: "wf-1", connectionId: "conn-1" });
    expect(instantiateReweave).toHaveBeenCalledTimes(1);
    expect(readPipelines(h.dataDir).vault1?.reweave).toEqual({ workflowId: "rw-1", digest: workflowDigest(reweaveTemplate) });
  });

  it("two Updates of one vault, together, run one after the other: the workflow's edits never interleave", async () => {
    const h = deps({ template: inPlace });
    writePipelines(h.dataDir, { vault1: existing("wf-1", "conn-1") });
    h.engine.states["wf-1"] = running;
    const manager = createPipelineManager({ ...h.d, fetchImpl: slow(h) });
    const results = await Promise.all([manager.ensure("vault1"), manager.ensure("vault1")]);
    expect(results).toEqual([{ state: "ready", workflowId: "wf-1", connectionId: "conn-1" }, { state: "ready", workflowId: "wf-1", connectionId: "conn-1" }]);
    const publish = ["PUBLISH_WORKFLOW", "SET_WORKFLOW_STATUS"];
    expect(batches(h.engine.calls, "wf-1").map((b) => b.map((a) => a.type))).toEqual([editTypes, publish, editTypes, publish]);
    expect(readPipelines(h.dataDir).vault1?.workflowId).toBe("wf-1");
  });

  it("a removal issued while an Update of the same vault runs waits for it, and leaves no record", async () => {
    const h = deps({ template: inPlace });
    const manager = createPipelineManager({ ...h.d, fetchImpl: slow(h) });
    const ensuring = manager.ensure("vault1");
    const removing = manager.remove("vault1");
    await Promise.all([ensuring, removing]);
    expect(readPipelines(h.dataDir)).toEqual({});
    expect(h.engine.calls.filter((c) => c.query.includes("deleteDocument")).length).toBe(2);
  });

  it("two vaults' Updates still run at the same time: the lock is per vault", async () => {
    const h = deps({ template: inPlace });
    writePipelines(h.dataDir, { vault1: existing("wf-1", "conn-1"), vault2: existing("wf-2", "conn-2") });
    h.engine.states["wf-1"] = running;
    h.engine.states["wf-2"] = running;
    const manager = createPipelineManager({ ...h.d, fetchImpl: slow(h) });
    await Promise.all([manager.ensure("vault1"), manager.ensure("vault2")]);
    const of = (c: Call) => {
      const id = String(c.variables.id ?? c.variables.ref ?? c.variables.l ?? "");
      return /wf-1|conn-1|Research/.test(id) ? "vault1" : /wf-2|conn-2|Team wiki/.test(id) ? "vault2" : undefined;
    };
    const owners = h.engine.calls.map(of);
    expect(owners.indexOf("vault2")).toBeGreaterThan(-1);
    expect(owners.indexOf("vault2")).toBeLessThan(owners.lastIndexOf("vault1"));
  });
});

describe("pipeline manager — status and removal", () => {
  it("is unconfigured without a key, missing without a record, and otherwise this vault's trigger and its work only", async () => {
    const none = deps({ hasKey: false });
    expect(await none.manager.status("vault1")).toEqual({ state: "unconfigured" });
    const fresh = deps();
    expect(await fresh.manager.status("vault1")).toEqual({ state: "missing" });
    const two = deps({ triggers: [{ workflowId: "wf-1", status: "ENABLED" }, { workflowId: "wf-other", status: "DISABLED" }] });
    const models = { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" };
    const token = { kind: "minted" as const, expiresAt: "2027-01-05T10:00:00.000Z" };
    writePipelines(two.dataDir, {
      vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "s1", llm: "s2" }, createdAt: "x", models, token, templateDigest: templateDigest(template) },
      vault2: { workflowId: "wf-other", connectionId: "conn-2", secretRefs: { token: "s3", llm: "s4" }, createdAt: "x", models, token, templateDigest: templateDigest(template) },
    });
    // The fake's run failed with no task in its payload (a test run): it is not a current failure. Its drive has no queue: waiting is unknown.
    expect(await two.manager.status("vault1")).toEqual({
      state: "ready",
      workflowId: "wf-1",
      connectionId: "conn-1",
      trigger: { status: "ENABLED", lastPollAt: "2026-10-07T10:00:00.000Z", lastError: null },
      running: 0,
      waiting: null,
      failures: [],
      hasRuns: true,
    });
    expect((await two.manager.status("vault2")).state === "ready" && (await two.manager.status("vault2") as { trigger?: { status: string } }).trigger?.status).toBe("DISABLED");
  });
  it("removal deletes the documents, the secrets and the record, and tolerates a vault without a pipeline", async () => {
    const { manager, engine, dataDir } = deps();
    await manager.ensure("vault1");
    await manager.remove("vault1");
    expect(engine.calls.filter((c) => c.query.includes("deleteDocument")).length).toBe(2);
    expect(engine.calls.filter((c) => c.query.includes("deleteSecret")).length).toBe(2);
    expect(readPipelines(dataDir)).toEqual({});
    await manager.remove("nobody"); // no throw
  });
});

describe("pipeline manager — status reads the work, not the last run", () => {
  type Run = { id: string; status: string; startedAt: string | null; endedAt: string | null; error: string | null; triggerPayload?: unknown };
  const ENGINE_UP = "2026-10-07T09:00:00.000Z";
  /** A pipeline run as the runtime lists it; `task` gives it the trigger's payload (the queue task and its source). */
  const run = (id: string, status: string, task?: string, over: Partial<Run> = {}): Run => ({
    id,
    status,
    startedAt: "2026-10-07T09:50:00.000Z",
    endedAt: status === "FAILED" || status === "SUCCEEDED" ? "2026-10-07T09:55:00.000Z" : null,
    error: status === "FAILED" ? "boom" : null,
    ...(task ? { triggerPayload: { task_id: task, source_id: `src-${task}`, source_title: `Source ${task}`, phase: "extract", queued_at: null } } : {}),
    ...over,
  });
  /** The engine as status() reads it: the runs, the vault's drive (to find its queue), and the queue's typed reads. */
  function workEngine(opts: { runs: Run[]; activeCount?: number; tasks?: Array<{ id: string; status: string }>; queueUnreadable?: boolean; noQueue?: boolean }) {
    const queries: string[] = [];
    const answer = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
    const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      const q = (JSON.parse(String(init?.body)) as Call).query;
      queries.push(q);
      if (q.includes("triggerStates")) return answer({ workflowRuntime: { triggerStates: [{ workflowId: "wf-1", status: "ENABLED", lastPollAt: null, lastError: null }], runsPage: { items: opts.runs } } });
      if (q.includes("PipelineQueue")) {
        if (opts.queueUnreadable) return { ok: true, json: async () => ({ errors: [{ message: "Document queue-1 not found" }] }) };
        const global = q.includes("activeCount") ? { activeCount: opts.activeCount ?? 0 } : { tasks: opts.tasks ?? [] };
        return answer({ PipelineQueue: { document: { document: { state: { global } } } } });
      }
      if (q.includes("document { state }")) {
        const nodes = opts.noQueue ? [] : [{ id: "queue-1", documentType: "bai/pipeline-queue" }, { id: "src-t1", documentType: "bai/source" }];
        return answer({ document: { document: { state: { global: { nodes } } } } });
      }
      throw new Error(`unexpected query: ${q}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, queries };
  }
  function setUp(opts: Parameters<typeof workEngine>[0]) {
    const engine = workEngine(opts);
    const h = deps({ fetchImpl: engine.fetchImpl, engineStartedAt: ENGINE_UP });
    writePipelines(h.dataDir, {
      vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "s1", llm: "s2" }, createdAt: "x", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" }, templateDigest: templateDigest(template) },
    });
    return { ...h, queries: engine.queries };
  }

  it("counts the runs in progress or queued in this engine, and the queue's open tasks with a typed read", async () => {
    const { manager, queries } = setUp({
      runs: [run("r4", "RUNNING", "t4"), run("r3", "PENDING", "t3"), run("r2", "RUNNING", "t2", { startedAt: "2026-10-07T08:00:00.000Z" }), run("r1", "SUCCEEDED", "t1")],
      activeCount: 869,
    });
    expect(await manager.status("vault1")).toEqual({
      state: "ready",
      workflowId: "wf-1",
      connectionId: "conn-1",
      trigger: { status: "ENABLED", lastPollAt: null, lastError: null },
      running: 2, // r2 began before this engine came up: it was cut off with the previous one
      waiting: 869,
      failures: [],
      hasRuns: true,
    });
    expect(queries.some((q) => q.includes("runsPage(workflowId: $w, paging: { limit: 20 })") && q.includes("triggerPayload"))).toBe(true);
    expect(queries.some((q) => q.includes("PipelineQueue { document(idOrSlug: $id) { document { state { global { activeCount } } } } }"))).toBe(true);
    expect(queries.some((q) => q.includes("tasks"))).toBe(false); // no failed run: the tasks are never read
  });

  it("a failed run counts while its task is still open: once per task, never after a later run of it, never without a task", async () => {
    const credit = "The model provider refused to ask openai/gpt-6-luna (402): insufficient credits";
    const { manager } = setUp({
      runs: [
        run("r6", "RUNNING", "t6"),
        run("s3", "SUCCEEDED", "t3"),
        run("f1-new", "FAILED", "t1", { error: credit }),
        run("manual", "FAILED"), // a test run from Workflow Studio carries no task
        run("f6", "FAILED", "t6"), // t6 is running again now
        run("f2", "FAILED", "t2"), // t2 is done
        run("f3", "FAILED", "t3"), // a later run of t3 succeeded
        run("f1-old", "FAILED", "t1"), // t1 counts once, as its newest failure
        run("f4", "FAILED", "t4", { startedAt: "2026-10-07T09:40:00.000Z", endedAt: null }),
      ],
      activeCount: 4,
      tasks: [
        { id: "t1", status: "IN_PROGRESS" },
        { id: "t2", status: "DONE" },
        { id: "t3", status: "PENDING" },
        { id: "t4", status: "BLOCKED" },
        { id: "t6", status: "IN_PROGRESS" },
      ],
    });
    const status = await manager.status("vault1");
    expect(status).toMatchObject({ state: "ready", running: 1, waiting: 4, hasRuns: true });
    expect(status.state === "ready" && status.failures).toEqual([
      { runId: "f1-new", source: "Source t1", at: "2026-10-07T09:55:00.000Z", error: credit, problem: { kind: "no-funds", message: "Your model provider refused the request: the account is out of credit.", model: "openai/gpt-6-luna" } },
      { runId: "f4", source: "Source t4", at: "2026-10-07T09:40:00.000Z", error: "boom" },
    ]);
  });

  it("keeps the five newest current failures", async () => {
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
    const { manager } = setUp({ runs: ids.map((t) => run(`f-${t}`, "FAILED", t)), activeCount: 7, tasks: ids.map((id) => ({ id, status: "PENDING" })) });
    const status = await manager.status("vault1");
    expect(status.state === "ready" && status.failures.map((f) => f.runId)).toEqual(["f-t1", "f-t2", "f-t3", "f-t4", "f-t5"]);
  });

  it("reads waiting as unknown when the queue cannot be read, and then keeps the failures it cannot check", async () => {
    const unreadable = setUp({ runs: [run("f1", "FAILED", "t1")], queueUnreadable: true });
    expect(await unreadable.manager.status("vault1")).toMatchObject({ waiting: null, failures: [{ runId: "f1", source: "Source t1" }] });
    const none = setUp({ runs: [], noQueue: true });
    expect(await none.manager.status("vault1")).toMatchObject({ running: 0, waiting: null, failures: [], hasRuns: false });
  });

  it("finds the vault's queue once and remembers it", async () => {
    const { manager, queries } = setUp({ runs: [], activeCount: 0 });
    expect(await manager.status("vault1")).toMatchObject({ waiting: 0, hasRuns: false });
    await manager.status("vault1");
    expect(queries.filter((q) => q.includes("document { state }")).length).toBe(1);
  });
});

describe("pipeline manager — lifecycle (review fixes)", () => {
  it("a failed instantiation deletes the two new secrets and leaves no record — status reads missing, never ready", async () => {
    const { manager, engine, dataDir } = deps({ instantiate: vi.fn(async () => { throw new Error("Operation SET_TRIGGER was rejected: drive unknown"); }) });
    await expect(manager.ensure("vault1")).rejects.toThrow(/SET_TRIGGER/);
    expect(engine.calls.filter((c) => c.query.includes("deleteDocument"))).toEqual([]); // instantiate removed its own; ensure never saw their ids
    expect(engine.calls.filter((c) => c.query.includes("deleteSecret")).map((c) => c.variables.ref).sort()).toEqual(["secret://v1:1", "secret://v1:2"]);
    expect(readPipelines(dataDir).vault1).toBeUndefined();
    expect(await manager.status("vault1")).toEqual({ state: "missing" });
  });
  it("a failure after the documents were made — the config write — deletes them too, with both secrets, and leaves no record", async () => {
    const { manager, engine, dataDir } = deps();
    engine.failExecuteFor.add("conn-1"); // the connection the fake instantiate returns: its config write is refused
    await expect(manager.ensure("vault1")).rejects.toThrow(/refused the write to conn-1/);
    expect(engine.calls.filter((c) => c.query.includes("deleteDocument")).map((c) => c.variables.id).sort()).toEqual(["conn-1", "wf-1"]);
    expect(engine.calls.filter((c) => c.query.includes("deleteSecret")).map((c) => c.variables.ref).sort()).toEqual(["secret://v1:1", "secret://v1:2"]);
    expect(readPipelines(dataDir).vault1).toBeUndefined();
    expect(await manager.status("vault1")).toEqual({ state: "missing" });
  });
  it("refuses on a protected engine when nobody is signed in — the pipeline would run as nobody", async () => {
    const { manager, engine } = deps({ engineProtected: true, signedIn: false });
    await expect(manager.ensure("vault1")).rejects.toThrow(/Sign in first/);
    expect(engine.calls).toEqual([]);
  });
  it("an empty model is unconfigured: the piece would refuse every run", async () => {
    const { manager } = deps({ model: "" });
    expect(await manager.ensure("vault1")).toEqual({ state: "unconfigured" });
    expect(await manager.status("vault1")).toEqual({ state: "unconfigured" });
  });
  it("records the model settings and the token, and reads stale when they no longer fit", async () => {
    const d = deps();
    await d.manager.ensure("vault1");
    const record = readPipelines(d.dataDir).vault1!;
    expect(record.models).toEqual({ endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" });
    expect(record.token.kind).toBe("minted");
    expect(new Date(record.token.expiresAt!).getTime() - Date.parse("2026-10-07T10:00:00.000Z")).toBe(90 * 86_400_000);
    // the model changed in Settings
    d.d.readSettings = () => ({ version: 1, models: { endpoint: "https://openrouter.ai/api/v1", model: "other/model", hasKey: true }, conversion: { mode: "local", remoteUrl: "" } });
    expect(await d.manager.status("vault1")).toMatchObject({ state: "stale", reason: expect.stringMatching(/model settings changed/) });
  });
  it("a pipeline set up on an open engine reads stale once the engine is protected; an expired token reads stale too", async () => {
    const open = deps({ signedIn: false });
    await open.manager.ensure("vault1");
    expect(readPipelines(open.dataDir).vault1!.token).toEqual({ kind: "open", expiresAt: null });
    open.d.engineProtected = true;
    expect(await open.manager.status("vault1")).toMatchObject({ state: "stale", reason: expect.stringMatching(/protected/) });
    const minted = deps();
    await minted.manager.ensure("vault1");
    minted.d.now = () => "2027-01-20T00:00:00.000Z"; // 105 days later
    expect(await minted.manager.status("vault1")).toMatchObject({ state: "stale", reason: expect.stringMatching(/expired/) });
  });
  it("removing the key disables every recorded pipeline, deletes the key secret and marks the records", async () => {
    const { manager, engine, dataDir } = deps();
    await manager.ensure("vault1");
    await manager.ensure("vault2");
    await manager.disableAll("the model key was removed");
    const disables = engine.calls.filter((c) => c.query.includes("execute(")).map((c) => (c.variables.a as Array<{ type: string; input: { status: string } }>)[0]!).filter((a) => a.type === "SET_WORKFLOW_STATUS");
    expect(disables.map((a) => [a.type, a.input.status])).toEqual([["SET_WORKFLOW_STATUS", "DISABLED"], ["SET_WORKFLOW_STATUS", "DISABLED"]]);
    expect(engine.calls.filter((c) => c.query.includes("deleteSecret")).length).toBe(2);
    const records = readPipelines(dataDir);
    expect(records.vault1!.disabled).toBe("the model key was removed");
    // with a key again, the record is stale (its secret is gone) and Update re-creates it
    expect(await manager.status("vault1")).toMatchObject({ state: "stale", reason: "the model key was removed" });
  });
});

describe("pipeline manager — the model settings changed", () => {
  it("rewrites the connection of a pipeline whose steps defer to it, keeping the other config keys, and sets an older one up again", async () => {
    const h = deps({ model: "anthropic/claude-sonnet-5.5" });
    writePipelines(h.dataDir, {
      vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" }, createdAt: "2026-10-07T10:00:00.000Z", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" }, modelFromConnection: true, templateDigest: templateDigest(template) },
      vault2: { workflowId: "wf-old", connectionId: "conn-old", secretRefs: { token: "secret://v1:3", llm: "secret://v1:4" }, createdAt: "2026-10-07T10:00:00.000Z", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" } },
      vault3: { workflowId: "wf-3", connectionId: "conn-3", secretRefs: { token: "secret://v1:5", llm: "secret://v1:6" }, createdAt: "2026-10-07T10:00:00.000Z", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" }, disabled: "the model key was removed" },
    });
    expect(await h.manager.applyModels()).toEqual({ updated: ["vault1"], recreated: ["vault2"] });
    const setConfig = h.engine.calls.find((c) => c.query.includes("execute(") && JSON.stringify(c.variables).includes("SET_CONFIG"));
    const action = (setConfig!.variables.a as Array<{ input: unknown }>)[0]!;
    expect(action.input).toEqual({ config: { base_url: "http://127.0.0.1:4201", llm_base_url: "http://127.0.0.1:4202/llm/v1", llm_default_model: "anthropic/claude-sonnet-5.5", llm_locality: "hosted", llm_api_key: "secret://v1:2" } });
    const records = readPipelines(h.dataDir);
    expect(records.vault1).toMatchObject({ workflowId: "wf-1", models: { model: "anthropic/claude-sonnet-5.5" } });
    expect(h.instantiate).not.toHaveBeenCalled(); // the older pipeline is brought to the template in place
    expect(records.vault2).toMatchObject({ workflowId: "wf-old", connectionId: "conn-old", modelFromConnection: true, models: { model: "anthropic/claude-sonnet-5.5" } });
    expect(records.vault3?.disabled).toBe("the model key was removed");
    // and status no longer reads stale
    expect((await h.manager.status("vault1")).state).toBe("ready");
  });

  it("does nothing while no model is configured", async () => {
    const h = deps({ hasKey: false });
    writePipelines(h.dataDir, { vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "a", llm: "b" }, createdAt: "x", models: { endpoint: "e", model: "m" }, token: { kind: "open", expiresAt: null }, modelFromConnection: true } });
    expect(await h.manager.applyModels()).toEqual({ updated: [], recreated: [] });
    expect(h.engine.calls).toEqual([]);
  });
});

describe("pipeline manager — a newer template", () => {
  it("marks a pipeline made from another template (or before templates were recorded) as needing an update", async () => {
    const h = deps();
    const base = { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "a", llm: "b" }, createdAt: "2026-10-07T10:00:00.000Z", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted" as const, expiresAt: "2027-01-05T10:00:00.000Z" }, modelFromConnection: true };
    writePipelines(h.dataDir, { vault1: { ...base, templateDigest: templateDigest(template) }, vault2: { ...base }, vault3: { ...base, templateDigest: "0000000000000000" } });
    expect((await h.manager.status("vault1")).state).toBe("ready");
    expect(await h.manager.status("vault2")).toMatchObject({ state: "stale", reason: "a newer version of the pipeline is available" });
    expect(await h.manager.status("vault3")).toMatchObject({ state: "stale", reason: "a newer version of the pipeline is available" });
  });
});

describe("pipelines and the model gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  const configWrites = (calls: Call[]) =>
    calls
      .filter((c) => c.query.includes("execute("))
      .flatMap((c) => (c.variables.a ?? []) as Array<{ type: string; input: { config?: Record<string, unknown> } }>)
      .filter((a) => a.type === "SET_CONFIG")
      .map((a) => a.input.config);
  const secretCalls = (calls: Call[], kind: "createSecret" | "deleteSecret") => calls.filter((c) => c.query.includes(kind));
  /** A pipeline recorded before the gateway: its connection's key is a secret holding the model key itself. */
  const older = (n: number): PipelineRecord => ({ workflowId: `wf-${n}`, connectionId: `conn-${n}`, secretRefs: { token: `secret://tok:vault${n}`, llm: `secret://old:vault${n}` }, createdAt: "x" }) as PipelineRecord;

  it("a new pipeline's connection points at the gateway with the gateway key and says where the model runs", async () => {
    const { manager, engine } = deps({ endpoint: "http://127.0.0.1:8084/v1" });
    await manager.ensure("vault1");
    const secretValues = engine.calls.filter((c) => c.query.includes("createSecret")).map((c) => c.variables.v);
    expect(secretValues).toContain("gw-key");
    expect(configWrites(engine.calls).at(-1)).toMatchObject({ llm_base_url: "http://127.0.0.1:4202/llm/v1", llm_locality: "local" });
  });

  it("follows a moved gateway", async () => {
    const { d, dataDir, engine } = deps({ gateway: { url: () => "http://127.0.0.1:4299/llm/v1", key: "gw-key" } });
    writePipelines(dataDir, { vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" }, createdAt: "x", gatewayKeyed: true } as never });
    expect(await createPipelineManager(d).followGateway()).toEqual({ moved: ["vault1"], failed: [] });
    expect(configWrites(engine.calls).at(-1)).toMatchObject({ llm_base_url: "http://127.0.0.1:4299/llm/v1", llm_api_key: "secret://v1:2" });
  });

  it("moves an older pipeline to the gateway and deletes its old key secret", async () => {
    const { d, dataDir, engine } = deps();
    writePipelines(dataDir, { vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" }, createdAt: "x" } as never });
    expect(await createPipelineManager(d).followGateway()).toEqual({ moved: ["vault1"], failed: [] });
    expect(engine.calls.filter((c) => c.query.includes("createSecret")).map((c) => c.variables.v)).toEqual(["gw-key"]);
    expect(engine.calls.filter((c) => c.query.includes("deleteSecret")).map((c) => c.variables.ref)).toEqual(["secret://v1:2"]);
    expect(configWrites(engine.calls).at(-1)).toMatchObject({ llm_base_url: "http://127.0.0.1:4202/llm/v1", llm_api_key: expect.stringMatching(/^secret:\/\/v1:/) });
    expect(readPipelines(dataDir).vault1).toMatchObject({ gatewayKeyed: true });
  });

  it("leaves a pipeline that already points at the gateway alone", async () => {
    const { d, dataDir, engine } = deps();
    engine.connectionConfig.llm_base_url = "http://127.0.0.1:4202/llm/v1";
    writePipelines(dataDir, { vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" }, createdAt: "x", gatewayKeyed: true } as never });
    expect(await createPipelineManager(d).followGateway()).toEqual({ moved: [], failed: [] });
    expect(secretCalls(engine.calls, "createSecret")).toEqual([]);
    expect(secretCalls(engine.calls, "deleteSecret")).toEqual([]);
    expect(configWrites(engine.calls)).toEqual([]);
  });

  it("moves an older pipeline new-key-first: the new secret, the connection, the record — and only then the old secret", async () => {
    const { d, dataDir } = deps();
    writePipelines(dataDir, { vault1: older(1) });
    const steps: string[] = [];
    const engineFetch = d.fetchImpl;
    const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { query, variables } = JSON.parse(String(init?.body)) as Call;
      if (query.includes("createSecret")) steps.push("create the gateway-key secret");
      else if (query.includes("execute(")) steps.push("repoint the connection");
      else if (query.includes("deleteSecret")) steps.push(`delete ${String(variables.ref)} (the record already holds ${readPipelines(dataDir).vault1?.secretRefs.llm})`);
      return engineFetch(url, init);
    }) as unknown as typeof fetch;
    await createPipelineManager({ ...d, fetchImpl }).followGateway();
    expect(steps).toEqual(["create the gateway-key secret", "repoint the connection", "delete secret://old:vault1 (the record already holds secret://v1:1)"]);
  });

  it("a pipeline that cannot be moved keeps its record and its old key, loses the secret made for it and is reported — the others still move", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { d, dataDir, engine } = deps();
    writePipelines(dataDir, { vault1: older(1), vault2: older(2) });
    engine.failExecuteFor.add("conn-1");
    expect(await createPipelineManager(d).followGateway()).toEqual({ moved: ["vault2"], failed: ["vault1"] });
    const records = readPipelines(dataDir);
    expect(records.vault1).toEqual(older(1)); // not gatewayKeyed, still the old key secret
    expect(records.vault2).toMatchObject({ gatewayKeyed: true, secretRefs: { token: "secret://tok:vault2", llm: "secret://v1:2" } });
    // vault1's new secret (secret://v1:1) is deleted and its old one stays; vault2 loses only its old one
    expect(secretCalls(engine.calls, "deleteSecret").map((c) => c.variables.ref)).toEqual(["secret://v1:1", "secret://old:vault2"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/vault1.*refused the write to conn-1/);
  });

  it("a pipeline that already holds the gateway key but cannot be repointed is reported; nothing is created or deleted for it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { d, dataDir, engine } = deps({ gateway: { url: () => "http://127.0.0.1:4299/llm/v1", key: "gw-key" } });
    const keyed: PipelineRecord = { ...older(1), gatewayKeyed: true };
    writePipelines(dataDir, { vault1: keyed });
    engine.failExecuteFor.add("conn-1");
    expect(await createPipelineManager(d).followGateway()).toEqual({ moved: [], failed: ["vault1"] });
    expect(readPipelines(dataDir).vault1).toEqual(keyed);
    expect(secretCalls(engine.calls, "createSecret")).toEqual([]);
    expect(secretCalls(engine.calls, "deleteSecret")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/vault1.*refused the write to conn-1/);
  });
});

describe("pipeline manager — the template's run policy and queue check, kept current in place", () => {
  it("brings every pipeline up to the template's policy and 15 s queue check in place; leaves current ones and unpublished Studio edits alone", async () => {
    const policy = { concurrency: "PARALLEL", runTimeoutSeconds: 0, onFailure: "NOTIFY" };
    const trigger = (config: Record<string, unknown>) => ({ type: "SET_TRIGGER", input: { id: "trig", pieceName: "p", config } });
    const publish = { type: "PUBLISH_WORKFLOW", input: { publishedAt: "{{NOW}}" } };
    const current = { ...template, workflow: { ...template.workflow, operations: [trigger({ drive: "d", pollEverySeconds: 15 }), { type: "SET_POLICY", input: policy }, publish] } } as PipelineTemplate;
    const older = { ...template, workflow: { ...template.workflow, operations: [trigger({ drive: "d" }), publish] } } as PipelineTemplate;
    // Both are kept current in place, so adding them to the template asks nobody to set a pipeline up again.
    expect(templateDigest(current)).toBe(templateDigest(older));
    expect(templatePolicy(current)).toEqual(policy);
    expect(templatePolicy(older)).toBeUndefined();
    expect(templatePollSeconds(current)).toBe(15);
    expect(templatePollSeconds(older)).toBeUndefined();

    const defaults = { concurrency: "QUEUE", runTimeoutSeconds: 3600, onFailure: "PARK" };
    const binding = (config: Record<string, unknown>) => ({ id: "trig", pieceName: "p", pieceVersion: "1.0.0", triggerName: "new-pipeline-task", connectionId: "conn", reactorConnectionId: null, config, propertySettings: [{ prop: "include_backlog", mode: "MANUAL", schema: null }], lastTest: null, updatedAt: "2026-10-01T00:00:00.000Z" });
    const wf = (version: number, publishedVersion: number, policyNow: Record<string, unknown>, config: Record<string, unknown>) => ({
      version,
      trigger: binding(config),
      published: { version: publishedVersion, policy: policyNow, trigger: binding(config) },
    });
    const workflows: Record<string, unknown> = {
      "wf-old": wf(3, 3, defaults, { drive: "d" }), // made before both
      "wf-poll": wf(4, 4, { ...defaults, ...policy }, { drive: "d" }), // has the policy, checks every 60 s
      "wf-current": wf(2, 2, { ...defaults, ...policy }, { drive: "d", pollEverySeconds: 15 }),
      "wf-edited": wf(5, 4, defaults, { drive: "d" }), // unpublished edits in Studio
    };
    const executed: Array<{ id: string; types: string[]; inputs: unknown[] }> = [];
    let lastWrite: Array<{ id: string; type: string }> = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: { id: string; a?: Array<{ id: string; type: string; input: unknown }> } };
      const reply = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
      if (body.query.includes("execute(")) {
        lastWrite = body.variables.a!;
        executed.push({ id: body.variables.id, types: body.variables.a!.map((a) => a.type), inputs: body.variables.a!.map((a) => a.input) });
        return reply({ execute: { id: body.variables.id } });
      }
      if (body.query.includes("revisionsList")) return reply({ document: { document: { revisionsList: [{ scope: "global", revision: 10 }] } } });
      if (body.query.includes("operations(")) return reply({ document: { document: { operations: { items: lastWrite.map((a, i) => ({ index: 10 + i, error: null, action: { id: a.id, type: a.type } })) } } } });
      if (body.query.includes("document { state }")) return reply({ document: { document: { state: { global: workflows[body.variables.id] } } } });
      throw new Error(`unexpected query: ${body.query}`);
    }) as unknown as typeof fetch;
    const { manager, dataDir } = deps({ template: current, fetchImpl });
    const record = (workflowId: string): PipelineRecord => ({ workflowId, connectionId: `c-${workflowId}`, secretRefs: { token: "t", llm: "l" }, createdAt: "2026-10-01T00:00:00.000Z" });
    writePipelines(dataDir, { old: record("wf-old"), poll: record("wf-poll"), current: record("wf-current"), edited: record("wf-edited"), off: { ...record("wf-off"), disabled: "the model key was removed" } });

    expect(await manager.followTemplate()).toEqual({ updated: ["old", "poll"], skipped: ["edited"], failed: [] });
    const setTrigger = { id: "trig", pieceName: "p", pieceVersion: "1.0.0", triggerName: "new-pipeline-task", connectionId: "conn", config: { drive: "d", pollEverySeconds: 15 }, propertySettings: [{ prop: "include_backlog", mode: "MANUAL", schema: null }] };
    const published = { publishedAt: "2026-10-07T10:00:00.000Z" };
    expect(executed).toEqual([
      { id: "wf-old", types: ["SET_POLICY", "SET_TRIGGER", "PUBLISH_WORKFLOW"], inputs: [policy, setTrigger, published] },
      { id: "wf-poll", types: ["SET_TRIGGER", "PUBLISH_WORKFLOW"], inputs: [setTrigger, published] },
    ]);
  });
});

describe("pipeline manager — a workflow runtime that is not up yet", () => {
  it("reads starting, not an error, while the engine answers without its workflow runtime (HTTP 400)", async () => {
    // After an unclean exit the engine boots without the runtime until the previous lease runs out (6.2.3-dev.51).
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ errors: [{ message: 'Cannot query field "workflowRuntime" on type "Query".' }] }) })) as unknown as typeof fetch;
    const { manager, dataDir } = deps({ fetchImpl });
    writePipelines(dataDir, { vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "t", llm: "l" }, createdAt: "2026-10-07T10:00:00.000Z", templateDigest: templateDigest(template) } });
    expect(await manager.status("vault1")).toEqual({ state: "starting" });
  });
});

describe("pipeline manager — the Reweave notes workflow", () => {
  it("is made with the pipeline on its connection, added to vaults set up before it, brought to a newer template in place (still off if it was off) and removed with the vault", async () => {
    let made = 0;
    const instantiateReweave = vi.fn(async () => ({ workflowId: `rw-${++made}` }));
    const { manager, dataDir, engine } = deps({ reweaveTemplate, instantiateReweave });
    // vault2's Reweave notes workflow, switched off in Studio, with a step and an edge of an older template
    engine.states["rw-old"] = { status: "DISABLED", steps: [{ id: "rw-step" }], edges: [{ id: "rw-edge" }], published: { version: 2 } };

    // A new pipeline gets its Reweave notes workflow on the same connection.
    expect((await manager.ensure("vault1")).state).toBe("ready");
    expect(instantiateReweave).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Research — Reweave notes", driveId: "vault1", connectionId: "conn-1", workflowsDriveId: "wfdrive", pieceVersion: "1.0.54-dev.23" }));
    expect(readPipelines(dataDir).vault1?.reweave).toEqual({ workflowId: "rw-1", digest: workflowDigest(reweaveTemplate) });

    // At start: a current one is left alone, a vault set up before it gets one, an older one is brought to the template in place.
    const base: PipelineRecord = { workflowId: "wf-2", connectionId: "conn-2", secretRefs: { token: "secret://v1:8", llm: "secret://v1:9" }, createdAt: "2026-10-01T00:00:00.000Z" };
    writePipelines(dataDir, { ...readPipelines(dataDir), vault2: { ...base, reweave: { workflowId: "rw-old", digest: "older" } }, vault3: { ...base, connectionId: "conn-3", workflowId: "wf-3" }, vault4: { ...base, disabled: "the model key was removed" } });
    expect(await manager.followReweave()).toEqual({ created: ["vault3"], updated: ["vault2"], failed: [] });
    const records = readPipelines(dataDir);
    expect(records.vault1?.reweave?.workflowId).toBe("rw-1");
    expect(records.vault2?.reweave).toEqual({ workflowId: "rw-old", digest: workflowDigest(reweaveTemplate) }); // same workflow, same runs
    expect(records.vault3?.reweave).toEqual({ workflowId: "rw-2", digest: workflowDigest(reweaveTemplate) });
    expect(records.vault4?.reweave).toBeUndefined();
    expect(engine.calls.filter((c) => c.query.includes("deleteDocument"))).toEqual([]);
    const old = batches(engine.calls, "rw-old");
    expect(old.map((b) => b.map((a) => a.type))).toEqual([["REMOVE_EDGE", "REMOVE_STEP", "SET_WORKFLOW_NAME"], ["PUBLISH_WORKFLOW", "SET_WORKFLOW_STATUS"]]);
    expect(old[0]![2]!.input).toEqual({ name: "Team wiki — Reweave notes" });
    expect(old[1]![1]!.input).toEqual({ status: "DISABLED" }); // switched off in Studio: stays off

    // Removing the vault removes its Reweave notes workflow too.
    await manager.remove("vault1");
    expect(engine.calls.filter((c) => c.query.includes("deleteDocument")).map((c) => c.variables.id)).toContain("rw-1");
  });

  it("at start, one deleted in Studio stays deleted; one the engine cannot read is tried again later, never taken for deleted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const instantiateReweave = vi.fn(async () => ({ workflowId: "rw-new" }));
    const { manager, dataDir, engine } = deps({ reweaveTemplate, instantiateReweave });
    const base: PipelineRecord = { workflowId: "wf-2", connectionId: "conn-2", secretRefs: { token: "t", llm: "l" }, createdAt: "2026-10-01T00:00:00.000Z" };
    writePipelines(dataDir, { vault2: { ...base, reweave: { workflowId: "rw-gone", digest: "older" } }, vault3: { ...base, reweave: { workflowId: "rw-down", digest: "older" } } });
    engine.gone.add("rw-gone");
    engine.unreadable.add("rw-down");
    expect(await manager.followReweave()).toEqual({ created: [], updated: [], failed: ["vault3"] });
    expect(readPipelines(dataDir).vault2?.reweave).toEqual({ workflowId: "rw-gone", digest: workflowDigest(reweaveTemplate) });
    expect(readPipelines(dataDir).vault3?.reweave).toEqual({ workflowId: "rw-down", digest: "older" });
    expect(instantiateReweave).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("documentGone — only the engine's own document messages", () => {
  it.each([
    "Document not found: abc-1",
    "Document not found with slug: my-flow",
    "Document abc-1 not found",
    "Document abc-1 was deleted at 2026-10-16T10:00:00.000Z",
    "Document abc-1 has been deleted",
  ])("reads %j as gone", (message) => {
    expect(documentGone(new Error(message))).toBe(true);
  });

  it.each([
    "Document model not found for type bai/x",
    "Document model module not found for type: bai/x",
    "ECONNREFUSED",
    "The engine answered without data",
  ])("does not read %j as gone", (message) => {
    expect(documentGone(new Error(message))).toBe(false);
  });
});
