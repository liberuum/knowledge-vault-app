import { randomUUID } from "node:crypto";

/** The reactor's `ActionInput` (spec §4.5: template replay goes through `execute`). */
export type ActionInput = { id: string; type: string; timestampUtcMs: string; input: unknown; scope: "global" };

/** One GraphQL request; `path` selects the endpoint (the reactor at `/graphql`, the vault's graph subgraph at `/graphql/knowledgeGraph`). */
export async function gql<T>(origin: string, query: string, variables: Record<string, unknown>, fetchImpl: typeof fetch, path = "/graphql"): Promise<T> {
  const res = await fetchImpl(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) {
    // A query the engine cannot run (a field it lacks: `workflowRuntime` while another holder's lease
    // runs out) comes back as HTTP 400 with the reason in the body. Keep the reason.
    const reason = await res
      .json()
      .then((b) => (b as { errors?: Array<{ message?: string }> }).errors?.map((e) => e.message).filter(Boolean).join("; "))
      .catch(() => undefined);
    throw new Error(`The engine answered HTTP ${res.status}${reason ? `: ${reason}` : ""}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  if (!json.data) throw new Error("The engine answered without data");
  return json.data;
}

/** Each document model has its own GraphQL namespace; a fresh document is created there. */
const NAMESPACES: Record<string, string> = { "powerhouse/workflow": "Workflow", "powerhouse/connection": "Connection" };

export async function createDocument(origin: string, documentType: string, name: string, parentId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const ns = NAMESPACES[documentType];
  if (!ns) throw new Error(`No GraphQL namespace known for ${documentType}`);
  const data = await gql<Record<string, { createDocument: { id: string } }>>(
    origin,
    `mutation($name: String!, $parent: String) { ${ns} { createDocument(name: $name, parentIdOrSlug: $parent) { id } } }`,
    { name, parent: parentId },
    fetchImpl,
  );
  const id = data[ns]?.createDocument?.id;
  if (!id) throw new Error(`${ns}.createDocument answered without an id`);
  return id;
}

export function toActions(ops: ReadonlyArray<{ type: string; input: unknown }>, now: () => string = () => new Date().toISOString()): ActionInput[] {
  return ops.map((o) => ({ id: randomUUID(), type: o.type, timestampUtcMs: now(), input: o.input, scope: "global" }));
}

type OperationItem = { index: number; error: string | null; action: { id: string; type: string } };

/**
 * Replay a batch. `execute` answers with the document, not with per-operation results. A reducer that rejects an
 * action still records the operation, with its `error`, and the rest of the batch still applies. So the document's
 * global revision is read first; only the operations written from it on are read back, and each is matched to the
 * batch by action id. Two things can then never hide a rejection: a long history (a workflow updated in place many
 * times) pushing the batch past the page, and an operation another writer adds meanwhile (the runtime records each
 * run on its workflow) being taken for one of ours.
 */
export async function execute(origin: string, documentId: string, actions: ActionInput[], fetchImpl: typeof fetch = fetch): Promise<void> {
  if (actions.length === 0) return;
  const head = await gql<{ document: { document: { revisionsList?: Array<{ scope: string; revision: number }> } | null } | null }>(
    origin,
    `query($id: String!) { document(idOrSlug: $id) { document { revisionsList { scope revision } } } }`,
    { id: documentId },
    fetchImpl,
  );
  const since = head.document?.document?.revisionsList?.find((r) => r.scope === "global")?.revision ?? 0;
  await gql(origin, `mutation($id: String!, $a: [ActionInput!]!) { execute(documentIdOrSlug: $id, actions: $a) { id } }`, { id: documentId, a: actions }, fetchImpl);
  const data = await gql<{ document: { document: { operations: { items: OperationItem[] } } } }>(
    origin,
    // The global scope only: a fresh document also holds CREATE_DOCUMENT / UPGRADE_DOCUMENT in the `document` scope,
    // with their own indexes.
    `query($id: String!, $since: Int!) { document(idOrSlug: $id) { document { operations(filter: { scopes: ["global"], sinceRevision: $since }, paging: { limit: 500 }) { items { index error action { id type } } } } } }`,
    { id: documentId, since },
    fetchImpl,
  );
  const byId = new Map(data.document.document.operations.items.map((op) => [op.action.id, op]));
  const found = actions.filter((a) => byId.has(a.id)).length;
  if (found !== actions.length) throw new Error(`Expected ${actions.length} new operations on ${documentId}, found ${found}`);
  const rejected = actions.map((action) => ({ action, op: byId.get(action.id)! })).find(({ op }) => op.error);
  if (rejected) throw new Error(`Operation ${rejected.action.type} was rejected: ${rejected.op.error}`);
}

export async function deleteDocument(origin: string, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await gql(origin, `mutation($id: String!) { deleteDocument(idOrSlug: $id) }`, { id }, fetchImpl);
}
