/**
 * How many notes each vault had when this page last showed it — so the next visit can say what is new
 * ("+12 new notes"). Kept on this computer beside the recents; a vault never shown before has no count, and
 * nothing is called new for it.
 */
export type Seen = Record<string, number>;
export const SEEN_KEY = "kv.seen-notes";

type Store = Pick<Storage, "getItem" | "setItem">;

export function readSeen(storage: Store | undefined): Seen {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(SEEN_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Seen = {};
    for (const [id, n] of Object.entries(parsed as Record<string, unknown>)) if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[id] = n;
    return out;
  } catch {
    return {};
  }
}

/** The notes added since the last visit, per vault; only vaults seen before, and only growth. */
export function newSince(seen: Seen, counts: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, now] of Object.entries(counts)) {
    const before = seen[id];
    if (before !== undefined && now > before) out[id] = now - before;
  }
  return out;
}

/** Records what this visit showed; vaults not listed now keep their count (a remote one may be out of reach today). */
export function rememberSeen(storage: Store | undefined, counts: Readonly<Record<string, number>>): void {
  try {
    storage?.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(storage), ...counts }));
  } catch {
    // a full or blocked store only loses the "new" hint
  }
}
