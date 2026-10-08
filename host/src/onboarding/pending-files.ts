/**
 * What the setup guide hands to a vault for when it opens, through the host declaration: files (an older vault
 * package takes them into its own intake; a newer one converts them in the guide itself) and the view to open on.
 */
const pending = new Map<string, File[]>();
const views = new Map<string, string>();

export function handFiles(driveId: string, files: readonly File[]): void {
  if (files.length === 0) return;
  pending.set(driveId, [...(pending.get(driveId) ?? []), ...files]);
}

export function takeIntakeFiles(driveId: string): File[] {
  const files = pending.get(driveId) ?? [];
  pending.delete(driveId);
  return files;
}

/** The view a vault opens on next time, once ("chat", "notes", "graph", "search", "sources"). */
export function setOpenView(driveId: string, view: string): void {
  views.set(driveId, view);
}

export function takeOpenView(driveId: string): string | null {
  const view = views.get(driveId) ?? null;
  views.delete(driveId);
  return view;
}
