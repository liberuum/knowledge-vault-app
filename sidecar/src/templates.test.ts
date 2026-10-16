import { describe, expect, it, vi } from "vitest";
import { createPipelineConnection, fillPipeline, fillPlaceholders, fillWorkflow, instantiatePipeline, PLACEHOLDERS, replaceWorkflowInPlace, type PipelineTemplate, type PlaceholderValues, type WorkflowTemplate } from "./templates.js";

const template: PipelineTemplate = {
  version: 1,
  exportedAt: "2026-10-07T08:30:00.000Z",
  placeholders: [...PLACEHOLDERS],
  connection: {
    documentType: "powerhouse/connection",
    operations: [
      { type: "SET_CONNECTION_NAME", input: { name: "{{CONNECTION_NAME}}" } },
      { type: "SET_CONNECTOR", input: { authType: "CUSTOM_AUTH", connectorId: "@powerhousedao/piece-knowledge-vault#knowledge-vault" } },
      { type: "SET_CONFIG", input: { config: { base_url: "{{SWITCHBOARD_ORIGIN}}", llm_default_model: "{{LLM_MODEL}}", llm_base_url: "{{LLM_BASE_URL}}" } } },
      { type: "SET_SECRET_REF", input: { id: "bccb", ref: "{{TOKEN_SECRET_REF}}", name: "token" } },
      { type: "SET_SECRET_REF", input: { id: "6491", ref: "{{LLM_SECRET_REF}}", name: "llm_api_key" } },
    ],
  },
  workflow: {
    documentType: "powerhouse/workflow",
    operations: [
      { type: "SET_WORKFLOW_NAME", input: { name: "{{WORKFLOW_NAME}}" } },
      { type: "SET_TRIGGER", input: { id: "trig", config: { drive: "{{DRIVE_ID}}", phase: "create" }, connectionId: "{{CONNECTION_ID}}", pieceVersion: "{{PIECE_VERSION}}" } },
      { type: "ADD_STEP", input: { id: "s1", config: { drive: "{{DRIVE_ID}}", model: "{{LLM_MODEL}}", source_id: "{{trigger.payload.source_id}}" }, connectionId: "{{CONNECTION_ID}}" } },
      { type: "PUBLISH_WORKFLOW", input: { publishedAt: "{{NOW}}" } },
      { type: "SET_WORKFLOW_STATUS", input: { status: "ENABLED" } },
    ],
  },
};
const values: PlaceholderValues = {
  "{{DRIVE_ID}}": "vault1",
  "{{CONNECTION_ID}}": "doc1",
  "{{SWITCHBOARD_ORIGIN}}": "http://127.0.0.1:4201",
  "{{TOKEN_SECRET_REF}}": "secret://v1:aaaa",
  "{{LLM_SECRET_REF}}": "secret://v1:bbbb",
  "{{LLM_BASE_URL}}": "https://openrouter.ai/api/v1",
  "{{LLM_MODEL}}": "openai/gpt-6-luna",
  "{{PIECE_VERSION}}": "1.0.54-dev.23",
  "{{WORKFLOW_NAME}}": "Research — Vault pipeline",
  "{{CONNECTION_NAME}}": "Research — Knowledge Vault",
  "{{NOW}}": "2026-10-07T10:00:00.000Z",
};

import { fakeReactor } from "./reactor-gql.test.js";

describe("fillPlaceholders", () => {
  it("fills every placeholder, leaves the runtime's own expressions alone, and refuses an unknown one", () => {
    expect(fillPlaceholders({ a: "{{DRIVE_ID}}/x", b: ["{{LLM_SECRET_REF}}"], c: "{{trigger.payload.source_id}}" }, values)).toEqual({ a: "vault1/x", b: ["secret://v1:bbbb"], c: "{{trigger.payload.source_id}}" });
    expect(() => fillPlaceholders({ a: "{{NEW_THING}}" }, values)).toThrow("Unknown placeholder {{NEW_THING}}");
    // a value with a quote or a backslash stays valid JSON
    expect(fillPlaceholders({ n: "{{WORKFLOW_NAME}}" }, { ...values, "{{WORKFLOW_NAME}}": 'He said "hi" \\ bye' })).toEqual({ n: 'He said "hi" \\ bye' });
  });
});

