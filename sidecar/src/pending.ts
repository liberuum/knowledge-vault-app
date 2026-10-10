import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createBackup, deleteAllData, human, pruneBackups, restoreBackup, type BackupDeps, type BackupVault } from "./backups.js";
import { writeFileAtomic } from "./process-identity.js";

/**
 * Spec §9: backups, restores and the delete-all happen with the store closed.
 * The control API records the wish, the engine restarts, and the action runs
 * at the next start — before anything opens PGlite. The result is kept for the
 * host, which shows it after the restart.
 */
export type PendingAction =
  /** `vaults`: what the engine listed when asked (the backup records it); `exportTo`: a file to write the backup into once made; `reason`: the upgrade guard's. */
  | { action: "backup"; vaults?: BackupVault[]; exportTo?: string; reason?: "upgrade" }
  /** `vaults`: the vaults set aside, recorded on the pre-restore copy. */
  | { action: "restore"; name: string; vaults?: BackupVault[] }
  | { action: "delete-all"; includeBackups: boolean };
/** `backup`: the backup a backup or a restore made (a restore's is its pre-restore copy). */
export type ActionResult = { action: PendingAction["action"]; ok: boolean; detail: string; at: string; backup?: string };

const pendingPath = (dataDir: string) => join(dataDir, "pending-action.json");
const lastPath = (dataDir: string) => join(dataDir, "last-action.json");

export function writePending(dataDir: string, action: PendingAction): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(pendingPath(dataDir), JSON.stringify(action) + "\n");
}

/** Reads and removes the pending action, so an action that crashes the start is never retried in a loop. */
export function takePending(dataDir: string): PendingAction | undefined {
  if (!existsSync(pendingPath(dataDir))) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pendingPath(dataDir), "utf8")) as PendingAction;
    return isPendingAction(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(pendingPath(dataDir), { force: true });
  }
}

export function isPendingAction(v: unknown): v is PendingAction {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (a.action === "backup") return a.exportTo === undefined || typeof a.exportTo === "string";
  if (a.action === "restore") return typeof a.name === "string" && a.name.length > 0;
  if (a.action === "delete-all") return typeof a.includeBackups === "boolean";
  return false;
}

/** For results that did not come from a pending action (an interrupted restore rolled back at start). */
export function writeLastAction(dataDir: string, result: ActionResult): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(lastPath(dataDir), JSON.stringify(result, null, 2) + "\n");
}

export function readLastAction(dataDir: string): ActionResult | undefined {
  try {
    return JSON.parse(readFileSync(lastPath(dataDir), "utf8")) as ActionResult;
  } catch {
    return undefined;
  }
}

/** Runs the action; never throws — a refused backup is a result the host shows, and the engine still starts. */
/** `stackVersion` is this app's (a restore refuses a newer backup); a backup is labelled with `deps.storeStack`, the stack that wrote the store, when known. */
export function runPendingAction(dataDir: string, action: PendingAction, stackVersion: string, deps: BackupDeps & { storeStack?: string } = {}): ActionResult {
  const now = deps.now ?? (() => new Date().toISOString());
  let result: ActionResult;
  try {
    if (action.action === "backup") {
      const b = createBackup(dataDir, deps.storeStack ?? stackVersion, deps, { kind: action.reason === "upgrade" ? "before-upgrade" : "backup", ...(action.vaults ? { vaults: action.vaults } : {}) });
      const pruned = pruneBackups(dataDir);
      result = { action: "backup", ok: true, detail: `Backed up ${human(b.bytes)} as ${b.name}.${pruned.length ? ` Removed ${pruned.length} older backup${pruned.length === 1 ? "" : "s"}.` : ""}`, at: now(), backup: b.name };
    } else if (action.action === "restore") {
      const r = restoreBackup(dataDir, action.name, stackVersion, deps, { ...(action.vaults ? { vaults: action.vaults } : {}) });
      pruneBackups(dataDir);
      result = { action: "restore", ok: true, detail: `Restored ${action.name}; what was there is kept as ${r.preRestore}.`, at: now(), backup: r.preRestore };
    } else {
      deleteAllData(dataDir, { includeBackups: action.includeBackups });
      result = { action: "delete-all", ok: true, detail: action.includeBackups ? "Deleted all local data, backups included." : "Deleted all local data; backups kept.", at: now() };
    }
  } catch (error) {
    result = { action: action.action, ok: false, detail: error instanceof Error ? error.message : String(error), at: now() };
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(lastPath(dataDir), JSON.stringify(result, null, 2) + "\n");
  return result;
}
