import { describe, expect, it, vi } from "vitest";
import { createVaultDrive, deleteVaultDrive, ensureWorkflowsDrive, listVaultDrives, NotAVaultError, renameVaultDrive, slugify, VAULT_APP_ID, WORKFLOWS_APP_ID } from "./vaults.js";

const ORIGIN = "http://127.0.0.1:4201";
type Call = { url: string; body?: unknown };

function fakeFetch(handler: (call: Call) => unknown): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return { ok: true, status: 200, json: async () => handler(call) };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("slugify", () => {
  it("lowercases, hyphenates spaces and drops everything else", () => {
    expect(slugify("Research Notes (2026)!")).toBe("research-notes-2026");
  });
});

describe("listVaultDrives", () => {
  it("returns only drives whose preferredEditor is knowledge-vault, with a note count", async () => {
    const { fetchImpl } = fakeFetch(({ url }) => {
      if (url.endsWith("/graphql")) {
        return { data: { findDocuments: { items: [
          { id: "v1", name: "Research", slug: "research", state: { global: { nodes: [
            { kind: "file", documentType: "bai/knowledge-note" }, { kind: "file", documentType: "bai/knowledge-note" }, { kind: "folder" } ] } } },
          { id: "w1", name: "Workflows", slug: "workflows", state: { global: { nodes: [] } } },
        ] } } };
      }
      if (url.endsWith("/d/v1")) return { id: "v1", slug: "research", name: "Research", meta: { preferredEditor: "knowledge-vault" } };
      if (url.endsWith("/d/w1")) return { id: "w1", slug: "workflows", name: "Workflows", meta: { preferredEditor: "workflow-studio" } };
      throw new Error(`unexpected ${url}`);
    });
    const vaults = await listVaultDrives(ORIGIN, fetchImpl);
    expect(vaults).toEqual([{ id: "v1", slug: "research", name: "Research", noteCount: 2, sourceCount: 0 }]);
  });
});

describe("createVaultDrive", () => {
  it("creates the drive with the vault app as preferred editor and sets the state name", async () => {
    const { fetchImpl, calls } = fakeFetch(({ body }) => {
      const q = String((body as { query: string }).query);
      if (q.includes("createDocument")) return { data: { DocumentDrive: { createDocument: { id: "v9", slug: "my-vault", name: "My vault" } } } };
      if (q.includes("setDriveName")) return { data: { DocumentDrive: { setDriveName: { id: "v9" } } } };
      throw new Error(`unexpected query ${q}`);
    });
    const vault = await createVaultDrive(ORIGIN, "My vault", fetchImpl);
    expect(vault).toEqual({ id: "v9", slug: "my-vault", name: "My vault", noteCount: 0, sourceCount: 0 });
    expect((calls[0]!.body as { variables: unknown }).variables).toEqual({
      name: "My vault", slug: "my-vault", preferredEditor: "knowledge-vault",
    });
    expect((calls[1]!.body as { variables: unknown }).variables).toEqual({ docId: "v9", input: { name: "My vault" } });
  });
  it("surfaces GraphQL errors instead of returning a half-made vault", async () => {
    const { fetchImpl } = fakeFetch(() => ({ errors: [{ message: "Forbidden" }] }));
    await expect(createVaultDrive(ORIGIN, "X", fetchImpl)).rejects.toThrow(/Forbidden/);
  });
});

describe("management: rename, delete, the Workflows drive", () => {
  const origin = "http://127.0.0.1:4201";
  /** A fake engine: /d/<x> answers from `drives`; GraphQL calls are recorded and answered from `gql`. */
  function engine(drives: Record<string, { id: string; slug: string; name: string; editor?: string }>, gql: (query: string, variables: Record<string, unknown>) => unknown) {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: { body?: string }) => {
      const url = String(input);
      const m = url.match(/\/d\/([^/]+)$/);
      if (m) {
        const d = drives[decodeURIComponent(m[1]!)];
        return d ? new Response(JSON.stringify({ id: d.id, slug: d.slug, name: d.name, meta: d.editor ? { preferredEditor: d.editor } : {} })) : new Response("{}", { status: 404 });
      }
      const body = JSON.parse(init?.body ?? "{}") as { query: string; variables: Record<string, unknown> };
      calls.push({ query: body.query, variables: body.variables ?? {} });
      return new Response(JSON.stringify({ data: gql(body.query, body.variables ?? {}) }));
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  }
  const vault = { id: "v1", slug: "research", name: "Research", editor: VAULT_APP_ID };
  const workflows = { id: "w1", slug: "workflows", name: "Workflows", editor: WORKFLOWS_APP_ID };

  it("renames a vault through setDriveName and returns the new name", async () => {
    const e = engine({ v1: vault }, () => ({ DocumentDrive: { setDriveName: { id: "v1" } } }));
    expect(await renameVaultDrive(origin, "v1", "Lab notes", e.fetchImpl)).toEqual({ id: "v1", slug: "research", name: "Lab notes" });
    expect(e.calls[0]!.variables).toEqual({ docId: "v1", input: { name: "Lab notes" } });
  });
  it("deletes a vault with CASCADE, and only a vault — the Workflows drive is refused before any mutation", async () => {
    const e = engine({ v1: vault, w1: workflows }, () => ({ deleteDocuments: true }));
    await deleteVaultDrive(origin, "v1", e.fetchImpl);
    expect(e.calls[0]!.query).toContain("deleteDocuments(identifiers: $ids, propagate: CASCADE)");
    expect(e.calls[0]!.variables).toEqual({ ids: ["v1"] });
    await expect(deleteVaultDrive(origin, "w1", e.fetchImpl)).rejects.toBeInstanceOf(NotAVaultError);
    await expect(deleteVaultDrive(origin, "missing", e.fetchImpl)).rejects.toBeInstanceOf(NotAVaultError);
    expect(e.calls).toHaveLength(1);
  });
  it("finds the existing Workflows drive by its app id without creating another", async () => {
    const e = engine({ v1: vault, w1: workflows }, () => ({ findDocuments: { items: [{ id: "v1", name: "Research", slug: "research" }, { id: "w1", name: "Workflows", slug: "workflows" }] } }));
    expect(await ensureWorkflowsDrive(origin, e.fetchImpl)).toEqual({ id: "w1", slug: "workflows", name: "Workflows" });
    expect(e.calls.filter((c) => c.query.includes("createDocument"))).toHaveLength(0);
  });
  it("creates the Workflows drive once, yielding the slug to a vault that already took it", async () => {
    const taken = { id: "v2", slug: "workflows", name: "Workflows (a vault)", editor: VAULT_APP_ID };
    const e = engine({ v2: taken, workflows: taken }, (q) =>
      q.includes("findDocuments") ? { findDocuments: { items: [{ id: "v2", name: "Workflows (a vault)", slug: "workflows" }] } }
      : q.includes("createDocument") ? { DocumentDrive: { createDocument: { id: "w9", slug: "workflows-studio", name: "Workflows" } } }
      : { DocumentDrive: { setDriveName: { id: "w9" } } });
    expect(await ensureWorkflowsDrive(origin, e.fetchImpl)).toEqual({ id: "w9", slug: "workflows-studio", name: "Workflows" });
    const create = e.calls.find((c) => c.query.includes("createDocument"))!;
    expect(create.variables).toEqual({ name: "Workflows", slug: "workflows-studio", preferredEditor: "workflow-studio" });
  });
});
