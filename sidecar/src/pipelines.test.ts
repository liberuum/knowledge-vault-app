import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPipelineManager, readPipelines, writePipelines, type PipelineManagerDeps } from "./pipelines.js";
import type { PipelineTemplate } from "./templates.js";

const template = { version: 1, exportedAt: "x", placeholders: [], connection: { documentType: "powerhouse/connection", operations: [] }, workflow: { documentType: "powerhouse/workflow", operations: [] } } as unknown as PipelineTemplate;
type Call = { query: string; variables: Record<string, unknown> };

/** The engine's GraphQL as the manager sees it: secrets, trigger states, runs, deletes. */
function fakeEngine(triggers: Array<{ workflowId: string; status: string }> = []) {
  const calls: Call[] = [];
  let secrets = 0;
  const fetchImpl = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    const q = body.query;
    if (q.includes("createSecret")) return { ok: true, json: async () => ({ data: { workflowRuntime: { createSecret: { ref: `secret://v1:${++secrets}` } } } }) };
    if (q.includes("deleteSecret")) return { ok: true, json: async () => ({ data: { workflowRuntime: { deleteSecret: true } } }) };
    if (q.includes("deleteDocument")) return { ok: true, json: async () => ({ data: { deleteDocument: true } }) };
    if (q.includes("execute(")) return { ok: true, json: async () => ({ data: { execute: { id: body.variables.id } } }) };
    if (q.includes("document { state }")) return { ok: true, json: async () => ({ data: { document: { document: { state: { global: { config: { base_url: "http://127.0.0.1:4201", llm_base_url: "https://openrouter.ai/api/v1", llm_default_model: "openai/gpt-6-luna", llm_api_key: "secret://v1:2" } } } } } } }) };
    if (q.includes("operations(")) return { ok: true, json: async () => ({ data: { document: { document: { operations: { items: [{ index: 0, error: null, action: { type: "SET_WORKFLOW_STATUS" } }], hasNextPage: false, cursor: null } } } } }) };
    if (q.includes("triggerStates")) {
      return { ok: true, json: async () => ({ data: { workflowRuntime: { triggerStates: triggers.map((t) => ({ ...t, lastPollAt: "2026-10-07T10:00:00.000Z", lastError: null })), runsPage: { items: [{ id: `run-${body.variables.w}`, status: "FAILED", startedAt: "2026-10-07T09:59:00.000Z", endedAt: "2026-10-07T09:59:30.000Z", error: "no model here" }] } } } }) };
    }
    throw new Error(`unexpected query: ${q}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
function deps(over: Partial<PipelineManagerDeps> & { hasKey?: boolean; signedIn?: boolean; model?: string; triggers?: Array<{ workflowId: string; status: string }> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "kv-pipelines-"));
  const engine = fakeEngine(over.triggers);
  const instantiate = vi.fn(async () => ({ workflowId: "wf-1", connectionId: "conn-1" }));
  const hasKey = over.hasKey ?? true;
  const d: PipelineManagerDeps = {
    dataDir,
    origin: "http://127.0.0.1:4201",
    fetchImpl: engine.fetchImpl,
    template,
    pieceVersion: "1.0.54-dev.23",
    readSettings: () => ({ version: 1, models: { endpoint: "https://openrouter.ai/api/v1", model: over.model ?? "openai/gpt-6-luna", hasKey }, conversion: { mode: "local", remoteUrl: "" } }),
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
      { v: "sk-or-secret", l: "Research — model key" },
    ]);
    expect(instantiate).toHaveBeenCalledWith(expect.objectContaining({
      origin: "http://127.0.0.1:4201",
      vaultName: "Research",
      driveId: "vault1",
      workflowsDriveId: "wfdrive",
      secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" },
      llm: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" },
      pieceVersion: "1.0.54-dev.23",
    }));
    expect(readPipelines(dataDir).vault1).toEqual({ workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" }, createdAt: "2026-10-07T10:00:00.000Z", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" } , modelFromConnection: true });
  });
  it("uses a placeholder token for an open engine with nobody signed in — the engine ignores bearers there", async () => {
    const { manager, engine } = deps({ signedIn: false });
    await manager.ensure("vault1");
    expect(engine.calls.find((c) => c.query.includes("createSecret"))!.variables.v).toBe("open");
  });
  it("re-creating a pipeline removes the previous documents and secrets first", async () => {
    const { manager, engine } = deps();
    await manager.ensure("vault1");
    await manager.ensure("vault1");
    const deletes = engine.calls.filter((c) => c.query.includes("deleteDocument")).map((c) => c.variables.id).sort();
    expect(deletes).toEqual(["conn-1", "wf-1"]);
    const secretDeletes = engine.calls.filter((c) => c.query.includes("deleteSecret")).map((c) => c.variables.ref).sort();
    expect(secretDeletes).toEqual(["secret://v1:1", "secret://v1:2"]);
  });
});

describe("pipeline manager — status and removal", () => {
  it("is unconfigured without a key, missing without a record, and otherwise this vault's trigger and last run only", async () => {
    const none = deps({ hasKey: false });
    expect(await none.manager.status("vault1")).toEqual({ state: "unconfigured" });
    const fresh = deps();
    expect(await fresh.manager.status("vault1")).toEqual({ state: "missing" });
    const two = deps({ triggers: [{ workflowId: "wf-1", status: "ENABLED" }, { workflowId: "wf-other", status: "DISABLED" }] });
    const models = { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" };
    const token = { kind: "minted" as const, expiresAt: "2027-01-05T10:00:00.000Z" };
    writePipelines(two.dataDir, {
      vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "s1", llm: "s2" }, createdAt: "x", models, token },
      vault2: { workflowId: "wf-other", connectionId: "conn-2", secretRefs: { token: "s3", llm: "s4" }, createdAt: "x", models, token },
    });
    expect(await two.manager.status("vault1")).toEqual({
      state: "ready",
      workflowId: "wf-1",
      connectionId: "conn-1",
      trigger: { status: "ENABLED", lastPollAt: "2026-10-07T10:00:00.000Z", lastError: null },
      lastRun: { id: "run-wf-1", status: "FAILED", startedAt: "2026-10-07T09:59:00.000Z", endedAt: "2026-10-07T09:59:30.000Z", error: "no model here" },
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

describe("pipeline manager — lifecycle (review fixes)", () => {
  it("a failed instantiation deletes the two new secrets and leaves no record — status reads missing, never ready", async () => {
    const { manager, engine, dataDir } = deps({ instantiate: vi.fn(async () => { throw new Error("Operation SET_TRIGGER was rejected: drive unknown"); }) });
    await expect(manager.ensure("vault1")).rejects.toThrow(/SET_TRIGGER/);
    expect(engine.calls.filter((c) => c.query.includes("deleteSecret")).map((c) => c.variables.ref).sort()).toEqual(["secret://v1:1", "secret://v1:2"]);
    expect(readPipelines(dataDir).vault1).toBeUndefined();
    expect(await manager.status("vault1")).toEqual({ state: "missing" });
  });
  it("re-creating a pipeline that then fails leaves no stale record", async () => {
    const instantiate = vi.fn(async () => ({ workflowId: "wf-1", connectionId: "conn-1" }));
    const { manager, dataDir } = deps({ instantiate });
    await manager.ensure("vault1");
    instantiate.mockImplementationOnce(async () => { throw new Error("reactor down"); });
    await expect(manager.ensure("vault1")).rejects.toThrow(/reactor down/);
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
    const disables = engine.calls.filter((c) => c.query.includes("execute(")).map((c) => (c.variables.a as Array<{ type: string; input: { status: string } }>)[0]!);
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
      vault1: { workflowId: "wf-1", connectionId: "conn-1", secretRefs: { token: "secret://v1:1", llm: "secret://v1:2" }, createdAt: "2026-10-07T10:00:00.000Z", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" }, modelFromConnection: true },
      vault2: { workflowId: "wf-old", connectionId: "conn-old", secretRefs: { token: "secret://v1:3", llm: "secret://v1:4" }, createdAt: "2026-10-07T10:00:00.000Z", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" } },
      vault3: { workflowId: "wf-3", connectionId: "conn-3", secretRefs: { token: "secret://v1:5", llm: "secret://v1:6" }, createdAt: "2026-10-07T10:00:00.000Z", models: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, token: { kind: "minted", expiresAt: "2027-01-05T10:00:00.000Z" }, disabled: "the model key was removed" },
    });
    expect(await h.manager.applyModels()).toEqual({ updated: ["vault1"], recreated: ["vault2"] });
    const setConfig = h.engine.calls.find((c) => c.query.includes("execute(") && JSON.stringify(c.variables).includes("SET_CONFIG"));
    const action = (setConfig!.variables.a as Array<{ input: unknown }>)[0]!;
    expect(action.input).toEqual({ config: { base_url: "http://127.0.0.1:4201", llm_base_url: "https://openrouter.ai/api/v1", llm_default_model: "anthropic/claude-sonnet-5.5", llm_api_key: "secret://v1:2" } });
    const records = readPipelines(h.dataDir);
    expect(records.vault1).toMatchObject({ workflowId: "wf-1", models: { model: "anthropic/claude-sonnet-5.5" } });
    expect(h.instantiate).toHaveBeenCalledTimes(1); // only the older pipeline was set up again
    expect(records.vault2).toMatchObject({ workflowId: "wf-1", modelFromConnection: true, models: { model: "anthropic/claude-sonnet-5.5" } });
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
