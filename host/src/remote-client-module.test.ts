import { describe, expect, it } from "vitest";
import { remoteClientModule, type ModuleClient } from "./remote-client-module.js";

type Call = { query: string; variables?: Record<string, unknown> };

function fakeClient(nodes: { id: string; kind: string; parentFolder?: string }[] = []) {
  const calls: Call[] = [];
  const deleted: string[] = [];
  const client: ModuleClient = {
    request: async <T,>(query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables });
      if (query.includes("createEmptyDocument")) return { createEmptyDocument: { id: "new-generic" } } as T;
      const ns = /\{\s*(\w+)\s*\{\s*createDocument/.exec(query)?.[1];
      if (ns) return { [ns]: { createDocument: { id: "new-typed" } } } as T;
      return {} as T;
    },
    get: async (id: string) =>
      ({ header: { id, name: id === "new-typed" ? "Untitled 1" : "x", documentType: "powerhouse/workflow" }, state: { global: { nodes } } }) as never,
    deleteDocument: async (id: string) => {
      deleted.push(id);
    },
  };
  return { client, calls, deleted };
}

const lib = (id: string, name: string) =>
  ({ documentModels: [{ documentModel: { global: { id, name } }, utils: { createDocument: () => ({ header: { documentType: id, meta: {} }, state: { document: {} } }) } }] }) as never;
const libs = [lib("powerhouse/workflow", "Workflow"), lib("powerhouse/connection", "Connection")];

describe("remoteClientModule", () => {
  it("creates through the model's own GraphQL namespace, in the drive, with the name and editor", async () => {
    const { client, calls } = fakeClient();
    const m = remoteClientModule(client, libs);
    const doc = { header: { documentType: "powerhouse/workflow", name: "Untitled 1", meta: { preferredEditor: "workflow-editor" } } };
    const made = await m.client.drives.addFile("drive-1", doc as never, undefined);
    expect(calls[0]!.query).toMatch(/Workflow\s*\{\s*createDocument\(/);
    expect(calls[0]!.variables).toEqual({ name: "Untitled 1", parent: "drive-1", editor: "workflow-editor" });
    expect(made.header.id).toBe("new-typed");
    expect(calls).toHaveLength(1);
  });

  it("moves the new document into a folder when one is given", async () => {
    const { client, calls } = fakeClient();
    const m = remoteClientModule(client, libs);
    await m.client.drives.addFile("drive-1", { header: { documentType: "powerhouse/connection", name: "OpenRouter", meta: {} } } as never, "folder-9");
    expect(calls[1]!.query).toMatch(/DocumentDrive\s*\{\s*moveNode\(/);
    expect(calls[1]!.variables).toEqual({ drive: "drive-1", input: { srcFolder: "new-typed", targetParentFolder: "folder-9" } });
  });

  it("falls back to the generic create and names the node for a model without a known namespace", async () => {
    const { client, calls } = fakeClient();
    const m = remoteClientModule(client, libs);
    await m.client.drives.addFile("drive-1", { header: { documentType: "acme/other", name: "Thing", meta: {} } } as never, undefined);
    expect(calls[0]!.query).toMatch(/createEmptyDocument\(documentType: \$type, parentIdOrSlug: \$parent\)/);
    expect(calls[0]!.variables).toEqual({ type: "acme/other", parent: "drive-1" });
    expect(calls[1]!.query).toMatch(/updateNode\(/);
    expect(calls[1]!.variables).toEqual({ drive: "drive-1", input: { id: "new-generic", name: "Thing" } });
  });

  it("deletes a document through the engine, and a folder through the drive — its documents first, or they keep running", async () => {
    // A workflow's home folder (Studio, 6.2.3-dev.47), with a nested folder, and a document outside it.
    const tree = [
      { id: "doc-1", kind: "file" },
      { id: "dir-1", kind: "folder" },
      { id: "wf-1", kind: "file", parentFolder: "dir-1" },
      { id: "dir-2", kind: "folder", parentFolder: "dir-1" },
      { id: "conn-1", kind: "file", parentFolder: "dir-2" },
    ];
    const files = fakeClient(tree);
    const m = remoteClientModule(files.client, libs);
    await m.client.drives.removeNode("drive-1", "doc-1");
    expect(files.deleted).toEqual(["doc-1"]);
    await m.client.drives.removeNode("drive-1", "dir-1");
    expect(files.deleted).toEqual(["doc-1", "wf-1", "conn-1"]);
    expect(files.calls.at(-1)!.query).toMatch(/DocumentDrive\s*\{\s*deleteNode\(/);
    // The engine's model mutations take `input: <Model>_<Op>Input!`: a nullable variable fails validation there.
    for (const { query } of files.calls) for (const m of query.matchAll(/\$input: (DocumentDrive_\w+Input)(!?)/g)) expect(m[2], m[1]).toBe("!");
    expect(files.calls.at(-1)!.variables).toEqual({ drive: "drive-1", input: { id: "dir-1" } });
  });

  it("answers the model lookups addDocument makes before creating", async () => {
    const m = remoteClientModule(fakeClient().client, libs);
    expect((await m.client.getDocumentModelModule("powerhouse/connection")).documentModel.global.name).toBe("Connection");
    expect((await m.client.getDocumentModelModules()).results).toHaveLength(2);
    await expect(m.client.getDocumentModelModule("acme/missing")).rejects.toThrow(/acme\/missing/);
    expect(await m.client.getCreateSignaturePolicy()).toBe("legacy");
    expect(await m.client.getCreateProtocolVersions()).toEqual({});
  });

  it("refreshes the drive after a create, a move and a delete, before returning", async () => {
    const files = fakeClient([{ id: "doc-1", kind: "file" }]);
    const refreshed: string[] = [];
    const m = remoteClientModule(files.client, libs, async (id) => {
      refreshed.push(id);
    });
    await m.client.drives.addFile("drive-1", { header: { documentType: "powerhouse/workflow", name: "W", meta: {} } } as never, "folder-9");
    expect(refreshed).toEqual(["drive-1"]);
    await m.client.drives.removeNode("drive-1", "doc-1");
    expect(refreshed).toEqual(["drive-1", "drive-1"]);
  });

  it("does not fail a write because the refresh failed", async () => {
    const m = remoteClientModule(fakeClient().client, libs, async () => {
      throw new Error("offline");
    });
    const made = await m.client.drives.addFile("drive-1", { header: { documentType: "powerhouse/workflow", name: "W", meta: {} } } as never, undefined);
    expect(made.header.id).toBe("new-typed");
  });

  it("leaves the full-reactor parts empty, so sync and registry lookups stay off", () => {
    const m = remoteClientModule(fakeClient().client, libs) as Record<string, unknown>;
    expect(m.reactorModule).toBeUndefined();
  });
});
