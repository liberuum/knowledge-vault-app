import { createDocument, deleteDocument, execute, toActions } from "./reactor-gql.js";

/**
 * The pipeline template (spec §4.5, §7.5): the vault package ships the
 * *Vault pipeline (auto)* workflow and its connection as their own operations
 * with every environment-specific value replaced by one of these placeholders
 * (pieces/knowledge-vault/templates/README.md in the vault package). The
 * runtime's own `{{trigger.payload.x}}` expressions are lower-case paths and
 * are never ours.
 */
export const PLACEHOLDERS = [
  "{{DRIVE_ID}}",
  "{{CONNECTION_ID}}",
  "{{SWITCHBOARD_ORIGIN}}",
  "{{TOKEN_SECRET_REF}}",
  "{{LLM_SECRET_REF}}",
  "{{LLM_BASE_URL}}",
  "{{LLM_MODEL}}",
  "{{PIECE_VERSION}}",
  "{{WORKFLOW_NAME}}",
  "{{CONNECTION_NAME}}",
  "{{NOW}}",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type PlaceholderValues = Record<Placeholder, string>;
export type TemplateOp = { type: string; input: unknown };
export type PipelineTemplate = {
  version: 1;
  exportedAt: string;
  placeholders: string[];
  connection: { documentType: "powerhouse/connection"; operations: TemplateOp[] };
  workflow: { documentType: "powerhouse/workflow"; operations: TemplateOp[] };
  source?: { switchboard: string; workflowId: string; connectionId: string };
};

/** Substitute inside the serialised input (values JSON-escaped), then refuse any `{{UPPER_CASE}}` that survived. */
export function fillPlaceholders(input: unknown, values: Partial<PlaceholderValues>): unknown {
  let text = JSON.stringify(input);
  for (const [placeholder, value] of Object.entries(values)) text = text.split(placeholder).join(JSON.stringify(value).slice(1, -1));
  const left = /\{\{[A-Z_]+\}\}/.exec(text);
  if (left) throw new Error(`Unknown placeholder ${left[0]}`);
  return JSON.parse(text);
}

export type InstantiateOptions = {
  origin: string;
  template: PipelineTemplate;
  vaultName: string;
  driveId: string;
  workflowsDriveId: string;
  /** Workflow-runtime secret refs (`secret://…`): the engine bearer the piece calls the vault with, and the LLM key. */
  secretRefs: { token: string; llm: string };
  llm: { baseUrl: string; model: string };
  pieceVersion: string;
  now?: () => string;
  fetchImpl?: typeof fetch;
};

/**
 * Create the connection, then the workflow, in the Workflows drive, replaying
 * each document's operations with the placeholders filled. Validated against
 * the template first — an unknown placeholder aborts before anything is
 * created — and rolled back (both documents deleted) when the reactor rejects
 * an operation.
 */
export async function instantiatePipeline(opts: InstantiateOptions): Promise<{ workflowId: string; connectionId: string }> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  const valuesWith = (connectionId: string): PlaceholderValues => ({
    "{{DRIVE_ID}}": opts.driveId,
    "{{CONNECTION_ID}}": connectionId,
    "{{SWITCHBOARD_ORIGIN}}": opts.origin,
    "{{TOKEN_SECRET_REF}}": opts.secretRefs.token,
    "{{LLM_SECRET_REF}}": opts.secretRefs.llm,
    "{{LLM_BASE_URL}}": opts.llm.baseUrl,
    "{{LLM_MODEL}}": opts.llm.model,
    "{{PIECE_VERSION}}": opts.pieceVersion,
    "{{WORKFLOW_NAME}}": `${opts.vaultName} — Vault pipeline`,
    "{{CONNECTION_NAME}}": `${opts.vaultName} — Knowledge Vault`,
    "{{NOW}}": now(),
  });
  // Every placeholder the template uses must be one we fill — checked before the reactor is touched.
  const probe = valuesWith("probe");
  for (const op of [...opts.template.connection.operations, ...opts.template.workflow.operations]) fillPlaceholders(op.input, probe);

  const created: string[] = [];
  try {
    const connectionId = await createDocument(opts.origin, opts.template.connection.documentType, `${opts.vaultName} — Knowledge Vault`, opts.workflowsDriveId, f);
    created.push(connectionId);
    const values = valuesWith(connectionId);
    // The connection carries the model (llm_default_model); the steps leave theirs empty so the piece
    // falls back to it (runner.ts) — a model change in Settings is then one config write, not a new workflow.
    const stepValues: PlaceholderValues = { ...values, "{{LLM_MODEL}}": "" };
    const fill = (ops: TemplateOp[], v: PlaceholderValues) => toActions(ops.map((o) => ({ type: o.type, input: fillPlaceholders(o.input, v) })), now);
    await execute(opts.origin, connectionId, fill(opts.template.connection.operations, values), f);
    const workflowId = await createDocument(opts.origin, opts.template.workflow.documentType, `${opts.vaultName} — Vault pipeline`, opts.workflowsDriveId, f);
    created.push(workflowId);
    await execute(opts.origin, workflowId, fill(opts.template.workflow.operations, stepValues), f);
    return { workflowId, connectionId };
  } catch (error) {
    for (const id of created) await deleteDocument(opts.origin, id, f).catch(() => undefined);
    throw error;
  }
}

/**
 * A workflow that runs on a connection made for another: the vault's *Reweave notes* workflow
 * (reweave.json in the vault package) on the vault pipeline's connection, so both share one model and key.
 */
export type WorkflowTemplate = {
  version: 1;
  exportedAt: string;
  placeholders: string[];
  workflow: { documentType: "powerhouse/workflow"; operations: TemplateOp[] };
};

export type InstantiateWorkflowOptions = {
  origin: string;
  template: WorkflowTemplate;
  /** The workflow's name, in Studio and in the Workflows drive. */
  name: string;
  driveId: string;
  connectionId: string;
  workflowsDriveId: string;
  pieceVersion: string;
  now?: () => string;
  fetchImpl?: typeof fetch;
};

/**
 * Create one workflow in the Workflows drive and replay its operations on an existing connection. Its steps
 * leave the model empty, so the connection's applies. A placeholder this cannot fill (a secret, a base URL)
 * aborts before anything is created; a rejected operation deletes the workflow again.
 */
export async function instantiateWorkflow(opts: InstantiateWorkflowOptions): Promise<{ workflowId: string }> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  const values: Partial<PlaceholderValues> = {
    "{{DRIVE_ID}}": opts.driveId,
    "{{CONNECTION_ID}}": opts.connectionId,
    "{{LLM_MODEL}}": "",
    "{{PIECE_VERSION}}": opts.pieceVersion,
    "{{WORKFLOW_NAME}}": opts.name,
    "{{NOW}}": now(),
  };
  const actions = toActions(opts.template.workflow.operations.map((o) => ({ type: o.type, input: fillPlaceholders(o.input, values) })), now);
  const workflowId = await createDocument(opts.origin, opts.template.workflow.documentType, opts.name, opts.workflowsDriveId, f);
  try {
    await execute(opts.origin, workflowId, actions, f);
    return { workflowId };
  } catch (error) {
    await deleteDocument(opts.origin, workflowId, f).catch(() => undefined);
    throw error;
  }
}
