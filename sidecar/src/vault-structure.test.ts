import { describe, expect, it } from "vitest";
import { initVaultStructure, VAULT_FOLDERS, VAULT_SINGLETONS } from "./vault-structure.js";

type Node = { id: string; kind: string; name: string; parentFolder?: string | null; documentType?: string };

/** A drive on a fake reactor: execute applies ADD_FOLDER, createDocument adds a file at the root, moveNode moves it. */
function fakeReactor(initial: Node[] = []) {
  const nodes: Node[] = [...initial];
  const ops: Array<{ index: number; error: null; action: { type: string } }> = [];
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (query.includes("execute(")) {
      for (const a of variables.a) {
        calls.push(`${a.type} ${a.input.name}`);
        nodes.push({ id: a.input.id, kind: "folder", name: a.input.name, parentFolder: a.input.parentFolder });
        ops.push({ index: ops.length, error: null, action: { type: a.type } });
      }
      return reply({ execute: { id: "drive" } });
    }
    if (query.includes("operations(")) return reply({ document: { document: { operations: { items: ops } } } });
    if (query.includes("document(idOrSlug")) return reply({ document: { document: { state: { global: { nodes } } } } });
    const ns = /\{ (\w+) \{ createDocument/.exec(query)?.[1];
    if (ns) {
      const id = `doc-${ns}`;
      calls.push(`create ${ns}`);
      nodes.push({ id, kind: "file", name: variables.name, parentFolder: null, documentType: VAULT_SINGLETONS.find((s) => s.namespace === ns)!.documentType });
      return reply({ [ns]: { createDocument: { id } } });
    }
    if (query.includes("moveNode")) {
      nodes.find((n) => n.id === variables.input.srcFolder)!.parentFolder = variables.input.targetParentFolder;
      return reply({ DocumentDrive: { moveNode: { id: "drive" } } });
    }
    throw new Error(`unexpected query: ${query}`);
  }) as unknown as typeof fetch;
  const pathOf = (n: Node): string => {
    const parent = n.parentFolder ? nodes.find((p) => p.id === n.parentFolder) : undefined;
    return parent ? `${pathOf(parent)}/${n.name}` : n.name;
  };
  return { nodes, calls, fetchImpl, pathOf };
}

describe("initVaultStructure", () => {
  it("creates the vault app's folders, parents first, and each standing document in its folder", async () => {
    const r = fakeReactor();
    expect(await initVaultStructure("http://e", "drive", r.fetchImpl)).toEqual({ folders: VAULT_FOLDERS.length, documents: 3 });
    const folders = r.nodes.filter((n) => n.kind === "folder").map(r.pathOf);
    expect(folders).toEqual(VAULT_FOLDERS.map((f) => (f.parentPath ? `${f.parentPath}/${f.name}` : f.name)));
    for (const s of VAULT_SINGLETONS) {
      const file = r.nodes.find((n) => n.documentType === s.documentType)!;
      expect(r.pathOf(file)).toBe(`${s.folderPath}/${s.name}`);
    }
  });

  it("adds only what is missing, so a vault the app already set up is left as it is", async () => {
    const r = fakeReactor();
    await initVaultStructure("http://e", "drive", r.fetchImpl);
    const before = r.calls.length;
    expect(await initVaultStructure("http://e", "drive", r.fetchImpl)).toEqual({ folders: 0, documents: 0 });
    expect(r.calls.length).toBe(before);
  });
});
