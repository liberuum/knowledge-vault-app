import { readConfig, writeConfig } from "./settings.js";
import { listVaultDrives } from "./vaults.js";

/** A vault on a Switchboard the user has access to, reached in client mode (spec §5.5). */
export type RemoteVault = { kind: "remote"; id: string; slug: string; name: string; switchboardUrl: string; addedAt: string };
export type RemoteAccess = "write" | "read";
export type RemoteCheck = { id: string; slug: string; name: string; switchboardUrl: string; access: RemoteAccess };

export class RemoteInputError extends Error {}
export class RemoteAuthError extends Error {}
export class RemoteAccessError extends Error {}
export class RemoteNotFoundError extends Error {}
/** The server predates the GraphQL argument names this app uses (`idOrSlug`, 6.2.3-dev.35). */
export class RemoteTooOldError extends Error {}

/**
 * Spec §9: a server older than dev.35 has no `idOrSlug` argument on `document`; the
 * vault app would fail on its first query. A server that will not answer
 * introspection cannot be told apart, so it is not refused.
 */
async function assertServerCurrent(origin: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<void> {
  let fields: { name: string; args?: { name: string }[] }[] | undefined;
  try {
    const res = await fetchImpl(`${origin}/graphql`, { method: "POST", headers, body: JSON.stringify({ query: `{ __type(name: "Query") { fields { name args { name } } } }` }) });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: { __type?: { fields?: typeof fields } | null } };
    fields = json.data?.__type?.fields ?? undefined;
  } catch {
    return;
  }
  const document = fields?.find((f) => f.name === "document");
  if (document && !(document.args ?? []).some((a) => a.name === "idOrSlug")) {
    throw new RemoteTooOldError("This vault's server is too old for this app (it needs Powerhouse 6.2.3-dev.35 or newer).");
  }
}

const RESERVED = new Set(["graphql", "api", "d", "mcp", "health"]);

/**
 * What a person pastes: a Switchboard URL (`https://host/graphql`), a drive URL
 * (`https://host/d/<slug>`), `https://host/<slug>`, or just the origin plus a
 * separate drive id or slug. Returns the origin and the drive when one was named.
 */
