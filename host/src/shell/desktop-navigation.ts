import {
  browserNavigation,
  extractNodeIdFromSlug,
  findDriveBySlug,
  getPHStore,
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
export const desktopNavigation: PHNavigation = {
  /** What is open, as Connect's path for it: reactor-browser compares targets with it. */
  location: () => {
    const store = getPHStore();
    const drive = store?.drives?.find((d) => d.header.id === store.selectedDriveId);
    return { pathname: drive ? targetPathname({ driveSlug: makeDriveSlug(drive) }) : targetPathname(undefined), search: window.location.search };
  },
  open(target, options) {
    // Connect's settings page: the shell has its own Settings screen, reached from its app bar.
    if (target && isSettingsTarget(target)) return;
    const store = getPHStore();
    const driveId = target ? findDriveBySlug(store?.drives, target.driveSlug)?.header.id : undefined;
    const nodeId = target?.nodeSlug ? extractNodeIdFromSlug(target.nodeSlug) : undefined;
    const changed = driveId !== store?.selectedDriveId || nodeId !== store?.selectedNodeId;
    // As a router does: another target keeps only the app-wide params; `search` applies on top.
    if (changed || options?.search) {
      browserNavigation.setSearch(
        (prev) => ({ ...(changed ? Object.fromEntries(Object.entries(prev).filter(([key]) => isGlobalSearchParam(key))) : prev), ...(options?.search ?? {}) }),
        options?.replace ? { replace: true } : undefined,
      );
    }
    // Drive first: a new drive resets the node.
    setSelectedDriveId(driveId);
    setSelectedNodeId(nodeId);
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
