const REMEMBERED = "kv-store-id";
/** What this window keeps per store: the app's own keys (guide progress, getting-started, recents) and the chat's. */
const STORE_SCOPED = (key: string) => key.startsWith("kv-") || key.startsWith("kv.") || key.startsWith("bai-chat");

/**
 * The window meets the engine's store (its id from GET /status). A different store than the one remembered is a new
 * install (a fresh data folder, "Delete all local data"): what the window kept for the old one goes, so the setup
 * guide, the getting-started ticks and the chat start fresh. The theme and other preferences outside those keys stay.
 * The first meeting only remembers the id: an install from before store ids loses nothing. Returns whether it cleared.
 */
export function adoptStore(storage: Storage | undefined, storeId: string | undefined): boolean {
  if (!storage || !storeId) return false;
  const before = storage.getItem(REMEMBERED);
  if (before === storeId) return false;
  if (before) {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key !== REMEMBERED && STORE_SCOPED(key)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  }
  storage.setItem(REMEMBERED, storeId);
  return before !== null;
}
