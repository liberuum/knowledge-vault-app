import { describe, expect, it } from "vitest";
import { fillConnection, KNOWLEDGE_VAULT_CONNECTOR, type FillDeps } from "./connections.js";

type State = { name?: string; connectorId: string | null; config: Record<string, unknown> | null; secretRefs: { id: string; ref: string; name: string }[] };

function engine(state: State) {
  const executed: { id: string; type: string; input: Record<string, unknown> }[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    let data: unknown = {};
    if (query.includes("createSecret")) {
      created.push(String(variables.v));
      data = { workflowRuntime: { createSecret: { ref: `ref-${created.length}` } } };
    } else if (query.includes("deleteSecret")) {
      deleted.push(String(variables.ref));
      data = { workflowRuntime: { deleteSecret: true } };
    } else if (query.includes("execute(")) {
      executed.push(...(variables.a as { id: string; type: string; input: Record<string, unknown> }[]));
      data = { execute: { id: "c1" } };
    } else if (query.includes("operations(")) {
      data = { document: { document: { operations: { items: executed.map((a, index) => ({ index, error: null, action: { id: a.id, type: a.type } })), hasNextPage: false } } } };
    } else if (query.includes("document(")) {
      data = { document: { document: { name: state.name ?? "Connection 1", state: { global: state } } } };
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, executed, created, deleted };
}

const deps = (fetchImpl: typeof fetch, over: Partial<FillDeps> = {}): FillDeps => ({
  origin: "http://127.0.0.1:4201",
  fetchImpl,
  engineToken: async () => ({ value: "jwt-90d", kind: "minted", expiresAt: "2027-01-05T00:00:00.000Z" }),
  ...over,
});

const kv = (over: Partial<State> = {}): State => ({ connectorId: KNOWLEDGE_VAULT_CONNECTOR, config: null, secretRefs: [], ...over });

describe("fillConnection (a Knowledge Vault connection, filled from this app)", () => {
  it("sets this engine's address, keeping the other settings, and nothing else unless asked", async () => {
    const e = engine(kv({ config: { llm_default_model: "deepseek/x" } }));
    const r = await fillConnection(deps(e.fetchImpl), "c1", { token: false });
    expect(e.executed.map((a) => a.type)).toEqual(["SET_CONFIG"]);
    expect(e.executed[0]!.input).toEqual({ config: { llm_default_model: "deepseek/x", base_url: "http://127.0.0.1:4201" } });
    expect(e.created).toEqual([]);
    expect(r).toEqual({ baseUrl: "http://127.0.0.1:4201", token: null });
  });

  it("leaves an address the user typed alone", async () => {
    const e = engine(kv({ config: { base_url: "https://vault.example.com" } }));
    await fillConnection(deps(e.fetchImpl), "c1", { token: false });
    expect(e.executed).toEqual([]);
  });

  it("stores a token from the app's sign-in as an encrypted secret and attaches it", async () => {
    const e = engine(kv({ config: { base_url: "http://127.0.0.1:4201" } }));
    const r = await fillConnection(deps(e.fetchImpl), "c1", { token: true });
    expect(e.created).toEqual(["jwt-90d"]);
    expect(e.executed.map((a) => a.type)).toEqual(["SET_SECRET_REF"]);
    expect(e.executed[0]!.input).toMatchObject({ ref: "ref-1", name: "token" });
    expect(r.token).toEqual({ kind: "minted", expiresAt: "2027-01-05T00:00:00.000Z" });
  });

  it("replaces an earlier token in the same slot and deletes the old secret", async () => {
    const e = engine(kv({ config: { base_url: "x" }, secretRefs: [{ id: "slot-1", ref: "old-ref", name: "token" }] }));
    await fillConnection(deps(e.fetchImpl), "c1", { token: true });
    expect(e.executed[0]!.input).toEqual({ id: "slot-1", ref: "ref-1", name: "token" });
    expect(e.deleted).toEqual(["old-ref"]);
  });

  it("refuses a connection to another service, and passes on a refused token", async () => {
    const other = engine(kv({ connectorId: "@acme/piece-mail#mail" }));
    await expect(fillConnection(deps(other.fetchImpl), "c1", { token: true })).rejects.toThrow(/Knowledge Vault/);
    const e = engine(kv());
    await expect(
      fillConnection(deps(e.fetchImpl, { engineToken: async () => Promise.reject(new Error("Sign in first")) }), "c1", { token: true }),
    ).rejects.toThrow("Sign in first");
    expect(e.created).toEqual([]);
  });
});
