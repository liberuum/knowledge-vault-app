// @vitest-environment jsdom
import { addDocument, deleteNode, ensurePHEventHandlers, setReactorClient, setReactorClientModule } from "@powerhousedao/reactor-browser";
import { beforeEach, describe, expect, it } from "vitest";
import { remoteClientModule, type ModuleClient } from "./remote-client-module.js";

/**
 * Workflow Studio's "+" and Delete are reactor-browser's full-client actions, addDocument and deleteNode. On the
 * desktop they reach this module's client (there is no in-browser reactor), and in 6.2.3-dev.90 they call its read
 * and write halves: read.newDocument, write.drives.addFile, write.drives.removeNode. A client that kept the older
 * flat shape threw on read.newDocument, after Studio had made the workflow's home folder: "+" left an empty folder.
 * These run the real functions against the module, installed the way reactor.ts installs it.
 */

type DriveNode = { id: string; kind: "file" | "folder"; name: string; parentFolder: string | null; documentType?: string };

/** The engine as the module sees it: one drive's nodes, kept as its mutations change them. */
function engine(start: DriveNode[]) {
  const nodes = start.map((n) => ({ ...n }));
  const deleted: string[] = [];
  let made = 0;
  const client: ModuleClient = {
    request: async <T,>(query: string, variables: Record<string, unknown> = {}) => {
      const created = /(\w+)\s*\{\s*createDocument\(/.exec(query);
      if (created) {
        const id = `doc-${++made}`;
        nodes.push({ id, kind: "file", name: String(variables.name), parentFolder: null, documentType: created[1] === "Connection" ? "powerhouse/connection" : "powerhouse/workflow" });
        return { [created[1]!]: { createDocument: { id } } } as T;
      }
      const input = variables.input as Record<string, string | undefined>;
      if (/moveNode\(/.test(query)) nodes.find((n) => n.id === input.srcFolder)!.parentFolder = input.targetParentFolder ?? null;
      if (/deleteNode\(/.test(query)) nodes.splice(nodes.findIndex((n) => n.id === input.id), 1);
      return {} as T;
    },
    get: async (id: string) => {
      if (id === "drive-1") return { header: { id, name: "Workflows", documentType: "powerhouse/document-drive" }, state: { global: { nodes } } } as never;
      const node = nodes.find((n) => n.id === id);
      if (!node) throw new Error(`Document ${id} not found`);
      return { header: { id, name: node.name, documentType: node.documentType }, state: { global: {} } } as never;
    },
    deleteDocument: async (id: string) => {
      deleted.push(id);
      nodes.splice(nodes.findIndex((n) => n.id === id), 1);
    },
  };
  return { client, nodes, deleted };
}

const lib = (id: string, name: string) =>
  ({ documentModels: [{ documentModel: { global: { id, name } }, utils: { createDocument: () => ({ header: { id: "page-local", documentType: id, name: "", meta: {} }, state: { document: {}, global: {} } }) } }] }) as never;
const libs = [lib("powerhouse/workflow", "Workflow"), lib("powerhouse/connection", "Connection")];

/** As reactor.ts: the engine's client in the store (the node cache reads through it), and this module beside it. */
function install(client: ModuleClient, nodes: DriveNode[]) {
  const reader = {
    read: {
      drives: {
        getNode: async (driveId: string, nodeId: string) => {
          const node = nodes.find((n) => n.id === nodeId);
          if (!node) throw new Error(`Node ${nodeId} not found`);
          return { ...node, driveId };
        },
      },
    },
  };
  setReactorClient(reader as unknown as Parameters<typeof setReactorClient>[0]);
  setReactorClientModule(remoteClientModule(client, libs) as unknown as Parameters<typeof setReactorClientModule>[0]);
}

describe("Workflow Studio's create and delete through reactor-browser, on the desktop's module", () => {
  beforeEach(() => {
    ensurePHEventHandlers();
  });

  it("+ creates the workflow through the engine, inside the home folder Studio made for it", async () => {
    const e = engine([{ id: "home-1", kind: "folder", name: "V · Workflow 1", parentFolder: null }]);
    install(e.client, e.nodes);
    const node = await addDocument("drive-1", "Workflow 1", "powerhouse/workflow", "home-1");
    expect(node).toEqual({ id: "doc-1", name: "Workflow 1", documentType: "powerhouse/workflow", parentFolder: "home-1", kind: "file" });
    expect(e.nodes).toContainEqual({ id: "doc-1", kind: "file", name: "Workflow 1", parentFolder: "home-1", documentType: "powerhouse/workflow" });
  });

  it("a connection is made the same way, at the drive's root", async () => {
    const e = engine([]);
    install(e.client, e.nodes);
    const node = await addDocument("drive-1", "Connection 1", "powerhouse/connection");
    expect(node).toMatchObject({ id: "doc-1", name: "Connection 1", documentType: "powerhouse/connection", kind: "file" });
    expect(e.nodes).toEqual([{ id: "doc-1", kind: "file", name: "Connection 1", parentFolder: null, documentType: "powerhouse/connection" }]);
  });

  it("Delete removes the workflow with its home folder, so it cannot keep firing", async () => {
    const e = engine([
      { id: "home-1", kind: "folder", name: "V · Workflow 1", parentFolder: null },
      { id: "wf-1", kind: "file", name: "Workflow 1", parentFolder: "home-1", documentType: "powerhouse/workflow" },
      { id: "wf-2", kind: "file", name: "Workflow 2", parentFolder: null, documentType: "powerhouse/workflow" },
    ]);
    install(e.client, e.nodes);
    await deleteNode("drive-1", "home-1");
    expect(e.deleted).toEqual(["wf-1"]);
    expect(e.nodes.map((n) => n.id)).toEqual(["wf-2"]);
  });

  it("deletes a single document", async () => {
    const e = engine([{ id: "wf-2", kind: "file", name: "Workflow 2", parentFolder: null, documentType: "powerhouse/workflow" }]);
    install(e.client, e.nodes);
    await deleteNode("drive-1", "wf-2");
    expect(e.deleted).toEqual(["wf-2"]);
    expect(e.nodes).toEqual([]);
  });
});
