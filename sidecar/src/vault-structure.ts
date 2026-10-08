import { randomUUID } from "node:crypto";
import { execute, gql, toActions } from "./reactor-gql.js";

/**
 * A vault's standing structure: the folders and the three standing documents the vault app creates the first time
 * a vault is opened (editors/knowledge-vault/hooks/use-drive-init.ts in the vault package). The engine creates them
 * with the vault, so a source can be added before anyone opens it — by the onboarding's sample, an agent or the CLI.
 * The vault app reads the server's tree before its own init, finds everything here and creates nothing.
 */
export const VAULT_FOLDERS: ReadonlyArray<{ name: string; parentPath?: string }> = [
  { name: "knowledge" },
  { name: "notes", parentPath: "knowledge" },
  { name: "inbox", parentPath: "knowledge" },
  { name: "insights", parentPath: "knowledge" },
  { name: "sources" },
  { name: "projects" },
  { name: "ops" },
  { name: "sessions", parentPath: "ops" },
  { name: "health", parentPath: "ops" },
  { name: "queue", parentPath: "ops" },
  { name: "self" },
  { name: "methodology", parentPath: "self" },
];

export const VAULT_SINGLETONS: ReadonlyArray<{ name: string; documentType: string; namespace: string; folderPath: string }> = [
  { name: "PipelineQueue", documentType: "bai/pipeline-queue", namespace: "PipelineQueue", folderPath: "ops/queue" },
  { name: "HealthReport", documentType: "bai/health-report", namespace: "HealthReport", folderPath: "ops/health" },
  { name: "VaultConfig", documentType: "bai/vault-config", namespace: "VaultConfig", folderPath: "self" },
];

type DriveNode = { id: string; kind: string; name: string; parentFolder?: string | null; documentType?: string };

export async function readNodes(origin: string, driveId: string, f: typeof fetch): Promise<DriveNode[]> {
  const data = await gql<{ document: { document: { state: { global?: { nodes?: DriveNode[] }; nodes?: DriveNode[] } | null } } }>(
    origin,
    `query($id: String!) { document(idOrSlug: $id) { document { state } } }`,
    { id: driveId },
    f,
  );
  const state = data.document.document.state;
  return state?.global?.nodes ?? state?.nodes ?? [];
}

/** Path ("ops/queue") → folder id, for the folders already in the drive. */
function folderPaths(nodes: readonly DriveNode[]): Map<string, string> {
  const folders = nodes.filter((n) => n.kind === "folder");
  const byId = new Map(folders.map((n) => [n.id, n]));
  const paths = new Map<string, string>();
  for (const folder of folders) {
    const parts: string[] = [];
    let at: DriveNode | undefined = folder;
    for (let depth = 0; at && depth < 16; depth += 1) {
      parts.unshift(at.name);
      at = at.parentFolder ? byId.get(at.parentFolder) : undefined;
    }
    paths.set(parts.join("/"), folder.id);
  }
  return paths;
}

/** Adds what is missing — folders parents first, in one checked batch — then the standing documents, each moved into its folder. */
export async function initVaultStructure(origin: string, driveId: string, fetchImpl: typeof fetch = fetch): Promise<{ folders: number; documents: number }> {
  const nodes = await readNodes(origin, driveId, fetchImpl);
  const folderIds = folderPaths(nodes);
  const adds: Array<{ type: string; input: { id: string; name: string; parentFolder: string | null } }> = [];
  for (const folder of VAULT_FOLDERS) {
    const path = folder.parentPath ? `${folder.parentPath}/${folder.name}` : folder.name;
    if (folderIds.has(path)) continue;
    const id = randomUUID();
    adds.push({ type: "ADD_FOLDER", input: { id, name: folder.name, parentFolder: folder.parentPath ? (folderIds.get(folder.parentPath) ?? null) : null } });
    folderIds.set(path, id);
  }
  await execute(origin, driveId, toActions(adds), fetchImpl);

  const present = new Set(nodes.filter((n) => n.kind === "file").map((n) => n.documentType));
  let documents = 0;
  for (const s of VAULT_SINGLETONS) {
    if (present.has(s.documentType)) continue;
    const created = await gql<Record<string, { createDocument: { id: string } }>>(
      origin,
      `mutation($name: String!, $parent: String) { ${s.namespace} { createDocument(name: $name, parentIdOrSlug: $parent) { id } } }`,
      { name: s.name, parent: driveId },
      fetchImpl,
    );
    const id = created[s.namespace]?.createDocument?.id;
    if (!id) throw new Error(`${s.namespace}.createDocument answered without an id`);
    const folder = folderIds.get(s.folderPath);
    if (folder) {
      await gql(
        origin,
        `mutation($docId: String!, $input: DocumentDrive_MoveNodeInput!) { DocumentDrive { moveNode(documentIdOrSlug: $docId, input: $input) { id } } }`,
        { docId: driveId, input: { srcFolder: id, targetParentFolder: folder } },
        fetchImpl,
      );
    }
    documents += 1;
  }
  return { folders: adds.length, documents };
}
