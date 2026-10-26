import { describe, expect, it } from "vitest";
import { initVaultStructure, nameVaultConfig, VAULT_FOLDERS, VAULT_SINGLETONS } from "./vault-structure.js";

type Node = { id: string; kind: string; name: string; parentFolder?: string | null; documentType?: string };

type Config = { name: string | null; domain: string | null };

/**
 * A drive on a fake reactor: execute applies ADD_FOLDER to the drive and INITIALIZE_CONFIG to a config, createDocument
 * adds a file at the root, moveNode moves it. The drive is named; each config document keeps its own state.
 */
function fakeReactor(initial: Node[] = [], options: { driveName?: string; configs?: Record<string, Config> } = {}) {
  const nodes: Node[] = [...initial];
  const configs: Record<string, Config> = { ...options.configs };
  const ops: Array<{ index: number; error: null; action: { id: string; type: string } }> = [];
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (query.includes("execute(")) {
      for (const a of variables.a) {
        if (a.type === "INITIALIZE_CONFIG") {
          calls.push(`INITIALIZE_CONFIG ${a.input.name} (${a.input.domain})`);
          configs[variables.id] = { name: a.input.name, domain: a.input.domain };
        } else {
          calls.push(`${a.type} ${a.input.name}`);
          nodes.push({ id: a.input.id, kind: "folder", name: a.input.name, parentFolder: a.input.parentFolder });
        }
        ops.push({ index: ops.length, error: null, action: { id: a.id, type: a.type } });
      }
      return reply({ execute: { id: variables.id } });
    }
    if (query.includes("operations(")) return reply({ document: { document: { operations: { items: ops } } } });
    if (query.includes("document(idOrSlug")) {
      const config = configs[variables.id];
      if (config) return reply({ document: { document: { name: "VaultConfig", state: { global: config } } } });
      return reply({ document: { document: { name: options.driveName ?? "drive", state: { global: { name: options.driveName ?? "drive", nodes } } } } });
    }
    const ns = /\{ (\w+) \{ createDocument/.exec(query)?.[1];
    if (ns) {
      const id = `doc-${ns}`;
      calls.push(`create ${ns}`);
      const documentType = VAULT_SINGLETONS.find((s) => s.namespace === ns)!.documentType;
      nodes.push({ id, kind: "file", name: variables.name, parentFolder: null, documentType });
      if (documentType === "bai/vault-config") configs[id] = { name: null, domain: null };
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
  return { nodes, configs, calls, fetchImpl, pathOf };
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

  it("names the vault in its config, the name the vault app shows first", async () => {
    const r = fakeReactor([], { driveName: "My vault" });
    await initVaultStructure("http://e", "drive", r.fetchImpl);
    expect(r.configs["doc-VaultConfig"]).toEqual({ name: "My vault", domain: "" });
    expect(r.calls).toContain("INITIALIZE_CONFIG My vault ()");
  });

  it("names an existing config that has no name, keeping its domain; one that has a name is left as it is", async () => {
    const config: Node = { id: "cfg", kind: "file", name: "VaultConfig", parentFolder: null, documentType: "bai/vault-config" };
    const unnamed = fakeReactor([config], { driveName: "Research", configs: { cfg: { name: "", domain: "Biology" } } });
    await initVaultStructure("http://e", "drive", unnamed.fetchImpl);
    expect(unnamed.configs.cfg).toEqual({ name: "Research", domain: "Biology" });

    const named = fakeReactor([config], { driveName: "Research", configs: { cfg: { name: "The Lab", domain: "Biology" } } });
    await initVaultStructure("http://e", "drive", named.fetchImpl);
    expect(named.configs.cfg).toEqual({ name: "The Lab", domain: "Biology" });
    expect(named.calls.filter((c) => c.startsWith("INITIALIZE_CONFIG"))).toEqual([]);
  });
});

describe("nameVaultConfig", () => {
  it("renames a vault's config with the vault, keeping its domain, and writes nothing when the name is already right", async () => {
    const r = fakeReactor([], { configs: { cfg: { name: "My vault", domain: "Biology" } } });
    expect(await nameVaultConfig("http://e", "cfg", "Field notes", r.fetchImpl)).toBe(true);
    expect(r.configs.cfg).toEqual({ name: "Field notes", domain: "Biology" });
    expect(await nameVaultConfig("http://e", "cfg", "Field notes", r.fetchImpl)).toBe(false);
    expect(r.calls).toEqual(["INITIALIZE_CONFIG Field notes (Biology)"]);
  });
});
