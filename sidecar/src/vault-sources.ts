/**
 * Adding a source to a local vault through the vault package's own REST API (`POST sources`): it files the source
 * in /sources, ingests it and queues it for processing in one call, with the vault's checks. Needs the vault's
 * folders and processing queue, which the engine creates with every vault (vault-structure.ts).
 */
import { readNodes } from "./vault-structure.js";

const SOURCES_PATH = "/api/@powerhousedao/knowledge-note/sources";

export type NewSource = { title: string; content: string; sourceType: "DOCUMENTATION" | "MANUAL_ENTRY" };
/** `existing`: the source was already in the vault (the guide is added once). */
export type AddedSource = { id: string; title: string; queued: boolean; existing?: boolean };

/** A title for pasted text: its first line, without Markdown marks, cut at a word near 80 characters. */
export function titleFromText(text: string): string {
  const first = text.split("\n").map((l) => l.replace(/^[\s#>*\-–•]+/, "").replace(/\s+/g, " ").trim()).find((l) => l.length > 0);
  if (!first) return "Pasted text";
  if (first.length <= 80) return first;
  const cut = first.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

export async function addVaultSource(origin: string, driveId: string, source: NewSource, fetchImpl: typeof fetch = fetch): Promise<AddedSource> {
  const res = await fetchImpl(`${origin}${SOURCES_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Pasted text may hold a literal backslash-n (a Windows path, code, LaTeX): it is the user's text, kept as is.
    body: JSON.stringify({ drive: driveId, title: source.title, content: source.content, sourceType: source.sourceType, queue: true, allowLiteralEscapes: true }),
  });
  const text = await res.text();
  let body: { id?: string; status?: string; error?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // not JSON: the status line says enough
  }
  if (!res.ok || !body.id) {
    const error = typeof body.error === "string" ? body.error : `the vault answered HTTP ${res.status}`;
    throw new Error(`Could not add the source: ${error}`);
  }
  return { id: body.id, title: source.title, queued: body.status === "EXTRACTING" };
}

/** A source already in the vault with this title (the REST API names a source document after its title), or null. */
export async function findSourceByTitle(origin: string, driveId: string, title: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const nodes = await readNodes(origin, driveId, fetchImpl);
  return nodes.find((n) => n.kind === "file" && n.documentType === "bai/source" && n.name === title)?.id ?? null;
}