describe("instantiatePipeline", () => {
  const opts = { origin: "http://127.0.0.1:4201", template, vaultName: "Research", driveId: "vault1", workflowsDriveId: "wfdrive", secretRefs: { token: "secret://v1:aaaa", llm: "secret://v1:bbbb" }, llm: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna" }, pieceVersion: "1.0.54-dev.23", now: () => "2026-10-07T10:00:00.000Z" };
  it("creates the connection, then the workflow, in the Workflows drive, and replays each with its values", async () => {
    const { fetchImpl, calls } = fakeReactor();
    expect(await instantiatePipeline({ ...opts, fetchImpl })).toEqual({ connectionId: "doc1", workflowId: "doc2" });
    const creates = calls.filter((c) => c.query.includes("createDocument"));
    expect(creates[0]!.query).toMatch(/Connection\s*\{/);
    expect(creates[0]!.variables).toEqual({ name: "Research — Knowledge Vault", parent: "wfdrive" });
    expect(creates[1]!.query).toMatch(/Workflow\s*\{/);
    expect(creates[1]!.variables).toEqual({ name: "Research — Vault pipeline", parent: "wfdrive" });
    const executes = calls.filter((c) => c.query.includes("execute("));
    const conn = executes[0]!.variables.a as Array<{ type: string; input: unknown }>;
    expect(conn.map((x) => x.type)).toEqual(["SET_CONNECTION_NAME", "SET_CONNECTOR", "SET_CONFIG", "SET_SECRET_REF", "SET_SECRET_REF"]);
    expect(conn[0]!.input).toEqual({ name: "Research — Knowledge Vault" });
    expect(conn[2]!.input).toEqual({ config: { base_url: "http://127.0.0.1:4201", llm_default_model: "openai/gpt-6-luna", llm_base_url: "https://openrouter.ai/api/v1" } });
    expect(conn[3]!.input).toEqual({ id: "bccb", ref: "secret://v1:aaaa", name: "token" });
    expect(conn[4]!.input).toEqual({ id: "6491", ref: "secret://v1:bbbb", name: "llm_api_key" });
    const wf = executes[1]!.variables.a as Array<{ type: string; input: unknown }>;
    expect(wf.map((x) => x.type)).toEqual(["SET_WORKFLOW_NAME", "SET_TRIGGER", "ADD_STEP", "PUBLISH_WORKFLOW", "SET_WORKFLOW_STATUS"]);
    expect(wf[0]!.input).toEqual({ name: "Research — Vault pipeline" });
    expect(wf[1]!.input).toEqual({ id: "trig", config: { drive: "vault1", phase: "create" }, connectionId: "doc1", pieceVersion: "1.0.54-dev.23" });
    expect(wf[2]!.input).toEqual({ id: "s1", config: { drive: "vault1", model: "", source_id: "{{trigger.payload.source_id}}" }, connectionId: "doc1" });
    expect(wf[3]!.input).toEqual({ publishedAt: "2026-10-07T10:00:00.000Z" });
  });
  it("deletes what it created when a replayed operation is rejected, naming the operation and the reason", async () => {
    const { fetchImpl, calls } = fakeReactor({ rejectType: "SET_WORKFLOW_NAME", rejectWith: "Name is empty" });
    await expect(instantiatePipeline({ ...opts, fetchImpl })).rejects.toThrow(/SET_WORKFLOW_NAME.*Name is empty/);
    const deletes = calls.filter((c) => c.query.includes("deleteDocument")).map((c) => c.variables.id);
    expect(deletes.sort()).toEqual(["doc1", "doc2"]);
  });
  it("refuses a template whose placeholders it does not know, before touching the reactor", async () => {
    const { fetchImpl, calls } = fakeReactor();
    const odd: PipelineTemplate = { ...template, workflow: { ...template.workflow, operations: [{ type: "SET_X", input: { v: "{{SOMETHING_NEW}}" } }] } };
    await expect(instantiatePipeline({ ...opts, template: odd, fetchImpl })).rejects.toThrow("Unknown placeholder {{SOMETHING_NEW}}");
    expect(calls.length).toBe(0);
  });
});

describe("Update in place", () => {
  const fill = { origin: "http://127.0.0.1:4201", template, vaultName: "Research", driveId: "vault1", secretRefs: { token: "secret://v1:cccc", llm: "secret://v1:dddd" }, llm: { baseUrl: "http://127.0.0.1:4202/llm/v1", model: "openai/gpt-6-luna" }, pieceVersion: "1.0.54-dev.24", now: () => "2026-10-16T10:00:00.000Z" };
  /** A pipeline workflow as Studio left it: switched off, with a step of its own and an edge. */
  const studio = { wf9: { status: "DISABLED", steps: [{ id: "s1" }, { id: "s-studio" }], edges: [{ id: "e-studio" }], published: { version: 4 } } };
  const sent = (calls: Array<{ query: string; variables: Record<string, unknown> }>) => calls.filter((c) => c.query.includes("execute(")).map((c) => c.variables.a as Array<{ type: string; input: unknown }>);
  const editTypes = ["REMOVE_EDGE", "REMOVE_STEP", "REMOVE_STEP", "SET_WORKFLOW_NAME", "SET_TRIGGER", "ADD_STEP"];

  it("fills the template for one connection: the steps leave the model to it, the connection names the given secrets", () => {
    const filled = fillPipeline(fill, "conn-7");
    expect(filled.workflow.find((o) => o.type === "ADD_STEP")!.input).toEqual({ id: "s1", config: { drive: "vault1", model: "", source_id: "{{trigger.payload.source_id}}" }, connectionId: "conn-7" });
    expect(filled.connection.find((o) => o.type === "SET_CONFIG")!.input).toEqual({ config: { base_url: "http://127.0.0.1:4201", llm_default_model: "openai/gpt-6-luna", llm_base_url: "http://127.0.0.1:4202/llm/v1" } });
    expect(filled.connection.filter((o) => o.type === "SET_SECRET_REF").map((o) => o.input)).toEqual([{ id: "bccb", ref: "secret://v1:cccc", name: "token" }, { id: "6491", ref: "secret://v1:dddd", name: "llm_api_key" }]);
  });

  it("removes the workflow's edges, then its steps, replays the template's edits, and only then publishes and sets the status", async () => {
    const { fetchImpl, calls } = fakeReactor({ states: studio });
    await replaceWorkflowInPlace({ origin: fill.origin, workflowId: "wf9", operations: fillPipeline(fill, "conn-7").workflow, status: "DISABLED", now: fill.now, fetchImpl });
    const batches = sent(calls);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.map((a) => a.type)).toEqual(editTypes);
    expect(batches[0]!.slice(0, 3).map((a) => a.input)).toEqual([{ id: "e-studio" }, { id: "s1" }, { id: "s-studio" }]);
    expect(batches[1]!.map((a) => [a.type, a.input])).toEqual([["PUBLISH_WORKFLOW", { publishedAt: "2026-10-16T10:00:00.000Z" }], ["SET_WORKFLOW_STATUS", { status: "DISABLED" }]]);
  });

  it("on a rejected edit puts the workflow back as last published and never publishes", async () => {
    const { fetchImpl, calls } = fakeReactor({ states: studio, rejectType: "ADD_STEP", rejectWith: "A step with this id already exists" });
    await expect(replaceWorkflowInPlace({ origin: fill.origin, workflowId: "wf9", operations: fillPipeline(fill, "conn-7").workflow, status: "ENABLED", now: fill.now, fetchImpl })).rejects.toThrow(/ADD_STEP.*already exists/);
    expect(sent(calls).map((b) => b.map((a) => a.type))).toEqual([editTypes, ["REVERT_TO_PUBLISHED"]]);
    expect(sent(calls)[1]![0]!.input).toEqual({});
  });

  it("makes a connection from the template, and deletes it again when an operation is rejected", async () => {
    const ok = fakeReactor();
    expect(await createPipelineConnection({ ...fill, workflowsDriveId: "wfdrive", fetchImpl: ok.fetchImpl })).toBe("doc1");
    expect(ok.calls.find((c) => c.query.includes("createDocument"))!.variables).toEqual({ name: "Research — Knowledge Vault", parent: "wfdrive" });
    expect(sent(ok.calls)[0]!.map((a) => a.type)).toEqual(["SET_CONNECTION_NAME", "SET_CONNECTOR", "SET_CONFIG", "SET_SECRET_REF", "SET_SECRET_REF"]);
    const bad = fakeReactor({ rejectType: "SET_CONNECTOR", rejectWith: "The reactor connector id goes only with authType REACTOR" });
    await expect(createPipelineConnection({ ...fill, workflowsDriveId: "wfdrive", fetchImpl: bad.fetchImpl })).rejects.toThrow(/SET_CONNECTOR/);
    expect(bad.calls.filter((c) => c.query.includes("deleteDocument")).map((c) => c.variables.id)).toEqual(["doc1"]);
  });

  it("fills a workflow template with the workflow's own values, the model left to the connection", () => {
    const reweave: WorkflowTemplate = { version: 1, exportedAt: "x", placeholders: [], workflow: { documentType: "powerhouse/workflow", operations: [{ type: "SET_WORKFLOW_NAME", input: { name: "{{WORKFLOW_NAME}}" } }, { type: "ADD_STEP", input: { id: "r1", config: { drive: "{{DRIVE_ID}}", model: "{{LLM_MODEL}}" }, connectionId: "{{CONNECTION_ID}}" } }] } };
    expect(fillWorkflow({ template: reweave, name: "Research — Reweave notes", driveId: "vault1", connectionId: "conn-7", pieceVersion: "1.0.54-dev.24" }).map((o) => o.input)).toEqual([{ name: "Research — Reweave notes" }, { id: "r1", config: { drive: "vault1", model: "" }, connectionId: "conn-7" }]);
  });
});
