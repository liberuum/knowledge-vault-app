import {
  browserNavigation,
  extractNodeIdFromSlug,
  findDriveBySlug,
  getPHStore,
  invalidateDriveNodes,
  isGlobalSearchParam,
  isSettingsTarget,
  makeDriveSlug,
  setSelectedDriveId,
  setSelectedNodeId,
  targetPathname,
  type PHNavigation,
} from "@powerhousedao/reactor-browser";

/**
 * How reactor-browser opens a drive or a document here (Powerhouse 6.2.3-dev.70+).
 *
 * `setSelectedDrive` and `setSelectedNode` open their target through the store's navigation. With none, reactor-browser
 * uses the browser: it writes Connect's path (`/d/<drive>/<node>`) and then reads the selection back from the path. The
 * shell routes by hash and the history guard keeps the path at "/", so that read found no drive and deselected it at
 * once: a vault and Workflow Studio stayed on their loader, and opening a document would have closed the vault.
 *
 * Like Connect's router, this navigation writes the selection into the store itself and leaves the URL to the shell.
 * Query params (the revision history, routed modals) stay in the URL, kept by the history guard, as before.
 */
/** Re-reads a drive into the page's cache; set by the active reactor (reactor.ts). */
let rereadDrive: ((driveId: string) => Promise<unknown>) | undefined;
export function setDriveRereader(reread: ((driveId: string) => Promise<unknown>) | undefined): void {
  rereadDrive = reread;
}

/**
 * A document opened before the page's drive knows of it — anything written straight to the engine
 * that nothing announced — would select a node no hook can find, and nothing opens. The drive is
 * read again; the selection stays, so the document opens once the drive has it.
 */
export function rereadIfMissing(
  drive: { header: { id: string }; state?: unknown } | undefined,
  nodeId: string | undefined,
  reread: ((driveId: string) => Promise<unknown>) | undefined,
): boolean {
  if (!drive || !nodeId || !reread) return false;
  const nodes = (drive.state as { global?: { nodes?: { id: string }[] } } | undefined)?.global?.nodes ?? [];
  if (nodes.some((n) => n.id === nodeId)) return false;
  void reread(drive.header.id).catch(() => undefined);
  return true;
}

export const desktopNavigation: PHNavigation = {
  /**
   * What is open, as Connect's path for it, the open document included: reactor-browser skips opening a target
   * whose path is this one. Without the document, "close it" (the vault itself) read as already open, so a
   * document stayed on screen while the vault switched to Who has access, the processing queue or any other view.
   */
  location: () => {
    const store = getPHStore();
    const drive = store?.drives?.find((d) => d.header.id === store.selectedDriveId);
    if (!drive) return { pathname: targetPathname(undefined), search: window.location.search };
    const nodeSlug = store?.selectedNodeId ?? undefined;
    return { pathname: targetPathname({ driveSlug: makeDriveSlug(drive), ...(nodeSlug ? { nodeSlug } : {}) }), search: window.location.search };
  },
  open(target, options) {
    // Connect's settings page: the shell has its own Settings screen, reached from its app bar.
    if (target && isSettingsTarget(target)) return;
    const store = getPHStore();
    const driveId = target ? findDriveBySlug(store?.drives, target.driveSlug)?.header.id : undefined;
    const nodeId = target?.nodeSlug ? extractNodeIdFromSlug(target.nodeSlug) : undefined;
    const changed = driveId !== store?.selectedDriveId || nodeId !== store?.selectedNodeId;
    // Drive first: a new drive resets the node. Both before the URL: the history guard records the document the store
    // holds on the entry the URL write makes, and Back reopens that one (written first, each entry named the previous).
    setSelectedDriveId(driveId);
    setSelectedNodeId(nodeId);
    rereadIfMissing(store?.drives?.find((d) => d.header.id === driveId), nodeId, rereadDrive);
    // The node hooks (useSelectedNode) read their own index of the drive's nodes, which does not fetch a node
    // it lacks once it holds "all" of them: a document created since it loaded would be selected and never found.
    if (driveId && nodeId && !store?.driveNodes?.get(driveId)?.byId?.has(nodeId)) invalidateDriveNodes(driveId);
    // As a router does: another target keeps only the app-wide params; `search` applies on top.
    if (changed || options?.search) {
      browserNavigation.setSearch(
        (prev) => ({ ...(changed ? Object.fromEntries(Object.entries(prev).filter(([key]) => isGlobalSearchParam(key))) : prev), ...(options?.search ?? {}) }),
        options?.replace ? { replace: true } : undefined,
      );
    }
  },
  hrefFor: (target) => browserNavigation.hrefFor?.(target) ?? targetPathname(target),
  setSearch: (update, options) => browserNavigation.setSearch(update, options),
  useSearchParams: () => browserNavigation.useSearchParams(),
  useSetSearchParams: () => browserNavigation.useSetSearchParams(),
  // Back and forward belong to the shell (history guard): there is no entry a document was opened from to return to.
  closeOpened: () => false,
};

/** Once per page, before anything selects a drive. */
export function installDesktopNavigation(): void {
  const store = getPHStore();
  if (store) store.navigation = desktopNavigation;
  else (window as unknown as { ph?: Record<string, unknown> }).ph = { navigation: desktopNavigation };
}
