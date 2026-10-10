import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./process-identity.js";
import { readConfig, writeConfig } from "./settings.js";
import { compareVersions } from "./version.js";

/** Spec §9: what a restore puts back — the store and its records. */
export const STORE_PARTS = ["reactor", "read-model", "attachments", "pipelines.json"] as const;
/** What a backup holds: the store, its records and the settings of the day (for reference) — never the secrets. */
export const BACKUP_PARTS = [...STORE_PARTS, "config.json"] as const;
/** A backup without these is not a store. */
const REQUIRED_PARTS = ["reactor", "read-model"] as const;
/** Retention: the newest backups and pre-restore copies kept; older ones go after each new one. */
export const KEEP_BACKUPS = 10;
export const KEEP_PRE_RESTORE = 3;
/** `2026-10-07T12-00-00Z-<stack>` — what createBackup names a backup; anything else in backups/ is not ours to clean. */
const DATED = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-/;

/** What made a backup: the user, the restore that set the store aside, the upgrade guard, or an imported file. */
export type BackupKind = "backup" | "pre-restore" | "before-upgrade" | "imported";
/** The vaults a backup holds, as the engine listed them when it was made (absent from older backups). */
export type BackupVault = { name: string; noteCount: number };
export type BackupInfo = {
  name: string;
  path: string;
  bytes: number;
  stackVersion: string;
  createdAt: string;
  kind: BackupKind;
  vaults?: BackupVault[];
  /** An imported backup: the file it came from. */
  importedFrom?: string;
};
/** What createBackup records beside the store, for the list and for an exported file's preview. */
export type BackupLabel = { kind?: Exclude<BackupKind, "pre-restore" | "imported">; vaults?: BackupVault[] };

export class NotEnoughSpaceError extends Error {
  constructor(
    public readonly needed: number,
    public readonly available: number,
  ) {
    super(`Not enough free space: ${human(needed)} needed, ${human(available)} available.`);
  }
}
export class BackupTooNewError extends Error {}
export class BackupNotFoundError extends Error {}
export class BackupIncompleteError extends Error {}

export type BackupDeps = {
  now?: () => string;
  statfs?: (dir: string) => { available: number };
  /** For tests: the copy, and a hook after each part is swapped (to simulate a crash mid-restore). */
  copy?: (from: string, to: string) => void;
  afterMove?: (part: string) => void;
};

export const backupsDir = (dataDir: string) => join(dataDir, "backups");
/** `2026-10-07T12:00:00.000Z` → `2026-10-07T12-00-00Z`: sortable, and legal in a file name everywhere. */
export const stamp = (iso: string): string => iso.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");

