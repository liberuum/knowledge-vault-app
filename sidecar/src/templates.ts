import { createDocument, deleteDocument, execute, gql, toActions } from "./reactor-gql.js";

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

/** What fillPipeline needs: everything instantiatePipeline takes except where the documents go and how to reach the engine. */
export type PipelineFillOptions = Omit<InstantiateOptions, "workflowsDriveId" | "fetchImpl">;

/**
 * The template's connection and workflow operations, filled for this vault and one connection. The connection carries
 * the model (llm_default_model). The steps leave theirs empty so the piece falls back to it (runner.ts), which makes a
 * model change in Settings one config write, not a new workflow. Throws on a placeholder it does not know.
 */
export function fillPipeline(opts: PipelineFillOptions, connectionId: string): { connection: TemplateOp[]; workflow: TemplateOp[] } {
  const now = opts.now ?? (() => new Date().toISOString());
  const values: PlaceholderValues = {
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
  };
  const stepValues: PlaceholderValues = { ...values, "{{LLM_MODEL}}": "" };
  const fill = (ops: TemplateOp[], v: PlaceholderValues) => ops.map((o) => ({ type: o.type, input: fillPlaceholders(o.input, v) }));
  return { connection: fill(opts.template.connection.operations, values), workflow: fill(opts.template.workflow.operations, stepValues) };
}

/**
 * Create the pipeline's connection in the Workflows drive and replay its operations. Used at setup, and by an Update
 * whose connection was deleted in Studio. Every placeholder is checked before the reactor is touched; a rejected
 * operation deletes the connection again.
 */
export async function createPipelineConnection(opts: InstantiateOptions): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  fillPipeline(opts, "probe");
  const connectionId = await createDocument(opts.origin, opts.template.connection.documentType, `${opts.vaultName} — Knowledge Vault`, opts.workflowsDriveId, f);
  try {
    await execute(opts.origin, connectionId, toActions(fillPipeline(opts, connectionId).connection, now), f);
    return connectionId;
  } catch (error) {
    await deleteDocument(opts.origin, connectionId, f).catch(() => undefined);
    throw error;
  }
}

/**
 * Create the connection, then the workflow, in the Workflows drive, replaying each document's operations with the
 * placeholders filled. The template is validated first: an unknown placeholder aborts before anything is created.
 * When the reactor rejects an operation, both documents are deleted.
 */
export async function instantiatePipeline(opts: InstantiateOptions): Promise<{ workflowId: string; connectionId: string }> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  // Every placeholder the template uses must be one we fill — checked before the reactor is touched.
  fillPipeline(opts, "probe");
  const connectionId = await createPipelineConnection(opts);
  let workflowId: string | undefined;
  try {
    workflowId = await createDocument(opts.origin, opts.template.workflow.documentType, `${opts.vaultName} — Vault pipeline`, opts.workflowsDriveId, f);
    await execute(opts.origin, workflowId, toActions(fillPipeline(opts, connectionId).workflow, now), f);
    return { workflowId, connectionId };
  } catch (error) {
    for (const id of [connectionId, ...(workflowId ? [workflowId] : [])]) await deleteDocument(opts.origin, id, f).catch(() => undefined);
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

/** What fillWorkflow needs: everything instantiateWorkflow takes except the engine and the Workflows drive. */
export type WorkflowFillOptions = Omit<InstantiateWorkflowOptions, "origin" | "workflowsDriveId" | "fetchImpl">;

/** A workflow template's operations, filled for one vault and connection. The steps leave the model to the connection. */
export function fillWorkflow(opts: WorkflowFillOptions): TemplateOp[] {
  const now = opts.now ?? (() => new Date().toISOString());
  const values: Partial<PlaceholderValues> = {
    "{{DRIVE_ID}}": opts.driveId,
    "{{CONNECTION_ID}}": opts.connectionId,
    "{{LLM_MODEL}}": "",
    "{{PIECE_VERSION}}": opts.pieceVersion,
    "{{WORKFLOW_NAME}}": opts.name,
    "{{NOW}}": now(),
  };
  return opts.template.workflow.operations.map((o) => ({ type: o.type, input: fillPlaceholders(o.input, values) }));
}

/**
 * Create one workflow in the Workflows drive and replay its operations on an existing connection. Its steps leave the
 * model empty, so the connection's model applies. A placeholder this cannot fill (a secret, a base URL) aborts before
 * anything is created; a rejected operation deletes the workflow again.
 */
export async function instantiateWorkflow(opts: InstantiateWorkflowOptions): Promise<{ workflowId: string }> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  const actions = toActions(fillWorkflow(opts), now);
  const workflowId = await createDocument(opts.origin, opts.template.workflow.documentType, opts.name, opts.workflowsDriveId, f);
  try {
    await execute(opts.origin, workflowId, actions, f);
    return { workflowId };
  } catch (error) {
    await deleteDocument(opts.origin, workflowId, f).catch(() => undefined);
    throw error;
  }
}

