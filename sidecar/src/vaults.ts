export type VaultSummary = { id: string; slug: string; name: string; noteCount: number; sourceCount: number };
export type DriveRef = { id: string; slug: string; name: string };
export const VAULT_APP_ID = "knowledge-vault";
/** The Workflow Studio drive the engine keeps for workflows and connections (as Vetra does). */
export const WORKFLOWS_APP_ID = "workflow-studio";
export const WORKFLOWS_SLUG = "workflows";

/** Thrown when a management route names a drive that is not a vault (the Workflows drive, a foreign drive). */
export class NotAVaultError extends Error {}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function gql<T>(origin: string, query: string, variables: Record<string, unknown>, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${origin}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Switchboard answered HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  if (!json.data) throw new Error("Switchboard answered without data");
  return json.data;
}

type DriveItem = {
  id: string;
  name: string;
  slug: string;
  state?: { global?: { nodes?: { kind?: string; documentType?: string }[] } };
};
type DriveInfo = { id: string; slug: string; name: string; meta?: { preferredEditor?: string } };

function countFiles(item: DriveItem, documentType: string): number {
  return (item.state?.global?.nodes ?? []).filter((n) => n.kind === "file" && n.documentType === documentType).length;
}

export async function listVaultDrives(origin: string, fetchImpl: typeof fetch = fetch): Promise<VaultSummary[]> {
  const data = await gql<{ findDocuments: { items: DriveItem[] } }>(
    origin,
    `{ findDocuments(search: { type: "powerhouse/document-drive" }) { items { id name slug state } } }`,
    {},
    fetchImpl,
  );
  const out: VaultSummary[] = [];
  for (const item of data.findDocuments.items) {
    const res = await fetchImpl(`${origin}/d/${encodeURIComponent(item.id)}`);
    if (!res.ok) continue;
    const info = (await res.json()) as DriveInfo;
    if (info.meta?.preferredEditor !== VAULT_APP_ID) continue;
    out.push({ id: item.id, slug: info.slug || item.slug, name: info.name || item.name, noteCount: countFiles(item, "bai/knowledge-note"), sourceCount: countFiles(item, "bai/source") });
  }
  return out;
}

/** The same two mutations `switchboard drives create --preferred-editor knowledge-vault` runs. */
export async function createVaultDrive(origin: string, name: string, fetchImpl: typeof fetch = fetch): Promise<VaultSummary> {
  const slug = slugify(name) || "vault";
  const created = await gql<{ DocumentDrive: { createDocument: { id: string; slug: string; name: string } } }>(
    origin,
    `mutation($name: String!, $slug: String, $preferredEditor: String) { DocumentDrive { createDocument(name: $name, slug: $slug, preferredEditor: $preferredEditor) { id slug name } } }`,
    { name, slug, preferredEditor: VAULT_APP_ID },
    fetchImpl,
  );
  const drive = created.DocumentDrive.createDocument;
  // createDocument sets only the header name; the UI and /d/<id> read state.global.name.
  await gql(
    origin,
    `mutation($docId: PHID!, $input: DocumentDrive_SetDriveNameInput!) { DocumentDrive { setDriveName(docId: $docId, input: $input) { id } } }`,
    { docId: drive.id, input: { name } },
    fetchImpl,
  );
  return { id: drive.id, slug: drive.slug, name, noteCount: 0, sourceCount: 0 };
}

async function driveInfo(origin: string, idOrSlug: string, fetchImpl: typeof fetch): Promise<DriveInfo | null> {
  const res = await fetchImpl(`${origin}/d/${encodeURIComponent(idOrSlug)}`);
  if (!res.ok) return null;
  return (await res.json()) as DriveInfo;
}

async function requireVault(origin: string, id: string, fetchImpl: typeof fetch): Promise<DriveInfo> {
  const info = await driveInfo(origin, id, fetchImpl);
  if (!info || info.meta?.preferredEditor !== VAULT_APP_ID) throw new NotAVaultError("That drive is not a vault.");
  return info;
}

export async function renameVaultDrive(origin: string, id: string, name: string, fetchImpl: typeof fetch = fetch): Promise<DriveRef> {
  const info = await requireVault(origin, id, fetchImpl);
  await gql(
    origin,
    `mutation($docId: PHID!, $input: DocumentDrive_SetDriveNameInput!) { DocumentDrive { setDriveName(docId: $docId, input: $input) { id } } }`,
    { docId: id, input: { name } },
    fetchImpl,
  );
  return { id, slug: info.slug, name };
}

/** The drive and everything in it, as `switchboard drives delete` does. Only ever a vault. */
export async function deleteVaultDrive(origin: string, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await requireVault(origin, id, fetchImpl);
  await gql(origin, `mutation($ids: [String!]!) { deleteDocuments(identifiers: $ids, propagate: CASCADE) }`, { ids: [id] }, fetchImpl);
}

/** The drive carrying a given app, found by the app id rather than by slug (a vault named "Workflows" must not collide). */
async function findDriveByApp(origin: string, appId: string, fetchImpl: typeof fetch): Promise<DriveRef | null> {
  const data = await gql<{ findDocuments: { items: DriveItem[] } }>(
    origin,
    `{ findDocuments(search: { type: "powerhouse/document-drive" }) { items { id name slug } } }`,
    {},
    fetchImpl,
  );
  for (const item of data.findDocuments.items) {
    const info = await driveInfo(origin, item.id, fetchImpl);
    if (info?.meta?.preferredEditor === appId) return { id: item.id, slug: info.slug || item.slug, name: info.name || item.name };
  }
  return null;
}

/** The Workflows drive, created once (idempotent); the slug yields to an existing drive. */
export async function ensureWorkflowsDrive(origin: string, fetchImpl: typeof fetch = fetch): Promise<DriveRef> {
  const existing = await findDriveByApp(origin, WORKFLOWS_APP_ID, fetchImpl);
  if (existing) return existing;
  const slugTaken = (await driveInfo(origin, WORKFLOWS_SLUG, fetchImpl)) !== null;
  const slug = slugTaken ? `${WORKFLOWS_SLUG}-studio` : WORKFLOWS_SLUG;
  const created = await gql<{ DocumentDrive: { createDocument: { id: string; slug: string } } }>(
    origin,
    `mutation($name: String!, $slug: String, $preferredEditor: String) { DocumentDrive { createDocument(name: $name, slug: $slug, preferredEditor: $preferredEditor) { id slug name } } }`,
    { name: "Workflows", slug, preferredEditor: WORKFLOWS_APP_ID },
    fetchImpl,
  );
  const drive = created.DocumentDrive.createDocument;
  await gql(
    origin,
    `mutation($docId: PHID!, $input: DocumentDrive_SetDriveNameInput!) { DocumentDrive { setDriveName(docId: $docId, input: $input) { id } } }`,
    { docId: drive.id, input: { name: "Workflows" } },
    fetchImpl,
  );
  return { id: drive.id, slug: drive.slug, name: "Workflows" };
}
