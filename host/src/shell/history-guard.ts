/**
 * The shell routes by hash (router.ts) — a desktop webview reloads at the app's
 * root. `@powerhousedao/reactor-browser` writes Connect's path URLs on its own:
 * `setSelectedDrive` pushes `/d/<slug>` (or `/` when deselecting) and
 * `setSelectedNode` pushes `/d/<slug>/<node>`, each dropping the fragment —
 * and a dropped fragment reads as "home" to the router. It offers no opt-out,
 * so the host keeps its route authoritative: a path-only write is rewritten to
 * the root with the current hash (query string kept); a write that carries its
 * own hash passes through; a write that changes nothing is skipped, so the
 * history gains no duplicate entries. Install once, before anything renders.
 *
 * Back and forward: reactor-browser reads the selected drive and document from the path, which the
 * host keeps at "/", so on every history step its handlers would deselect the drive (the open app
 * falls back to its loader) and close the editor. The host takes those steps over. Every entry the
 * page writes records the document open in an editor at that moment (`phNode` in its state, where
 * Connect keeps it in the path), and a popstate listener that runs first stops reactor-browser's
 * handlers and reopens that entry's editor. Workflow Studio, which keeps its selection in the hash
 * and walks it with back and forward (6.2.3-dev.47), follows on hashchange.
 */
type PhWindow = { ph?: { selectedDriveId?: string; selectedNodeId?: string } };
const openEditor = (): string | null => (window as unknown as PhWindow).ph?.selectedNodeId ?? null;

/** Reopens (or, with undefined, closes) an editor; set once the reactor is installed (reactor.ts). */
let restoreEditor: ((nodeId: string | undefined) => void) | undefined;
export function setHistoryEditorRestorer(restore: (nodeId: string | undefined) => void): void {
  restoreEditor = restore;
}

export function installHistoryGuard(): () => void {
  const originalPush = window.history.pushState.bind(window.history);
  const originalReplace = window.history.replaceState.bind(window.history);
  const guard = (original: typeof window.history.pushState) => (data: unknown, unused: string, url?: string | URL | null) => {
    const state = { ...(data !== null && typeof data === "object" ? data : {}), phNode: openEditor() };
    if (url === undefined || url === null) return original(state, unused);
    const target = new URL(String(url), window.location.href);
    if (!target.hash && window.location.hash) {
      target.pathname = "/";
      target.hash = window.location.hash;
    }
    if (target.href === window.location.href) return;
    return original(state, unused, target.href);
  };
  const onPopState = (event: PopStateEvent) => {
    event.stopImmediatePropagation(); // reactor-browser's handlers would read the selection from the path
    if (!(window as unknown as PhWindow).ph?.selectedDriveId) return; // no app open: nothing to restore
    const state: unknown = event.state;
    const node = state !== null && typeof state === "object" && "phNode" in state && typeof state.phNode === "string" ? state.phNode : undefined;
    if ((openEditor() ?? undefined) !== node) restoreEditor?.(node);
  };
  window.history.pushState = guard(originalPush) as typeof window.history.pushState;
  window.history.replaceState = guard(originalReplace) as typeof window.history.replaceState;
  // Capture, and installed before reactor-browser's own listeners: it runs first.
  window.addEventListener("popstate", onPopState, { capture: true });
  return () => {
    window.history.pushState = originalPush;
    window.history.replaceState = originalReplace;
    window.removeEventListener("popstate", onPopState, { capture: true });
  };
}
