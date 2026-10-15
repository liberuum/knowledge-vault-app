/**
 * Docling documents of consecutive page windows of one PDF, joined into the
 * document a single conversion would have produced — so the Markdown, the
 * chunks, the figures and the letter repair downstream see one document.
 *
 * A docling JSON keeps its items in collections (`texts`, `tables`,
 * `pictures`, `groups`, …) and points at them by JSON pointer: `self_ref`
 * "#/texts/12", a parent's or a caption's `{"$ref": "#/texts/12"}`. Joining
 * appends each window's collections after the ones before it, so every pointer
 * into a collection is moved by that collection's length so far; the windows'
 * top-level order is kept by appending their `body` (and `furniture`) children
 * in turn. Pages are keyed by their real number, so they simply join.
 */

const POINTER = /^#\/([a-z_]+)\/(\d+)$/;

/** Every collection a docling document keeps items in: the arrays of objects that carry `self_ref`. */
function collectionsOf(doc) {
  return Object.keys(doc).filter(
    (key) => Array.isArray(doc[key]) && (doc[key].length === 0 || typeof doc[key][0]?.self_ref === "string"),
  );
}

/** A deep copy of `value` with each pointer into a collection moved by that collection's offset. */
function shifted(value, offsets) {
  if (typeof value === "string") {
    const match = POINTER.exec(value);
    if (!match || !(match[1] in offsets)) return value;
    return `#/${match[1]}/${Number(match[2]) + offsets[match[1]]}`;
  }
  if (Array.isArray(value)) return value.map((item) => shifted(item, offsets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = shifted(item, offsets);
    return out;
  }
  return value;
}

/** One docling JSON from the JSONs of a PDF's consecutive page windows, in page order. */
export function mergeDoclingDocuments(jsons) {
  if (jsons.length === 0) throw new Error("no documents to join");
  if (jsons.length === 1) return jsons[0];
  const merged = JSON.parse(jsons[0]);
  for (const json of jsons.slice(1)) {
    const doc = JSON.parse(json);
    const offsets = {};
    for (const key of new Set([...collectionsOf(merged), ...collectionsOf(doc)])) {
      offsets[key] = Array.isArray(merged[key]) ? merged[key].length : 0;
    }
    const next = shifted(doc, offsets);
    for (const key of Object.keys(offsets)) {
      merged[key] = [...(merged[key] ?? []), ...(next[key] ?? [])];
    }
    for (const node of ["body", "furniture"]) {
      if (!next[node]?.children?.length) continue;
      merged[node] ??= { self_ref: `#/${node}`, children: [] };
      merged[node].children = [...(merged[node].children ?? []), ...next[node].children];
    }
    merged.pages = { ...(merged.pages ?? {}), ...(next.pages ?? {}) };
  }
  return JSON.stringify(merged);
}
