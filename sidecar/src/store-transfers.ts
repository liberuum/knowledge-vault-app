import { randomUUID } from "node:crypto";
import type { BackupInfo } from "./backups.js";
import { archiveTarget, importArchive, inspectArchive, packBackup, type ArchiveDeps, type ArchiveSummary } from "./store-archive.js";

/**
 * One export or import at a time, run in the background and read by the host
 * (GET /store/transfer). An export writes a backup into a file the user chose;
 * an import unpacks a file into backups/ and, when asked, has it restored —
 * the ordinary restore, which needs the engine to restart.
 */
export type TransferJob = {
  id: string;
  kind: "export" | "import";
  state: "running" | "done" | "failed";
  /** Bytes handled so far, of `total` (the store's size). */
  done: number;
  total: number;
  /** export: the file written; import: the file read. */
  file: string;
  /** export: the backup written out; import: the backup made from the file, once unpacked. */
  backup: string | null;
  /** import: restore the backup once unpacked (the engine restarts). */
  restore: boolean;
  /** export: the file's size once written. */
  bytes: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export class TransferBusyError extends Error {}

export type StoreTransfersDeps = ArchiveDeps & {
  dataDir: string;
  appVersion: string;
  stackVersion: string;
  /** An import the user wants restored is handed to the ordinary restore (main.ts: maintenance.schedule). */
  restoreImported: (backup: BackupInfo) => void;
  /** For tests: how long a finished import-and-restore waits before the restart, so the host sees it finish. */
  restoreDelayMs?: number;
  pack?: typeof packBackup;
  unpack?: typeof importArchive;
};

export function createStoreTransfers(deps: StoreTransfersDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const pack = deps.pack ?? packBackup;
  const unpack = deps.unpack ?? importArchive;
  let job: TransferJob | null = null;

  function begin(kind: TransferJob["kind"], file: string, backup: string | null, restore: boolean): TransferJob {
    if (job?.state === "running") throw new TransferBusyError(job.kind === "export" ? "An export is still being written; wait for it to finish." : "An import is still being unpacked; wait for it to finish.");
    job = { id: randomUUID(), kind, state: "running", done: 0, total: 0, file, backup, restore, bytes: null, error: null, startedAt: now(), finishedAt: null };
    return job;
  }
  function progress(j: TransferJob) {
    return (done: number, total: number) => {
      j.done = done;
      j.total = total;
    };
  }
  function fail(j: TransferJob, error: unknown) {
    j.state = "failed";
    j.error = error instanceof Error ? error.message : String(error);
    j.finishedAt = now();
    console.warn(`[transfer] ${j.kind} failed: ${j.error}`);
  }

  return {
    current: (): TransferJob | null => (job ? { ...job } : null),

    inspect: (file: string): Promise<ArchiveSummary> => inspectArchive(file, deps.stackVersion),

    /** Writes the backup `name` into `dest`; returns at once, the job carries on. */
    exportBackup(name: string, dest: string): TransferJob {
      const target = archiveTarget(dest); // a bad path is refused now, not as a failed job
      const j = begin("export", target, name, false);
      void pack(deps.dataDir, name, target, { appVersion: deps.appVersion, onProgress: progress(j) }).then(
        (r) => {
          j.state = "done";
          j.file = r.path;
          j.bytes = r.bytes;
          j.finishedAt = now();
          console.log(`[transfer] exported ${name} to ${r.path}`);
        },
        (error: unknown) => fail(j, error),
      );
      return { ...j };
    },

    /** An export that could not start (the backup made at the restart, but its file refused): a failed job the host can read. */
    recordFailed(kind: TransferJob["kind"], file: string, error: unknown): void {
      if (job?.state === "running") return;
      fail((job = { id: randomUUID(), kind, state: "running", done: 0, total: 0, file, backup: null, restore: false, bytes: null, error: null, startedAt: now(), finishedAt: null }), error);
    },

    /** Unpacks `file` into backups/; with `restore`, then restores it. Returns at once. */
    importFile(file: string, restore: boolean): TransferJob {
      const j = begin("import", file, null, restore);
      void unpack(deps.dataDir, file, deps.stackVersion, { ...(deps.statfs ? { statfs: deps.statfs } : {}), ...(deps.now ? { now: deps.now } : {}), onProgress: progress(j) }).then(
        (backup) => {
          j.state = "done";
          j.backup = backup.name;
          j.finishedAt = now();
          console.log(`[transfer] imported ${file} as ${backup.name}${restore ? "; restoring it" : ""}`);
          // A moment for the host to read "unpacked" before the engine goes away for the restore.
          if (restore) setTimeout(() => deps.restoreImported(backup), deps.restoreDelayMs ?? 1200);
        },
        (error: unknown) => fail(j, error),
      );
      return { ...j };
    },
  };
}
export type StoreTransfers = ReturnType<typeof createStoreTransfers>;
