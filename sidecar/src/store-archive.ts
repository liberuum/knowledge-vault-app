import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { create, extract, Parser, type ReadEntry } from "tar";
import { BACKUP_PARTS, BackupNotFoundError, BackupTooNewError, backupsDir, listBackups, NotEnoughSpaceError, sizeOf, stamp, type BackupInfo, type BackupVault } from "./backups.js";
import { writeFileAtomic } from "./process-identity.js";
import { compareVersions } from "./version.js";

/**
 * A backup as one file the user keeps anywhere: `<name>.kvbackup`, a gzipped tar of the backup's
 * folder — the two PGlite databases (reactor, read-model), the attachments, the pipeline records
 * and the settings of the day. Never the keys: a backup does not hold them (backups.ts).
 *
 *   <name>/manifest.json   first, so a file can be previewed without unpacking it
 *   <name>/reactor/…       <name>/read-model/…   <name>/attachments   <name>/pipelines.json   <name>/config.json
 *
 * Importing unpacks it into backups/ as a backup of its own; restoring it is the ordinary restore,
 * which sets what is there aside first.
 */
export const ARCHIVE_EXTENSION = ".kvbackup";
export const ARCHIVE_FORMAT = "knowledge-vault-backup";
export const ARCHIVE_FORMAT_VERSION = 1;
/** What may be inside a backup's folder; anything else in a file is not unpacked. */
const ARCHIVE_PARTS = new Set<string>(["manifest.json", ...BACKUP_PARTS]);
/** The names a store's files carry (PGlite's, ours); a path with anything else is refused. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** A backup's own name in the file — what createBackup and importArchive name one. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const MAX_MANIFEST_BYTES = 1_000_000;

export class NotABackupFileError extends Error {}
export class ArchivePathError extends Error {}

export type ArchiveSummary = {
  /** The file, as given. */
  file: string;
  fileBytes: number;
  /** The backup's own name and what it recorded. */
  name: string;
  createdAt: string;
  stackVersion: string;
  appVersion: string | null;
  /** The store's size once unpacked. */
  bytes: number;
  vaults: BackupVault[] | null;
  /** Made by a newer Knowledge Vault than this one: it cannot be restored here. */
  tooNew: boolean;
};

export type Progress = (done: number, total: number) => void;
export type ArchiveDeps = { statfs?: (dir: string) => { available: number }; now?: () => string };

function freeSpace(dir: string): { available: number } {
  const s = statfsSync(dir);
  return { available: Number(s.bavail) * Number(s.bsize) };
}

/** `/x/My backup` → `/x/My backup.kvbackup`; an absolute path in a folder that exists, or an error that says which. */
export function archiveTarget(path: string): string {
  if (!path || !isAbsolute(path)) throw new ArchivePathError("Choose where to save the file.");
  const target = path.toLowerCase().endsWith(ARCHIVE_EXTENSION) ? path : `${path}${ARCHIVE_EXTENSION}`;
  if (!existsSync(dirname(target))) throw new ArchivePathError(`The folder ${dirname(target)} does not exist.`);
  return target;
}

/** A file name the Save dialog proposes: `Knowledge Vault backup 2026-10-10.kvbackup`. */
export function suggestedFileName(createdAt: string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(createdAt)?.[0] ?? stamp(createdAt);
  return `Knowledge Vault backup ${day}${ARCHIVE_EXTENSION}`;
}

/**
 * Writes the backup `name` into one file at `dest` (".kvbackup" added when missing). The file is
 * written beside its place as `.partial` and renamed in when whole, so a cut-short export never
 * leaves a file that looks complete.
 */
