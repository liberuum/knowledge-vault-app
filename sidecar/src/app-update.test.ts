import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUpdateDownloader, downloadsDir, isOwnRelease, pickInstaller, RELEASE_DOWNLOADS, type DownloadState } from "./app-update.js";

// The files of a real release (v0.2.1), as GitHub lists them.
const asset = (name: string) => ({ name, url: `${RELEASE_DOWNLOADS}v0.2.2/${name}`, size: 6 });
const ASSETS = [
  "Knowledge-Vault_0.2.2_Linux_x86-64.AppImage",
  "Knowledge-Vault_0.2.2_Linux_x86-64.deb",
  "Knowledge-Vault_0.2.2_macOS_Apple-silicon.app.tar.gz",
  "Knowledge-Vault_0.2.2_macOS_Apple-silicon.dmg",
  "Knowledge-Vault_0.2.2_Windows_x64-setup.exe",
].map(asset);

describe("the installer for this machine", () => {
  it("is the disk image on macOS, the setup on Windows, and on Linux what the app was installed from", () => {
    const pick = (p: NodeJS.Platform, appImage = false) => pickInstaller(ASSETS, p, appImage);
    expect(pick("darwin")).toMatchObject({ kind: "dmg", asset: { name: "Knowledge-Vault_0.2.2_macOS_Apple-silicon.dmg" } });
    expect(pick("win32")).toMatchObject({ kind: "setup", asset: { name: "Knowledge-Vault_0.2.2_Windows_x64-setup.exe" } });
    expect(pick("linux", true)).toMatchObject({ kind: "appimage", asset: { name: "Knowledge-Vault_0.2.2_Linux_x86-64.AppImage" } });
    expect(pick("linux")).toMatchObject({ kind: "deb", asset: { name: "Knowledge-Vault_0.2.2_Linux_x86-64.deb" } });
    expect(pick("freebsd")).toBeNull();
    expect(pickInstaller(ASSETS.slice(0, 2), "darwin", false)).toBeNull();
  });
  it("comes only from this app's releases, under the release's own tag", () => {
    expect(isOwnRelease(ASSETS[0]!, "0.2.2")).toBe(true);
    expect(isOwnRelease(ASSETS[0]!, "0.2.3")).toBe(false);
    expect(isOwnRelease({ name: "x.dmg", url: "https://evil.example/x.dmg" }, "0.2.2")).toBe(false);
    expect(isOwnRelease({ name: "../x.dmg", url: `${RELEASE_DOWNLOADS}v0.2.2/../x.dmg` }, "0.2.2")).toBe(false);
  });
});

describe("the Downloads folder", () => {
  it("follows the desktop's own setting on Linux, and is ~/Downloads elsewhere", () => {
    const read = (text: string) => () => text;
    expect(downloadsDir("linux", {}, "/home/a", read('XDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n'))).toBe("/home/a/Téléchargements");
    expect(downloadsDir("linux", {}, "/home/a", read('XDG_DOWNLOAD_DIR="$HOME/"'))).toBe("/home/a/Downloads"); // turned off
    expect(downloadsDir("linux", {}, "/home/a", () => { throw new Error("none"); })).toBe("/home/a/Downloads");
    expect(downloadsDir("darwin", {}, "/Users/a")).toBe("/Users/a/Downloads");
    expect(downloadsDir("win32", { USERPROFILE: "C:\\Users\\a" }, "/x")).toMatch(/Users.a.Downloads$/);
  });
});

describe("downloading the installer", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const setup = (respond: () => Response | Promise<Response>) => {
    const dir = mkdtempSync(join(tmpdir(), "kv-update-"));
    dirs.push(dir);
    let calls = 0;
    const d = createUpdateDownloader({ fetchImpl: (async () => { calls++; return respond(); }) as typeof fetch, dir: () => dir, platform: "darwin", appImage: false, stallMs: 200 });
    const settled = async () => {
      for (let i = 0; i < 100 && d.status().state === "downloading"; i++) await new Promise((r) => setTimeout(r, 10));
      return d.status();
    };
    return { d, dir, settled, calls: () => calls };
  };

  it("writes the file into Downloads, and does not fetch a finished one again", async () => {
    const s = setup(() => new Response("binary", { headers: { "content-length": "6" } }));
    expect(s.d.start({ version: "v0.2.2", assets: ASSETS })).toMatchObject({ state: "downloading", name: "Knowledge-Vault_0.2.2_macOS_Apple-silicon.dmg" });
    const done = (await s.settled()) as Extract<DownloadState, { state: "done" }>;
    expect(done).toMatchObject({ state: "done", version: "0.2.2", kind: "dmg" });
    expect(readFileSync(done.path, "utf8")).toBe("binary");
    expect(readdirSync(s.dir)).toEqual(["Knowledge-Vault_0.2.2_macOS_Apple-silicon.dmg"]);
    expect(s.d.start({ version: "0.2.2", assets: ASSETS }).state).toBe("done");
    expect(s.calls()).toBe(1);
  });

  it("fails cleanly, leaving no part file: an HTTP error, a short file, a foreign file, no installer", async () => {
    const http = setup(() => new Response("no", { status: 404 }));
    http.d.start({ version: "0.2.2", assets: ASSETS });
    expect(await http.settled()).toMatchObject({ state: "failed", error: "GitHub answered HTTP 404" });
    const short = setup(() => new Response("bin", { headers: { "content-length": "6" } }));
    short.d.start({ version: "0.2.2", assets: ASSETS });
    expect(await short.settled()).toMatchObject({ state: "failed", error: "the download ended early (3 of 6 bytes)" });
    expect(readdirSync(short.dir)).toEqual([]);
    const foreign = setup(() => new Response("x"));
    expect(foreign.d.start({ version: "0.2.2", assets: [{ name: "Knowledge-Vault_0.2.2_macOS_Apple-silicon.dmg", url: "https://evil.example/a.dmg" }] })).toMatchObject({ state: "failed", error: "That file is not one of this app's releases." });
    expect(foreign.calls()).toBe(0);
    expect(foreign.d.start({ version: "0.2.2", assets: ASSETS.slice(0, 1) })).toMatchObject({ state: "failed", error: "This release has no installer for this computer." });
    // a failed one can be tried again
    const again = setup(() => new Response("binary"));
    again.d.start({ version: "0.2.2", assets: [] });
    again.d.start({ version: "0.2.2", assets: ASSETS });
    expect((await again.settled()).state).toBe("done");
  });

  it("gives up on a download that stops receiving data", async () => {
    const s = setup(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("bi")); } }), { headers: { "content-length": "6" } }));
    s.d.start({ version: "0.2.2", assets: ASSETS });
    expect(await s.settled()).toMatchObject({ state: "failed", error: "the download stopped receiving data" });
    expect(readdirSync(s.dir)).toEqual([]);
  });
});
