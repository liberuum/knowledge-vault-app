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

/** The vault's name (the drive's) and its nodes, in one read. */
export async function readVaultDrive(origin: string, driveId: string, f: typeof fetch): Promise<{ name: string; nodes: DriveNode[] }> {
  const data = await gql<{ document: { document: { name?: string | null; state: { global?: { name?: string | null; nodes?: DriveNode[] }; nodes?: DriveNode[] } | null } } }>(
    origin,
    `query($id: String!) { document(idOrSlug: $id) { document { name state } } }`,
    { id: driveId },
    f,
  );
  const doc = data.document.document;
  return { name: (doc.state?.global?.name || doc.name || "").trim(), nodes: doc.state?.global?.nodes ?? doc.state?.nodes ?? [] };
}

export async function readNodes(origin: string, driveId: string, f: typeof fetch): Promise<DriveNode[]> {
  return (await readVaultDrive(origin, driveId, f)).nodes;
}

/**
 * Names the vault in its own config (`bai/vault-config`), which the vault app shows before the drive's name
 * (use-vault-name.ts in the vault package): set when the vault is made, kept in step when it is renamed.
 * INITIALIZE_CONFIG is the model's only way to set the name, and it sets the domain too, so the domain the
 * config has is kept. `onlyIfUnnamed`: leave a config that has a name as it is. Says whether it wrote.
 */
export async function nameVaultConfig(origin: string, configId: string, name: string, f: typeof fetch, options: { onlyIfUnnamed?: boolean } = {}): Promise<boolean> {
  const wanted = name.trim();
  if (!wanted) return false;
  const data = await gql<{ document: { document: { state: { global?: { name?: string | null; domain?: string | null } } | null } } }>(
    origin,
    `query($id: String!) { document(idOrSlug: $id) { document { state } } }`,
    { id: configId },
    f,
  );
  const config = data.document.document.state?.global ?? {};
  const current = config.name?.trim() ?? "";
  if (current === wanted || (options.onlyIfUnnamed && current)) return false;
  await execute(origin, configId, toActions([{ type: "INITIALIZE_CONFIG", input: { name: wanted, domain: config.domain ?? "", updatedAt: new Date().toISOString() } }]), f);
  return true;
}

/** The vault's config document, when it has one. */
export function vaultConfigId(nodes: readonly DriveNode[]): string | undefined {
  return nodes.find((n) => n.kind === "file" && n.documentType === "bai/vault-config")?.id;
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
  const { name: vaultName, nodes } = await readVaultDrive(origin, driveId, fetchImpl);
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
  let configId: string | undefined;
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
    if (s.documentType === "bai/vault-config") configId = id;
  }
  // The vault's name in its config too, the one the vault app shows; a vault made before this, unnamed there, gets
  // it now. Never in the way of the rest: a vault without it still opens, with its drive's name.
  configId ??= vaultConfigId(nodes);
  if (configId) {
    await nameVaultConfig(origin, configId, vaultName, fetchImpl, { onlyIfUnnamed: true }).catch((e: unknown) =>
      console.warn(`[sidecar] vault ${driveId}: its config keeps no name for now (${e instanceof Error ? e.message : String(e)})`),
    );
  }
  return { folders: adds.length, documents };
}
