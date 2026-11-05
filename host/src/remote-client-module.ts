import type { PHGlobal } from "@powerhousedao/reactor-browser";
import type { DocumentModelLib, DocumentModelModule, PHDocument } from "document-model";

/**
 * What the module needs from the Switchboard client: GraphQL requests, reads and
 * deletes. `GraphQLReactorClient` satisfies it.
 */
export type ModuleClient = {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  get(id: string): Promise<PHDocument>;
  deleteDocument(id: string): Promise<void>;
};

type DriveNode = { id: string; kind: string; parentFolder?: string | null };

/** The full client reactor-browser's full-client actions call: Connect's router fills the slot there. */
type FullClient = NonNullable<PHGlobal["fullReactorClient"]>;
type DriveWrites = FullClient["write"]["drives"];
type WriteHandle = Awaited<ReturnType<DriveWrites["addFile"]>>;

/**
 * The part of the full client reactor-browser's full-client actions call on the desktop (addDocument,
 * deleteNode, copyNode, the model lookups), named as reactor names it: a member renamed or retyped upstream
 * fails the type check here, and remote-client-module.halves.test.ts catches a member they start to call.
 */
export type DesktopFullClient = {
  read: Pick<FullClient["read"], "newDocument" | "get" | "getDocumentModelModule" | "getDocumentModelModules">;
  write: { drives: Pick<DriveWrites, "addFile" | "removeNode"> };
};

/**
 * A write this module has finished: the engine's mutations have answered and the drive was read again before
 * it returns, so both stages are settled. No caller reads the receipt's job (addDocument reads the document,
 * deleteNode and copyNode await `readable`), so the receipt names the document and stops there.
 */
function settled(documentId: string, read: () => Promise<PHDocument>): WriteHandle {
  const receipt = Promise.resolve({ documentId, branch: "main" } as Awaited<WriteHandle["readable"]>);
  return {
    jobId: "",
    documentId,
    branch: "main",
    written: receipt,
    readable: receipt,
    document: <TDocument extends PHDocument = PHDocument>() => read() as Promise<TDocument>,
  };
}

/** A model's GraphQL namespace: its name in PascalCase ("Workflow", "Connection"). */
function namespaceOf(module: DocumentModelModule): string | undefined {
  const name = module.documentModel.global.name.replace(/[^A-Za-z0-9 ]/g, "");
  const ns = name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("");
  return /^[A-Za-z]\w*$/.test(ns) ? ns : undefined;
}

/**
 * Stand-in for Connect's in-browser reactor in `window.ph.reactorClientModule`.
 *
 * reactor-browser's full-client actions (`addDocument`, `deleteNode`, used by Workflow
 * Studio) call that slot's client, which the desktop deliberately never has: the
 * engine is the only reactor. They call its read and write halves (6.2.3-dev.90); this
 * answers them over the engine's GraphQL API, the same way the vault app creates
 * documents — the engine builds and signs the document. `read.newDocument` makes one in
 * the page only for addDocument to name; it is never sent. `reactorModule` stays
 * empty, so sync and registry lookups keep seeing "no local reactor".
 */