export function parseRemoteVaultInput(input: string, drive?: string): { origin: string; drive?: string } {
  let url: URL;
  const raw = input.trim();
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new RemoteInputError("Enter the vault's address as a URL, like https://switchboard.example.com/graphql.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RemoteInputError("The address must start with https:// (or http:// for a local server).");
  const segments = url.pathname.split("/").filter(Boolean);
  let fromPath: string | undefined;
  if (segments[0] === "d" && segments[1]) fromPath = segments[1];
  else if (segments.length === 1 && !RESERVED.has(segments[0]!)) fromPath = segments[0];
  const named = drive?.trim() || fromPath;
  if (!named) return { origin: url.origin };
  try {
    return { origin: url.origin, drive: decodeURIComponent(named) };
  } catch {
    throw new RemoteInputError("The drive id or slug contains characters that cannot be decoded.");
  }
}

export function readRemoteVaults(dataDir: string): RemoteVault[] {
  const raw = readConfig(dataDir);
  const vaults = Array.isArray(raw.vaults) ? raw.vaults : [];
  return vaults.filter((v): v is RemoteVault => !!v && typeof v === "object" && (v as RemoteVault).kind === "remote" && typeof (v as RemoteVault).id === "string");
}

export function writeRemoteVaults(dataDir: string, remote: RemoteVault[]): void {
  const raw = readConfig(dataDir);
  const others = (Array.isArray(raw.vaults) ? raw.vaults : []).filter((v) => !v || typeof v !== "object" || (v as { kind?: string }).kind !== "remote");
  writeConfig(dataDir, { ...raw, vaults: [...others, ...remote] });
}

/** Ask the remote Switchboard, as the signed-in user, whether the drive exists and what it allows. */
export async function checkRemoteVault(origin: string, drive: string, token: string, fetchImpl: typeof fetch = fetch): Promise<RemoteCheck> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const res = await fetchImpl(`${origin}/d/${encodeURIComponent(drive)}`, { headers });
  if (res.status === 401) throw new RemoteAuthError("The server did not accept your sign-in. Sign in again and retry.");
  if (res.status === 403) throw new RemoteAccessError("You are signed in, but this server has not granted you access to that vault. Ask its administrator for READ on the drive.");
  if (res.status === 404) throw new RemoteNotFoundError("No vault with that id or slug on this server — or none you may read.");
  if (!res.ok) throw new Error(`The server answered HTTP ${res.status}.`);
  await assertServerCurrent(origin, headers, fetchImpl);
  const info = (await res.json()) as { id?: unknown; slug?: unknown; name?: unknown };
  if (typeof info.id !== "string" || !info.id) throw new Error("The server's answer did not name the drive.");
  const id = info.id;
  const slug = typeof info.slug === "string" && info.slug ? info.slug : id;
  const name = typeof info.name === "string" && info.name ? info.name : slug;
  let access: RemoteAccess = "read";
  try {
    const q = await fetchImpl(`${origin}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: `query($id: String!) { canExecuteOperation(documentIdOrSlug: $id, operationType: "ADD_FILE") }`, variables: { id } }),
    });
    const json = (await q.json()) as { data?: { canExecuteOperation?: boolean } };
    if (json.data?.canExecuteOperation === true) access = "write";
  } catch {
    // read is the floor; the vault app's own gate speaks for anything more
  }
  return { id, slug, name, switchboardUrl: origin, access };
}

/** No vault server answered at the address: a Connect app, a website, a typo. */
export class RemoteNotSwitchboardError extends Error {}

/** A vault the server lets the signed-in person read; `added` when it is already on this app's list. */
export type RemoteVaultOption = { id: string; slug: string; name: string; documents: number | null; added: boolean };
export type RemoteDiscovery = { switchboardUrl: string; vaults: RemoteVaultOption[]; hint?: string };

const VAULT_APP = "knowledge-vault";
/** The vault package's own listing: the drives whose app is the Knowledge Vault, among those the caller may read. */
const VAULTS_ROUTE = "/api/@powerhousedao/knowledge-note/drives";

function withAuth(fetchImpl: typeof fetch, token: string | undefined): typeof fetch {
  if (!token) return fetchImpl;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}

/** A Switchboard answers GraphQL at /graphql (or refuses a caller it does not know); a Connect app or a website does not. */
async function answersGraphql(origin: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${origin}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return true;
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: { __typename?: unknown } };
    return typeof body.data?.__typename === "string";
  } catch {
    return false;
  }
}

/** The origin as pasted when a Switchboard answers there; else Vetra's convention, switchboard.<host> beside <host>'s Connect. */
export async function resolveSwitchboard(origin: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (await answersGraphql(origin, fetchImpl)) return origin;
  const url = new URL(origin);
  if (!url.hostname.startsWith("switchboard.")) {
    const guess = `${url.protocol}//switchboard.${url.host}`;
    if (await answersGraphql(guess, fetchImpl)) return guess;
  }
  throw new RemoteNotSwitchboardError(`No vault server answered at ${url.host}. Paste the address of its Switchboard, like https://switchboard.example.com.`);
}

/**
 * The vaults on a server, as the signed-in person sees them. The server decides: its listing returns only the
 * drives whose app is the Knowledge Vault among those this person may read. A server without that listing (an
 * older vault package, a bare engine) is asked for its drives, and the vaults are kept by their preferred editor.
 * A link to one vault (…/d/<slug>) preselects it.
 */
export async function discoverRemoteVaults(input: string, token: string | undefined, addedIds: ReadonlySet<string>, fetchImpl: typeof fetch = fetch): Promise<RemoteDiscovery> {
  const parsed = parseRemoteVaultInput(input);
  const f = withAuth(fetchImpl, token);
  const origin = await resolveSwitchboard(parsed.origin, f);
  const res = await f(`${origin}${VAULTS_ROUTE}`);
  if (res.status === 401) {
    throw new RemoteAuthError(token ? "The server did not accept your sign-in. Sign in again and retry." : "This server shows its vaults only to people who are signed in. Sign in, then try again.");
  }
  if (res.status === 403) throw new RemoteAccessError("You are signed in, but this server does not let you list its vaults. Ask its administrator for access.");
  let found: Array<Omit<RemoteVaultOption, "added">>;
  if (res.ok) {
    const body = (await res.json()) as { drives?: Array<{ id?: unknown; slug?: unknown; name?: unknown; nodes?: unknown }> };
    found = (body.drives ?? [])
      .filter((d): d is { id: string; slug?: unknown; name?: unknown; nodes?: unknown } => typeof d.id === "string" && d.id !== "")
      .map((d) => ({ id: d.id, slug: typeof d.slug === "string" && d.slug ? d.slug : d.id, name: typeof d.name === "string" ? d.name : "", documents: typeof d.nodes === "number" ? d.nodes : null }));
  } else if (res.status === 404) {
    found = (await listVaultDrives(origin, f)).map((v) => ({ id: v.id, slug: v.slug, name: v.name, documents: null }));
  } else {
    throw new Error(`The server answered HTTP ${res.status}.`);
  }
  await assertServerCurrent(origin, { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, fetchImpl);
  // The drive's own name: the listing reports its state name, which is often the slug.
  const drive = async (idOrSlug: string) => {
    try {
      const r = await f(`${origin}/d/${encodeURIComponent(idOrSlug)}`);
      return r.ok ? ((await r.json()) as { id?: string; slug?: string; name?: string; meta?: { preferredEditor?: string } }) : null;
    } catch {
      return null;
    }
  };
  const vaults: RemoteVaultOption[] = [];
  for (const v of found) {
    const info = await drive(v.id);
    vaults.push({ ...v, name: info?.name || v.name || v.slug, added: addedIds.has(v.id) });
  }
  let hint: string | undefined;
  if (parsed.drive) {
    const info = await drive(parsed.drive);
    if (info?.id && info.meta?.preferredEditor === VAULT_APP) {
      hint = info.id;
      if (!vaults.some((v) => v.id === info.id)) vaults.push({ id: info.id, slug: info.slug || info.id, name: info.name || info.slug || info.id, documents: null, added: addedIds.has(info.id) });
    }
  }
  vaults.sort((a, b) => a.name.localeCompare(b.name));
  return { switchboardUrl: origin, vaults, ...(hint ? { hint } : {}) };
}

