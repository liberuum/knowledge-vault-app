import type { SidecarInfo } from "./sidecar.js";
import { invokeIfTauri } from "./shell/tauri.js";
import { control } from "./vaults.js";

/**
 * A backup as one `.kvbackup` file (sidecar/src/store-archive.ts): written out of a backup,
 * previewed, and brought back in as a backup of its own. The engine does the work in the
 * background (GET /store/transfer); the shell picks the files (src-tauri/src/lib.rs).
 */
export type TransferJob = {
  id: string;
  kind: "export" | "import";
  state: "running" | "done" | "failed";
  done: number;
  total: number;
  file: string;
  backup: string | null;
  restore: boolean;
  bytes: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};
export type ArchiveSummary = {
  file: string;
  fileBytes: number;
  name: string;
  createdAt: string;
  stackVersion: string;
  appVersion: string | null;
  bytes: number;
  vaults: { name: string; noteCount: number }[] | null;
  tooNew: boolean;
};

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** A new backup, written into `path` once made — the engine restarts to make it. */
export async function exportToFile(info: SidecarInfo, path: string, fetchImpl: typeof fetch = fetch): Promise<{ restarting: boolean }> {
  return control(info, "/backups", json({ exportTo: path }), fetchImpl);
}
/** An existing backup written into `path`; no restart. */
export async function saveBackupToFile(info: SidecarInfo, name: string, path: string, fetchImpl: typeof fetch = fetch): Promise<TransferJob> {
  return (await control<{ job: TransferJob }>(info, `/backups/${encodeURIComponent(name)}/save`, json({ path }), fetchImpl)).job;
}
export async function deleteBackup(info: SidecarInfo, name: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await control(info, `/backups/${encodeURIComponent(name)}`, { method: "DELETE" }, fetchImpl);
}
export async function inspectBackupFile(info: SidecarInfo, path: string, fetchImpl: typeof fetch = fetch): Promise<ArchiveSummary> {
  return (await control<{ summary: ArchiveSummary }>(info, "/store/inspect", json({ path }), fetchImpl)).summary;
}
/** Unpacks the file into a backup; with `restore`, the engine then restores it (and restarts). */
export async function importBackupFile(info: SidecarInfo, path: string, restore: boolean, fetchImpl: typeof fetch = fetch): Promise<TransferJob> {
  return (await control<{ job: TransferJob }>(info, "/store/import", json({ path, restore }), fetchImpl)).job;
}
export async function fetchTransfer(info: SidecarInfo, fetchImpl: typeof fetch = fetch): Promise<TransferJob | null> {
  return (await control<{ job: TransferJob | null }>(info, "/store/transfer", { method: "GET" }, fetchImpl)).job;
}

/** The desktop's Save dialog, starting in Downloads; null when cancelled or outside the app. */
export async function chooseExportPath(fileName: string): Promise<string | null> {
  return (await invokeIfTauri<string | null>("choose_backup_destination", { fileName })) ?? null;
}
/** The desktop's Open dialog for a `.kvbackup`; null when cancelled or outside the app. */
export async function chooseImportFile(): Promise<string | null> {
  return (await invokeIfTauri<string | null>("choose_backup_file")) ?? null;
}
/** `Knowledge Vault backup 2026-10-10.kvbackup`, in the user's own day. */
export function suggestedFileName(at: Date): string {
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return `Knowledge Vault backup ${day}.kvbackup`;
}
