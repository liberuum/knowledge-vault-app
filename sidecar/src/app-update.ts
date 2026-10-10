import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * A new release of the app (host/src/update-check.ts finds it on GitHub): the installer for this
 * machine is downloaded into the Downloads folder while the window shows its progress, and the window
 * then says how to install it. Only this app's own release files are fetched — the page names a
 * release and its files, never an address to download from that is not one of them.
 */
export const RELEASE_DOWNLOADS = "https://github.com/liberuum/knowledge-vault-app/releases/download/";

export type ReleaseAsset = { name: string; url: string; size?: number | null };
/** What the file is, so the window can say how to install it. */
export type InstallerKind = "dmg" | "setup" | "appimage" | "deb";

export type DownloadState =
  | { state: "idle" }
  | { state: "downloading"; version: string; name: string; received: number; total: number | null }
  | { state: "done"; version: string; name: string; path: string; kind: InstallerKind }
  | { state: "failed"; version: string; error: string };

/** The installer this machine runs among a release's files: the macOS disk image, the Windows setup, the AppImage or the .deb. */
export function pickInstaller(assets: readonly ReleaseAsset[], platform: NodeJS.Platform, appImage: boolean): { asset: ReleaseAsset; kind: InstallerKind } | null {
  const find = (re: RegExp) => assets.find((a) => re.test(a.name));
  const pick = (re: RegExp, kind: InstallerKind) => {
    const asset = find(re);
    return asset ? { asset, kind } : null;
  };
  if (platform === "darwin") return pick(/_macOS_[^/]*\.dmg$/, "dmg");
  if (platform === "win32") return pick(/_Windows_[^/]*-setup\.exe$/, "setup");
  // Running from an AppImage: the new AppImage replaces it. Installed from the .deb: the new .deb.
  if (platform === "linux") return appImage ? pick(/_Linux_[^/]*\.AppImage$/, "appimage") : pick(/_Linux_[^/]*\.deb$/, "deb");
  return null;
}

/** The Downloads folder, as the desktop names it: on Linux the XDG user directory (a localised name), else ~/Downloads. */
export function downloadsDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): string {
  if (platform === "linux") {
    try {
      const text = read(join(env.XDG_CONFIG_HOME || join(home, ".config"), "user-dirs.dirs"));
      const set = /^XDG_DOWNLOAD_DIR="([^"]*)"/m.exec(text)?.[1];
      // "$HOME/" alone is how the desktop says the folder was turned off.
      const dir = set?.replace(/^\$HOME(?=\/|$)/, home).replace(/\/+$/, "");
      if (dir && dir !== home) return dir;
    } catch {
      // no user-dirs file: the usual folder
    }
  }
  if (platform === "win32") return join(env.USERPROFILE || home, "Downloads");
  return join(home, "Downloads");
}

/** Only this repository's release files, under the release's own tag, with a plain file name. */
export function isOwnRelease(asset: ReleaseAsset, version: string): boolean {
  return /^[\w.-]+$/.test(asset.name) && asset.url === `${RELEASE_DOWNLOADS}v${version}/${asset.name}`;
}

export type UpdateDownloaderDeps = {
  fetchImpl: typeof fetch;
  dir: () => string;
  platform: NodeJS.Platform;
  /** Running from an AppImage (the shell's APPIMAGE variable). */
  appImage: boolean;
  /** A download that receives nothing this long has stalled and fails. */
  stallMs?: number;
};

export function createUpdateDownloader(deps: UpdateDownloaderDeps) {
  let current: DownloadState = { state: "idle" };
  const stallMs = deps.stallMs ?? 60_000;

  async function run(version: string, asset: ReleaseAsset, kind: InstallerKind): Promise<void> {
    const dir = deps.dir();
    const path = join(dir, asset.name);
    const part = `${path}.part`;
    const abort = new AbortController();
    let stall: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(stall);
      stall = setTimeout(() => abort.abort(new Error("the download stopped receiving data")), stallMs);
    };
    try {
      mkdirSync(dir, { recursive: true });
      alive();
      const res = await deps.fetchImpl(asset.url, { redirect: "follow", signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`GitHub answered HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || asset.size || null;
      let received = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          received += chunk.length;
          current = { state: "downloading", version, name: asset.name, received, total };
          alive();
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as WebReadableStream), count, createWriteStream(part), { signal: abort.signal });
      if (total !== null && received !== total) throw new Error(`the download ended early (${received} of ${total} bytes)`);
      rmSync(path, { force: true });
      renameSync(part, path);
      current = { state: "done", version, name: asset.name, path, kind };
    } catch (error) {
      rmSync(part, { force: true });
      const reason = abort.signal.aborted && abort.signal.reason instanceof Error ? abort.signal.reason : error;
      current = { state: "failed", version, error: reason instanceof Error ? reason.message : String(reason) };
    } finally {
      clearTimeout(stall);
    }
  }

  return {
    status: (): DownloadState => current,
    /** Starts the download of `version`'s installer for this machine; one at a time, and a finished one is not fetched again. */
    start(request: { version: string; assets: readonly ReleaseAsset[] }): DownloadState {
      const version = request.version.replace(/^v/, "");
      if (current.state === "downloading") return current;
      if (current.state === "done" && current.version === version) return current;
      const picked = pickInstaller(request.assets, deps.platform, deps.appImage);
      if (!picked) {
        current = { state: "failed", version, error: "This release has no installer for this computer." };
        return current;
      }
      if (!isOwnRelease(picked.asset, version)) {
        current = { state: "failed", version, error: "That file is not one of this app's releases." };
        return current;
      }
      current = { state: "downloading", version, name: picked.asset.name, received: 0, total: picked.asset.size ?? null };
      void run(version, picked.asset, picked.kind);
      return current;
    },
  };
}
export type UpdateDownloader = ReturnType<typeof createUpdateDownloader>;
