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
 * reactor-browser's drive helpers (`addDocument`, `deleteNode`, used by Workflow
 * Studio) call that slot's client, which the desktop deliberately never has: the
 * engine is the only reactor. This answers those calls over the engine's GraphQL
 * API, the same way the vault app creates documents — the engine builds and signs
 * the document, nothing is constructed in the page and sent. `reactorModule` stays
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

  const adapter = {
    get: (id: string) => client.get(id),
    getDocumentModelModule: async (type: string) => {
      const module = moduleFor(type);
      if (!module) throw new Error(`No document model registered for ${type}`);
      return module;
    },
    getDocumentModelModules: async () => ({ results: modules() }),
    // The page's document is never sent (the engine creates it), so its policy is moot.
    getCreateSignaturePolicy: async () => "legacy" as const,
    getCreateProtocolVersions: async () => ({}),
    drives: {
      async addFile(driveId: string, document: PHDocument, parentFolder?: string | null) {
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
        return client.get(id);
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
          await refreshDrive(driveId);
          return;
        }
        await client.deleteDocument(nodeId);
        await refreshDrive(driveId);
      },
    },
  };
  return { kind: "remote" as const, client: adapter };
}