export function human(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.ceil(bytes / 1e6)} MB`;
}
export function sizeOf(path: string): number {
  if (!existsSync(path)) return 0;
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((n, entry) => n + sizeOf(join(path, entry)), 0);
}
function freeSpace(dir: string): { available: number } {
  const s = statfsSync(dir);
  return { available: Number(s.bavail) * Number(s.bsize) };
}

/** Copies the store into `backups/<stamp>-<stack>/` with a manifest; refuses — before copying anything — without twice the store's size free. */
export function createBackup(dataDir: string, stackVersion: string, deps: BackupDeps = {}, label: BackupLabel = {}): BackupInfo {
  const now = deps.now ?? (() => new Date().toISOString());
  const storeBytes = BACKUP_PARTS.reduce((n, part) => n + sizeOf(join(dataDir, part)), 0);
  const { available } = (deps.statfs ?? freeSpace)(dataDir);
  if (available < storeBytes * 2) throw new NotEnoughSpaceError(storeBytes * 2, available);
  const createdAt = now();
  const name = `${stamp(createdAt)}-${stackVersion}`;
  const path = join(backupsDir(dataDir), name);
  mkdirSync(path, { recursive: true });
  try {
    for (const part of BACKUP_PARTS) {
      const from = join(dataDir, part);
      if (existsSync(from)) cpSync(from, join(path, part), { recursive: true });
    }
  } catch (error) {
    rmSync(path, { recursive: true, force: true }); // never leave half a backup behind
    throw error;
  }
  const bytes = sizeOf(path);
  const kind = label.kind ?? "backup";
  const vaults = label.vaults?.length ? label.vaults : undefined;
  writeFileSync(join(path, "manifest.json"), JSON.stringify({ name, stackVersion, createdAt, bytes, kind, ...(vaults ? { vaults } : {}), complete: true }, null, 2) + "\n");
  return { name, path, bytes, stackVersion, createdAt, kind, ...(vaults ? { vaults } : {}) };
}

/**
 * A dated backup directory without a manifest is an interrupted copy: removed, and named.
 * Pre-restore copies and anything else in backups/ are never touched.
 */
export function cleanPartialBackups(dataDir: string): string[] {
  if (!existsSync(backupsDir(dataDir))) return [];
  const removed: string[] = [];
  for (const name of readdirSync(backupsDir(dataDir))) {
    if (!DATED.test(name)) continue;
    if (!existsSync(join(backupsDir(dataDir), name, "manifest.json"))) {
      rmSync(join(backupsDir(dataDir), name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

const KINDS: readonly BackupKind[] = ["backup", "pre-restore", "before-upgrade", "imported"];
function vaultsOf(v: unknown): BackupVault[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((x: unknown) => {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    return typeof o.name === "string" ? [{ name: o.name, noteCount: typeof o.noteCount === "number" ? o.noteCount : 0 }] : [];
  });
  return out.length ? out : undefined;
}

/** Newest first, by the time each was made (from its manifest — never the file's time, Review Focus 5). */
export function listBackups(dataDir: string): BackupInfo[] {
  if (!existsSync(backupsDir(dataDir))) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(backupsDir(dataDir))) {
    try {
      const m = JSON.parse(readFileSync(join(backupsDir(dataDir), name, "manifest.json"), "utf8")) as Record<string, unknown>;
      if (m.complete !== true) continue;
      // Backups from before the kind was recorded: a pre-restore copy is known by its name.
      const kind = KINDS.includes(m.kind as BackupKind) ? (m.kind as BackupKind) : name.startsWith("pre-restore-") ? "pre-restore" : "backup";
      const vaults = vaultsOf(m.vaults);
      out.push({
        name,
        path: join(backupsDir(dataDir), name),
        bytes: typeof m.bytes === "number" ? m.bytes : 0,
        stackVersion: typeof m.stackVersion === "string" ? m.stackVersion : "",
        createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
        kind,
        ...(vaults ? { vaults } : {}),
        ...(typeof m.importedFrom === "string" ? { importedFrom: m.importedFrom } : {}),
      });
    } catch {
      // not a backup
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.name < b.name ? 1 : -1));
}

/**
 * Keeps the newest KEEP_BACKUPS backups and KEEP_PRE_RESTORE pre-restore copies; returns what it removed.
 * An imported backup is the user's own file brought in: it stays until they delete it.
 */
export function pruneBackups(dataDir: string): string[] {
  const all = listBackups(dataDir);
  const pre = all.filter((b) => b.kind === "pre-restore");
  const dated = all.filter((b) => b.kind !== "pre-restore" && b.kind !== "imported" && DATED.test(b.name));
  const drop = [...dated.slice(KEEP_BACKUPS), ...pre.slice(KEEP_PRE_RESTORE)];
  for (const b of drop) rmSync(b.path, { recursive: true, force: true });
  return drop.map((b) => b.name);
}

/** Removes one backup the list shows; anything else in backups/ is not ours to remove. */
export function deleteBackup(dataDir: string, name: string): void {
  const backup = listBackups(dataDir).find((b) => b.name === name);
  if (!backup) throw new BackupNotFoundError(`No backup named ${name}.`);
  rmSync(backup.path, { recursive: true, force: true });
}

const journalPath = (dataDir: string) => join(dataDir, "restore-journal.json");
const stagingPath = (dataDir: string) => join(dataDir, "restore-staging");
type Journal = { name: string; preRestore: string; parts: string[]; startedAt: string };

/**
 * Swaps a backup in without ever losing the current store (review C1):
 * 1. copy the backup into restore-staging/ — a failure here touches nothing;
 * 2. write restore-journal.json;
 * 3. per part, move the live part into backups/pre-restore-<stamp>/ and the staged one in (renames);
 * 4. mark the pre-restore copy complete, record the restored store's stack, drop the journal.
 * A crash between 2 and 4 is rolled back by recoverInterruptedRestore at the next start.
 * Settings, the sign-in and the remote-vault list stay as they are today (review I3).
 */
export function restoreBackup(dataDir: string, name: string, appStack: string, deps: BackupDeps = {}, current: { vaults?: BackupVault[] } = {}): { preRestore: string } {
  const backup = listBackups(dataDir).find((b) => b.name === name);
  if (!backup) throw new BackupNotFoundError(`No backup named ${name}.`);
  if (compareVersions(backup.stackVersion, appStack) > 0) {
    throw new BackupTooNewError(`This backup was made by a newer Knowledge Vault (stack ${backup.stackVersion}) than this one (stack ${appStack}). Download the newer version to restore it.`);
  }
  for (const part of REQUIRED_PARTS) {
    if (!existsSync(join(backup.path, part))) throw new BackupIncompleteError(`The backup ${name} has no ${part}; it cannot be restored.`);
  }
  const needed = STORE_PARTS.reduce((n, part) => n + sizeOf(join(backup.path, part)), 0);
  const { available } = (deps.statfs ?? freeSpace)(dataDir);
  if (available < needed) throw new NotEnoughSpaceError(needed, available);
  const now = deps.now ?? (() => new Date().toISOString());
  const copy = deps.copy ?? ((from: string, to: string) => cpSync(from, to, { recursive: true }));

  // 1. stage
  const staging = stagingPath(dataDir);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const part of STORE_PARTS) {
      const from = join(backup.path, part);
      if (existsSync(from)) copy(from, join(staging, part));
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  // 2. journal
  const preRestore = `pre-restore-${stamp(now())}`;
  const keep = join(backupsDir(dataDir), preRestore);
  mkdirSync(keep, { recursive: true });
  const previousStack = readConfig(dataDir).stackVersion;
  const journal: Journal = { name, preRestore, parts: [...STORE_PARTS], startedAt: now() };
  writeFileAtomic(journalPath(dataDir), JSON.stringify(journal) + "\n");
  // 3. swap, part by part — each move is a rename, so every part is either live or in the copy
  for (const part of STORE_PARTS) {
    const current = join(dataDir, part);
    if (existsSync(current)) renameSync(current, join(keep, part));
    const staged = join(staging, part);
    if (existsSync(staged)) renameSync(staged, current);
    deps.afterMove?.(part);
  }
  // 4. done
  const keptStack = typeof previousStack === "string" && previousStack ? previousStack : appStack;
  writeFileSync(join(keep, "manifest.json"), JSON.stringify({ name: preRestore, stackVersion: keptStack, createdAt: now(), bytes: sizeOf(keep), kind: "pre-restore", ...(current.vaults?.length ? { vaults: current.vaults } : {}), complete: true }, null, 2) + "\n");
  writeConfig(dataDir, { ...readConfig(dataDir), stackVersion: backup.stackVersion });
  rmSync(journalPath(dataDir), { force: true });
  rmSync(staging, { recursive: true, force: true });
  return { preRestore };
}

/** At start, before anything opens the store: an interrupted restore is rolled back — the user's store comes back. */
export function recoverInterruptedRestore(dataDir: string): { name: string; preRestore: string } | undefined {
  if (!existsSync(journalPath(dataDir))) return undefined;
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(journalPath(dataDir), "utf8")) as Journal;
  } catch {
    rmSync(journalPath(dataDir), { force: true });
    return undefined;
  }
  const keep = join(backupsDir(dataDir), journal.preRestore);
  for (const part of journal.parts) {
    const kept = join(keep, part);
    if (!existsSync(kept)) continue; // never moved: the live part is still the user's
    const current = join(dataDir, part);
    rmSync(current, { recursive: true, force: true });
    renameSync(kept, current);
  }
  rmSync(keep, { recursive: true, force: true });
  rmSync(stagingPath(dataDir), { recursive: true, force: true });
  rmSync(journalPath(dataDir), { force: true });
  return { name: journal.name, preRestore: journal.preRestore };
}

export function deleteAllData(dataDir: string, opts: { includeBackups: boolean }): void {
  if (!existsSync(dataDir)) return;
  for (const entry of readdirSync(dataDir)) {
    if (entry === "backups" && !opts.includeBackups) continue;
    rmSync(join(dataDir, entry), { recursive: true, force: true });
  }
}