export function remoteClientModule(
  client: ModuleClient,
  libs: readonly DocumentModelLib[],
  /** Re-reads a document into the page's cache (the drive after a write): the engine changed it, the cache does not know. */
  refresh: (id: string) => Promise<unknown> = async () => undefined,
) {
  // A write has landed whatever the refresh does; the next change event catches the cache up.
  const refreshDrive = (driveId: string) => refresh(driveId).catch(() => undefined);
  const modules = (): DocumentModelModule[] => libs.flatMap((lib) => [...lib.documentModels]) as DocumentModelModule[];
  const moduleFor = (type: string) => modules().find((m) => m.documentModel.global.id === type);

  async function createInDrive(driveId: string, type: string, name: string, editor?: string): Promise<string> {
    const module = moduleFor(type);
    const ns = module ? namespaceOf(module) : undefined;
    if (ns) {
      const data = await client.request<Record<string, { createDocument?: { id?: string } }>>(
        `mutation DesktopCreate($name: String!, $parent: String, $editor: String) {
           ${ns} { createDocument(name: $name, parentIdOrSlug: $parent, preferredEditor: $editor) { id } }
         }`,
        { name, parent: driveId, editor },
      );
      const id = data[ns]?.createDocument?.id;
      if (!id) throw new Error(`The engine did not create the ${type} document`);
      return id;
    }
    const data = await client.request<{ createEmptyDocument?: { id?: string } }>(
      `mutation DesktopCreateEmpty($type: String!, $parent: String) {
         createEmptyDocument(documentType: $type, parentIdOrSlug: $parent) { id }
       }`,
      { type, parent: driveId },
    );
    const id = data.createEmptyDocument?.id;
    if (!id) throw new Error(`The engine did not create the ${type} document`);
    await client.request(
      `mutation DesktopName($drive: String, $input: DocumentDrive_UpdateNodeInput!) {
         DocumentDrive { updateNode(documentIdOrSlug: $drive, input: $input) { id } }
       }`,
      { drive: driveId, input: { id, name } },
    );
    return id;
  }

  const requireModule = (type: string): DocumentModelModule => {
    const module = moduleFor(type);
    if (!module) throw new Error(`No document model registered for ${type}`);
    return module;
  };

  const fullClient: DesktopFullClient = {
    read: {
      // addDocument names it and hands it to write.drives.addFile, which has the engine create the document itself.
      newDocument: async <TDocument extends PHDocument = PHDocument>(documentType: string) => requireModule(documentType).utils.createDocument() as TDocument,
      get: <TDocument extends PHDocument = PHDocument>(identifier: string) => client.get(identifier) as Promise<TDocument>,
      getDocumentModelModule: async (type: string) => requireModule(type),
      getDocumentModelModules: async () => {
        const results = modules();
        return { results, options: { cursor: "0", limit: results.length } };
      },
    },
    write: {
      drives: {
        async addFile(driveId: string, document: PHDocument, parentFolder?: string) {
          const editor = document.header.meta?.preferredEditor;
          const id = await createInDrive(driveId, document.header.documentType, document.header.name, editor ?? undefined);
          if (parentFolder) {
            await client.request(
              `mutation DesktopMove($drive: String, $input: DocumentDrive_MoveNodeInput!) {
                 DocumentDrive { moveNode(documentIdOrSlug: $drive, input: $input) { id } }
               }`,
              { drive: driveId, input: { srcFolder: id, targetParentFolder: parentFolder } },
            );
          }
          // Before returning: Studio selects the new node next, which needs it in the cached drive.
          await refreshDrive(driveId);
          return settled(id, () => client.get(id));
        },
        async removeNode(driveId: string, nodeId: string) {
          const drive = await client.get(driveId);
          const nodes = ((drive.state as { global?: { nodes?: DriveNode[] } }).global?.nodes ?? []);
          const node = nodes.find((n) => n.id === nodeId);
          if (node?.kind === "folder") {
            // DELETE_NODE removes only the drive's entry: the documents under it stay alive, and a workflow
            // keeps firing. Studio deletes a workflow through its home folder (6.2.3-dev.47), so every
            // document under the folder goes first, as upstream's DriveClient.deleteNode does.
            const under = new Set([nodeId]);
            for (let grew = true; grew; ) {
              grew = false;
              for (const n of nodes) {
                if (n.parentFolder && under.has(n.parentFolder) && !under.has(n.id)) {
                  under.add(n.id);
                  grew = true;
                }
              }
            }
            for (const n of nodes) if (n.kind === "file" && under.has(n.id)) await client.deleteDocument(n.id);
            await client.request(
              `mutation DesktopDeleteNode($drive: String, $input: DocumentDrive_DeleteNodeInput!) {
                 DocumentDrive { deleteNode(documentIdOrSlug: $drive, input: $input) { id } }
               }`,
              { drive: driveId, input: { id: nodeId } },
            );
          } else {
            await client.deleteDocument(nodeId);
          }
          await refreshDrive(driveId);
          return settled(driveId, () => client.get(driveId));
        },
      },
    },
  };
  return { kind: "remote" as const, client: fullClient };
}
