import { randomUUID } from "node:crypto";
import { execute, gql, toActions } from "./reactor-gql.js";

/** The connector id Studio stores on a connection to this package's piece. */
export const KNOWLEDGE_VAULT_CONNECTOR = "@powerhousedao/piece-knowledge-vault#knowledge-vault";

export type EngineToken = { value: string; kind: "open" | "minted"; expiresAt: string | null };

export type FillDeps = {
  /** This engine, which the connection should call. */
  origin: string;
  fetchImpl: typeof fetch;
  /** The bearer the pipelines use: minted from the signed-in user, "open" on an open engine, refused on a protected one with nobody signed in. */
  engineToken: () => Promise<EngineToken>;
};

export type FillResult = { baseUrl: string; token: { kind: EngineToken["kind"]; expiresAt: string | null } | null };

type ConnectionState = {
  connectorId?: string | null;
  config?: Record<string, unknown> | null;
  secretRefs?: { id: string; ref: string; name: string }[];
};

export class ConnectionError extends Error {}

/**
 * Fills a Knowledge Vault connection from this app, so nobody has to find a URL or run
 * `ph access-token`: the engine's own address (only where none is set — a typed address
 * wins; the other settings are kept) and, when asked, a token from the app's sign-in,
 * stored as an encrypted runtime secret the connection references — what the form's
 * Save does with a pasted value. An earlier token in the slot is replaced and deleted.
 */
export async function fillConnection(deps: FillDeps, connectionId: string, options: { token: boolean }): Promise<FillResult> {
  const { origin, fetchImpl: f } = deps;
  const data = await gql<{ document: { document: { name: string; state: { global: ConnectionState } } } }>(
    origin,
    `query($id: String!) { document(idOrSlug: $id) { document { name state } } }`,
    { id: connectionId },
    f,
  );
  const name = data.document.document.name;
  const state = data.document.document.state.global;
  if (state.connectorId !== KNOWLEDGE_VAULT_CONNECTOR) throw new ConnectionError("Only a Knowledge Vault connection can be filled from this app.");

  const ops: { type: string; input: unknown }[] = [];
  const config = state.config ?? {};
  const currentUrl = typeof config.base_url === "string" ? config.base_url.trim() : "";
  if (!currentUrl) ops.push({ type: "SET_CONFIG", input: { config: { ...config, base_url: origin } } });

  let token: FillResult["token"] = null;
  let replaced: string | undefined;
  if (options.token) {
    const minted = await deps.engineToken(); // before anything is written: a refusal costs nothing
    const created = await gql<{ workflowRuntime: { createSecret: { ref: string } } }>(
      origin,
      // Owned by this connection: the runtime hands a secret only to the document that owns it.
      `mutation($v: String!, $l: String, $d: String!) { workflowRuntime { createSecret(value: $v, label: $l, documentId: $d) { ref } } }`,
      { v: minted.value, l: `${name} — engine token`, d: connectionId },
      f,
    );
    const slot = (state.secretRefs ?? []).find((s) => s.name === "token");
    replaced = slot?.ref;
    ops.push({ type: "SET_SECRET_REF", input: { id: slot?.id ?? randomUUID(), ref: created.workflowRuntime.createSecret.ref, name: "token" } });
    token = { kind: minted.kind, expiresAt: minted.expiresAt };
  }
  await execute(origin, connectionId, toActions(ops), f);
  if (replaced) {
    await gql(origin, `mutation($ref: String!) { workflowRuntime { deleteSecret(ref: $ref) } }`, { ref: replaced }, f).catch(() => undefined);
  }
  return { baseUrl: currentUrl || origin, token };
}
