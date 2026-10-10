import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Spec §3.3: what the engine owns under the app-data dir. */
export const DATA_SUBDIRS = ["reactor", "read-model", "attachments", "secrets", "logs", "converter"] as const;

/**
 * Since 6.2.3-dev.45 the Switchboard opens each store as a plain Postgres directory, and a
 * `snapshot.bin` beside one counts as authoritative: on open the store would be replaced by that
 * snapshot. Our stores have been plain directories from the start (the app's own NodeFS shim did the
 * same), so a snapshot next to a `PG_VERSION` can only be a leftover of a diagnostic run, older than
 * the store. It is renamed, not deleted. A snapshot with no `PG_VERSION` is a real snapshot store,
 * left for the Switchboard to convert. Returns the new names.
 */
export function setAsideStaleSnapshots(dataDir: string, now: Date = new Date()): string[] {
  const moved: string[] = [];
  for (const sub of ["reactor", "read-model"]) {
    const dir = join(dataDir, sub);
    const snapshot = join(dir, "snapshot.bin");
    if (!existsSync(snapshot) || !existsSync(join(dir, "PG_VERSION"))) continue;
    const aside = join(dir, `snapshot.bin.stale-${now.toISOString().replace(/[:.]/g, "-")}`);
    renameSync(snapshot, aside);
    moved.push(aside);
  }
  return moved;
}

/**
 * Create the app-data layout. `secrets/` is 0700 (mode is applied even when the
 * directory already existed with the default mode). A `node_modules` link left
 * by earlier builds — packages are loaded by directory now — is removed so it
 * can never dangle into an EEXIST at the next launch.
 */
export function prepareDataDir(dataDir: string): void {
  for (const sub of DATA_SUBDIRS) mkdirSync(join(dataDir, sub), { recursive: true });
  if (process.platform !== "win32") chmodSync(join(dataDir, "secrets"), 0o700);
  const legacyLink = join(dataDir, "node_modules");
  let entry: ReturnType<typeof lstatSync> | undefined;
  try {
    entry = lstatSync(legacyLink);
  } catch {
    entry = undefined;
  }
  if (entry?.isSymbolicLink()) unlinkSync(legacyLink);
}
