import { describe, expect, it, vi } from "vitest";
import { fillPlaceholders, instantiatePipeline, PLACEHOLDERS, type PipelineTemplate, type PlaceholderValues } from "./templates.js";

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