export async function packBackup(dataDir: string, name: string, dest: string, opts: { appVersion: string; onProgress?: Progress }): Promise<{ path: string; bytes: number }> {
  const backup = listBackups(dataDir).find((b) => b.name === name);
  if (!backup) throw new BackupNotFoundError(`No backup named ${name}.`);
  const target = archiveTarget(dest);
  // The manifest carries the format, so the file says what it is before anything is unpacked.
  const manifestPath = join(backup.path, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  writeFileAtomic(manifestPath, JSON.stringify({ ...manifest, format: ARCHIVE_FORMAT, formatVersion: ARCHIVE_FORMAT_VERSION, appVersion: typeof manifest.appVersion === "string" ? manifest.appVersion : opts.appVersion }, null, 2) + "\n");

  const parts = BACKUP_PARTS.filter((p) => existsSync(join(backup.path, p)));
  const total = Math.max(1, parts.reduce((n, p) => n + sizeOf(join(backup.path, p)), 0));
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  let done = 0;
  const tarStream = create({ cwd: backupsDir(dataDir), portable: true }, [`${name}/manifest.json`, ...parts.map((p) => `${name}/${p}`)]);
  async function* counted(): AsyncGenerator<Buffer> {
    for await (const chunk of tarStream as AsyncIterable<Buffer>) {
      done += chunk.length;
      opts.onProgress?.(Math.min(done, total), total);
      yield chunk;
    }
  }
  try {
    // Level 3: a store is mostly empty pages, which pack small at any level; speed matters more.
    await pipeline(counted(), createGzip({ level: 3 }), createWriteStream(partial));
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  opts.onProgress?.(total, total);
  return { path: target, bytes: statSync(target).size };
}

/** Reads the manifest at the head of a `.kvbackup` without unpacking the rest. */
export async function inspectArchive(file: string, appStack: string): Promise<ArchiveSummary> {
  if (!file || !isAbsolute(file)) throw new ArchivePathError("Choose a backup file.");
  let fileBytes: number;
  try {
    const s = statSync(file);
    if (!s.isFile()) throw new Error("not a file");
    fileBytes = s.size;
  } catch {
    throw new ArchivePathError(`There is no file at ${file}.`);
  }
  const notOurs = () => new NotABackupFileError(`${basename(file)} is not a Knowledge Vault backup.`);
  const text = await new Promise<string>((resolve, reject) => {
    const src = createReadStream(file);
    let settled = false;
    const finish = (error: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      src.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const parser = new Parser({
      onReadEntry: (entry: ReadEntry) => {
        if (settled) return entry.resume();
        if (entry.type !== "File" || !/^[^/]+\/manifest\.json$/.test(entry.path) || entry.size > MAX_MANIFEST_BYTES) return finish(notOurs());
        const chunks: Buffer[] = [];
        entry.on("data", (c: Buffer) => chunks.push(c));
        entry.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
      },
    });
    parser.on("error", () => finish(notOurs()));
    parser.on("end", () => finish(notOurs()));
    src.on("error", (e) => finish(e));
    src.pipe(parser as unknown as NodeJS.WritableStream);
  });
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw notOurs();
  }
  if (m.format !== ARCHIVE_FORMAT || m.complete !== true || typeof m.name !== "string" || !SAFE_NAME.test(m.name) || typeof m.stackVersion !== "string") throw notOurs();
  if (typeof m.formatVersion === "number" && m.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw new BackupTooNewError("This file was made by a newer Knowledge Vault. Update the app to import it.");
  }
  const vaults = Array.isArray(m.vaults)
    ? m.vaults.flatMap((v: unknown) => {
        const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
        return typeof o.name === "string" ? [{ name: o.name, noteCount: typeof o.noteCount === "number" ? o.noteCount : 0 }] : [];
      })
    : null;
  return {
    file,
    fileBytes,
    name: m.name,
    createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
    stackVersion: m.stackVersion,
    appVersion: typeof m.appVersion === "string" ? m.appVersion : null,
    bytes: typeof m.bytes === "number" ? m.bytes : 0,
    vaults: vaults && vaults.length ? vaults : null,
    tooNew: compareVersions(m.stackVersion, appStack) > 0,
  };
}

const stagingPath = (dataDir: string) => join(dataDir, "import-staging");
/** An import cut short (a crash, a quit) leaves its half-unpacked copy here; removed at the next start. */
export function cleanImportStaging(dataDir: string): boolean {
  if (!existsSync(stagingPath(dataDir))) return false;
  rmSync(stagingPath(dataDir), { recursive: true, force: true });
  return true;
}

/**
 * Unpacks a `.kvbackup` into backups/ as `imported-<when>-<stack>`. Only the store's own files are
 * unpacked — plain files and folders under the backup's name, with names a store uses; links,
 * devices and paths that climb out are refused (node-tar refuses `..` and absolute paths besides).
 * Needs room for the store twice: once unpacked, once more for the restore that may follow.
 */
export async function importArchive(dataDir: string, file: string, appStack: string, opts: ArchiveDeps & { onProgress?: Progress } = {}): Promise<BackupInfo> {
  const summary = await inspectArchive(file, appStack);
  if (summary.tooNew) {
    throw new BackupTooNewError(`This file was made by a newer Knowledge Vault (stack ${summary.stackVersion}) than this one (stack ${appStack}). Update the app to import it.`);
  }
  mkdirSync(backupsDir(dataDir), { recursive: true });
  const needed = Math.max(summary.bytes, summary.fileBytes) * 2;
  const { available } = (opts.statfs ?? freeSpace)(dataDir);
  if (available < needed) throw new NotEnoughSpaceError(needed, available);

  const now = opts.now ?? (() => new Date().toISOString());
  let name = `imported-${stamp(now())}-${summary.stackVersion}`;
  for (let n = 2; existsSync(join(backupsDir(dataDir), name)); n++) name = `imported-${stamp(now())}-${summary.stackVersion}-${n}`;
  const staging = stagingPath(dataDir);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const refused: string[] = [];
  const total = Math.max(1, summary.bytes);
  let done = 0;
  try {
    await extract({
      file,
      cwd: staging,
      strict: true,
      preservePaths: false,
      filter: (path, entry) => {
        const e = entry as ReadEntry;
        const segments = path.replace(/\/$/, "").split("/");
        const ok =
          (e.type === "File" || e.type === "Directory") &&
          segments[0] === summary.name &&
          (segments.length === 1 || ARCHIVE_PARTS.has(segments[1]!)) &&
          segments.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..");
        if (!ok) refused.push(path);
        return ok;
      },
      onReadEntry: (entry: ReadEntry) => {
        done += entry.size;
        opts.onProgress?.(Math.min(done, total), total);
      },
    });
    const unpacked = join(staging, summary.name);
    for (const part of ["manifest.json", "reactor", "read-model"]) {
      if (!existsSync(join(unpacked, part))) throw new NotABackupFileError(`${basename(file)} has no ${part}; it is not a whole backup.`);
    }
    if (refused.length) console.warn(`[import] left out ${refused.length} entr${refused.length === 1 ? "y" : "ies"} that are not part of a store: ${refused.slice(0, 5).join(", ")}`);
    const manifest = JSON.parse(readFileSync(join(unpacked, "manifest.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(unpacked, "manifest.json"),
      JSON.stringify({ ...manifest, name, kind: "imported", importedFrom: basename(file), importedAt: now(), bytes: sizeOf(unpacked), complete: true }, null, 2) + "\n",
    );
    renameSync(unpacked, join(backupsDir(dataDir), name));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  opts.onProgress?.(total, total);
  const made = listBackups(dataDir).find((b) => b.name === name);
  if (!made) throw new NotABackupFileError(`${basename(file)} could not be read as a backup.`);
  return made;
}
