import type { SidecarInfo } from "./sidecar.js";
import type { UpdateAsset } from "./update-check.js";
import { control } from "./vaults.js";

/** The engine's download of a new release's installer (sidecar/src/app-update.ts). */
export type InstallerKind = "dmg" | "setup" | "appimage" | "deb";
export type UpdateDownload =
  | { state: "idle" }
  | { state: "downloading"; version: string; name: string; received: number; total: number | null }
  | { state: "done"; version: string; name: string; path: string; kind: InstallerKind }
  | { state: "failed"; version: string; error: string };

export const updateDownloadStatus = (info: SidecarInfo, fetchImpl: typeof fetch = fetch) =>
  control<UpdateDownload>(info, "/update/download", { method: "GET" }, fetchImpl);

export const startUpdateDownload = (info: SidecarInfo, release: { version: string; assets: UpdateAsset[] }, fetchImpl: typeof fetch = fetch) =>
  control<UpdateDownload>(info, "/update/download", { method: "POST", body: JSON.stringify(release) }, fetchImpl);
