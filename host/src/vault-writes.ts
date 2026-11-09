/**
 * The vault announces every write it makes (`MutateDocument`, detail `{ identifier }`
 * — the document, or the drive after a create, move or delete). Connect's document
 * cache re-reads on it; reactor-browser's, which the desktop uses, does not, and the
 * drive the vault opens documents from then never learns of a new one: a source
 * created from Paste text was listed (the list reads the graph) but did not open.
 * This re-reads each announced document into the cache, which publishes it.
 */
export function followVaultWrites(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  reread: (id: string) => Promise<unknown>,
): () => void {
  const onWrite = (event: Event) => {
    const id = (event as CustomEvent<{ identifier?: unknown } | undefined>).detail?.identifier;
    if (typeof id === "string" && id) void reread(id).catch(() => undefined);
  };
  target.addEventListener("MutateDocument", onWrite);
  return () => target.removeEventListener("MutateDocument", onWrite);
}