export type ReplaceWorkflowOptions = {
  origin: string;
  workflowId: string;
  /** The template's operations, already filled (fillPipeline / fillWorkflow). */
  operations: TemplateOp[];
  /** What the workflow is switched to once published. */
  status: "ENABLED" | "DISABLED";
  now?: () => string;
  fetchImpl?: typeof fetch;
};

/** Template operations that publish or switch a workflow. Update sends them once, after every edit was accepted. */
const PUBLISHING = new Set(["PUBLISH_WORKFLOW", "SET_WORKFLOW_STATUS"]);

/**
 * Bring an existing workflow to a template in place (spec §2, Update). The workflow keeps its id, its runs and its
 * place in the Workflows drive.
 *
 * Every current edge is removed, then every step. Edges go first because REMOVE_STEP drops a step's edges and
 * REMOVE_EDGE refuses an edge that is gone. The template's edits are then replayed. Its step and edge ids are fixed,
 * so the same ids come back. Only then is the workflow published and switched to `status`.
 *
 * The reactor applies a batch past a rejected operation, so publishing waits for a batch in which every edit was
 * accepted. A rejection, or any failure before the publish lands, sends REVERT_TO_PUBLISHED. That puts the trigger,
 * steps, edges, variables and policy back as last published. The runtime runs the published workflow, so processing
 * never sees a half-made one.
 */
export async function replaceWorkflowInPlace(opts: ReplaceWorkflowOptions): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date().toISOString());
  const data = await gql<{ document: { document: { state: { global: { steps?: Array<{ id: string }>; edges?: Array<{ id: string }> } } } | null } | null }>(
    opts.origin,
    `query($id: String!) { document(idOrSlug: $id) { document { state } } }`,
    { id: opts.workflowId },
    f,
  );
  const global = data.document?.document?.state.global;
  if (!global) throw new Error(`Workflow ${opts.workflowId} no longer exists`);
  const edits: TemplateOp[] = [
    ...(global.edges ?? []).map((e) => ({ type: "REMOVE_EDGE", input: { id: e.id } })),
    ...(global.steps ?? []).map((s) => ({ type: "REMOVE_STEP", input: { id: s.id } })),
    ...opts.operations.filter((o) => !PUBLISHING.has(o.type)),
  ];
  try {
    await execute(opts.origin, opts.workflowId, toActions(edits, now), f);
    await execute(opts.origin, opts.workflowId, toActions([{ type: "PUBLISH_WORKFLOW", input: { publishedAt: now() } }, { type: "SET_WORKFLOW_STATUS", input: { status: opts.status } }], now), f);
  } catch (error) {
    await execute(opts.origin, opts.workflowId, toActions([{ type: "REVERT_TO_PUBLISHED", input: {} }], now), f).catch(() => undefined);
    throw error;
  }
}
