import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installBinding, installedBinding, IntegrityError, removeBinding, SELF_BUILT, selfBuiltReady, type InstallProgress } from "./install.js";
import { platformTriple } from "./platform.js";

const require = createRequire(import.meta.url);

/** A real npm-shaped tarball: `package/` prefix, built with the same tar the installer extracts with. */
function tarball(files: Record<string, Buffer | string>): Buffer {
  const dir = mkdtemp("kv-tgz-");
  mkdirSync(join(dir, "package"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "package", name), content);
  const out = join(dir, "pkg.tgz");
  const r = spawnSync("tar", ["-czf", out, "-C", dir, "package"]);
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr.toString()}`);
  return readFileSync(out);
}
const mkdtemp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const sri = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/**
 * A fake registry and tarball host: metadata routes, Range-aware downloads, an
 * optional one-time connection drop at a fraction of the first full request,
 * and an optional wrong integrity.
 */
async function fakeRegistry(opts: { dropOnceAt?: number; wrongIntegrity?: boolean; stall?: boolean } = {}) {
  const js = tarball({ "package.json": JSON.stringify({ name: "docling.rs", version: "1.58.0", main: "index.js" }), "index.js": 'module.exports = { marker: "fake-docling" };\n' });
  const native = tarball({ "package.json": JSON.stringify({ name: "docling.rs-linux-x64-gnu", version: "1.58.0" }), "docling-rs.linux-x64-gnu.node": randomBytes(2 * 1024 * 1024) /* incompressible, like the real .node */ });
  const darwin = tarball({ "package.json": JSON.stringify({ name: "docling.rs-darwin-arm64", version: "1.58.0" }), "docling-rs.darwin-arm64.node": randomBytes(256 * 1024) });
  const files: Record<string, Buffer> = { "docling.rs": js, "docling.rs-linux-x64-gnu": native, "docling.rs-darwin-arm64": darwin };
  const requests: { url: string; range: string | undefined }[] = [];
  let dropped = false;
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    requests.push({ url, range: req.headers.range });
    const meta = /^\/(docling\.rs(?:-[a-z0-9-]+)?)\/1\.58\.0$/.exec(url);
    if (meta) {
      const name = meta[1]!;
      const bytes = files[name]!;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ dist: { tarball: `http://127.0.0.1:${port}/tgz/${name}`, integrity: opts.wrongIntegrity ? sri(Buffer.from("not the file")) : sri(bytes) } }));
      return;
    }
    const tgz = /^\/tgz\/(.+)$/.exec(url);
    if (tgz) {
      const bytes = files[tgz[1]!]!;
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      if (range) {
        const from = Number(range[1]);
        res.writeHead(206, { "content-range": `bytes ${from}-${bytes.length - 1}/${bytes.length}`, "content-length": bytes.length - from });
        if (opts.stall) {
          res.write(bytes.subarray(from, from + 10)); // the resumed request goes quiet too
          return;
        }
        res.end(bytes.subarray(from));
        return;
      }
      res.writeHead(200, { "content-length": bytes.length });
      if (opts.stall) {
        res.write(bytes.subarray(0, 10)); // then silence
        return;
      }
      if (opts.dropOnceAt !== undefined && !dropped && bytes.length > 100_000) {
        dropped = true;
        res.write(bytes.subarray(0, Math.floor(bytes.length * opts.dropOnceAt)));
        setTimeout(() => req.socket.destroy(), 10);
        return;
      }
      res.end(bytes);
      return;
    }
    res.writeHead(404).end();
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return {
    registry: `http://127.0.0.1:${port}`,
    integrity: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`${name}@1.58.0`, sri(bytes)])),
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

describe("installBinding", () => {
  it("downloads both packages, verifies them, extracts them side by side, and writes the manifest", async () => {
    const reg = await fakeRegistry();
    closers.push(reg.close);
    const dir = mkdtemp("kv-conv-");
    const phases: InstallProgress[] = [];
    const manifest = await installBinding({ dir, triple: "linux-x64-gnu", registry: reg.registry, pins: {}, onProgress: (p) => phases.push(p) });
    expect(manifest).toMatchObject({ version: "1.58.0", platform: "linux-x64-gnu" });
    expect(manifest.bytes).toBeGreaterThan(100_000);
    expect(require(join(dir, "node_modules", "docling.rs"))).toEqual({ marker: "fake-docling" });
    expect(existsSync(join(dir, "node_modules", "docling.rs-linux-x64-gnu", "docling-rs.linux-x64-gnu.node"))).toBe(true);
    expect(installedBinding(dir)).toMatchObject({ version: "1.58.0" });
    expect(existsSync(join(dir, "downloads", "docling.rs-1.58.0.tgz"))).toBe(false); // tidied
    expect(phases.map((p) => p.phase)).toEqual(expect.arrayContaining(["metadata", "downloading", "verifying", "extracting", "done"]));
    const downloading = phases.filter((p) => p.phase === "downloading" && p.file === "docling.rs-linux-x64-gnu");
    expect(downloading.at(-1)!.bytes).toBe(downloading.at(-1)!.total);
    removeBinding(dir);
    expect(installedBinding(dir)).toBeNull();
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  it("resumes with a Range request after the connection drops mid-download", async () => {
    const reg = await fakeRegistry({ dropOnceAt: 0.6 });
    closers.push(reg.close);
    const dir = mkdtemp("kv-conv-");
    await installBinding({ dir, triple: "linux-x64-gnu", registry: reg.registry, pins: {} });
    const native = reg.requests.filter((r) => r.url === "/tgz/docling.rs-linux-x64-gnu");
    expect(native.length).toBe(2);
    expect(native[0]!.range).toBeUndefined();
    expect(native[1]!.range).toMatch(/^bytes=\d+-$/);
    expect(Number(/\d+/.exec(native[1]!.range!)![0])).toBeGreaterThan(1_000_000);
    expect(existsSync(join(dir, "node_modules", "docling.rs-linux-x64-gnu", "docling-rs.linux-x64-gnu.node"))).toBe(true);
  });

  it("refuses a tarball that does not match the registry's integrity and leaves nothing behind", async () => {
    const reg = await fakeRegistry({ wrongIntegrity: true });
    closers.push(reg.close);
    const dir = mkdtemp("kv-conv-");
    await expect(installBinding({ dir, triple: "linux-x64-gnu", registry: reg.registry, pins: {} })).rejects.toBeInstanceOf(IntegrityError);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(existsSync(join(dir, "downloads", "docling.rs-1.58.0.tgz"))).toBe(false);
    expect(existsSync(join(dir, "downloads", "docling.rs-1.58.0.tgz.part"))).toBe(false);
    expect(installedBinding(dir)).toBeNull();
  });
});

describe("installBinding — never hangs, never trusts a changed registry", () => {
  it("gives up on a download that goes quiet, after retrying it", async () => {
    const reg = await fakeRegistry({ stall: true });
    closers.push(reg.close);
    const dir = mkdtemp("kv-conv-");
    const started = Date.now();
    await expect(installBinding({ dir, triple: "linux-x64-gnu", registry: reg.registry, pins: {}, idleMs: 150, maxAttempts: 2 })).rejects.toThrow(/did not complete[\s\S]*no data for 150 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(reg.requests.filter((r) => r.url === "/tgz/docling.rs")).toHaveLength(2);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });

  it("refuses a package that has no pin when pins are in force", async () => {
    const reg = await fakeRegistry();
    closers.push(reg.close);
    const dir = mkdtemp("kv-conv-");
    await expect(installBinding({ dir, triple: "linux-x64-gnu", registry: reg.registry, pins: { "docling.rs@1.58.0": reg.integrity["docling.rs@1.58.0"]! } })).rejects.toThrow(/No pinned integrity for docling\.rs-linux-x64-gnu/);
    expect(reg.requests.some((r) => r.url === "/tgz/docling.rs-linux-x64-gnu")).toBe(false);
  });

  it("refuses a registry answer whose integrity differs from the pinned one, before downloading anything", async () => {
    const reg = await fakeRegistry();
    closers.push(reg.close);
    const dir = mkdtemp("kv-conv-");
    await expect(installBinding({ dir, triple: "linux-x64-gnu", registry: reg.registry, pins: { "docling.rs@1.58.0": "sha512-somethingelse" } })).rejects.toBeInstanceOf(IntegrityError);
    expect(reg.requests.some((r) => r.url.startsWith("/tgz/"))).toBe(false);
  });
});

describe("installBinding — the macOS package this project builds", () => {
  it("fetches the platform package from the release URL with its pinned integrity, and the JS package from the registry", async () => {
    const reg = await fakeRegistry();
    closers.push(reg.close);
    const dir = mkdtemp("kv-conv-");
    const selfBuilt = { "docling.rs-darwin-arm64@1.58.0": { url: `${reg.registry}/tgz/docling.rs-darwin-arm64`, integrity: reg.integrity["docling.rs-darwin-arm64@1.58.0"]! } };
    const manifest = await installBinding({ dir, triple: "darwin-arm64", registry: reg.registry, pins: { "docling.rs@1.58.0": reg.integrity["docling.rs@1.58.0"]! }, selfBuilt });
    expect(manifest).toMatchObject({ version: "1.58.0", platform: "darwin-arm64" });
    expect(existsSync(join(dir, "node_modules", "docling.rs-darwin-arm64", "docling-rs.darwin-arm64.node"))).toBe(true);
    expect(reg.requests.some((r) => r.url === "/docling.rs-darwin-arm64/1.58.0")).toBe(false); // never asked the registry for it
  });
  it("refuses a release asset whose bytes differ from the pin", async () => {
    const reg = await fakeRegistry();
    closers.push(reg.close);
    const dir = mkdtemp("kv-conv-");
    const selfBuilt = { "docling.rs-darwin-arm64@1.58.0": { url: `${reg.registry}/tgz/docling.rs-darwin-arm64`, integrity: "sha512-somethingelse" } };
    await expect(installBinding({ dir, triple: "darwin-arm64", registry: reg.registry, pins: {}, selfBuilt })).rejects.toThrow();
    expect(installedBinding(dir)).toBeNull();
  });
  it("refuses an entry that is not published yet (no integrity), before downloading it", async () => {
    const reg = await fakeRegistry();
    closers.push(reg.close);
    const dir = mkdtemp("kv-conv-");
    const selfBuilt = { "docling.rs-darwin-arm64@1.58.0": { url: `${reg.registry}/tgz/docling.rs-darwin-arm64`, integrity: "" } };
    await expect(installBinding({ dir, triple: "darwin-arm64", registry: reg.registry, pins: {}, selfBuilt })).rejects.toBeInstanceOf(IntegrityError);
    expect(reg.requests.some((r) => r.url === "/tgz/docling.rs-darwin-arm64")).toBe(false);
  });
  it("points at a pre-release of this project for the pinned binding version", () => {
    expect(Object.keys(SELF_BUILT)).toEqual(["docling.rs-darwin-arm64@1.58.0"]);
    expect(SELF_BUILT["docling.rs-darwin-arm64@1.58.0"]!.url).toBe("https://github.com/liberuum/knowledge-vault-app/releases/download/docling-binding-v1.58.0/docling.rs-darwin-arm64-1.58.0.tgz");
    expect(selfBuiltReady("darwin-arm64")).toBe(Boolean(SELF_BUILT["docling.rs-darwin-arm64@1.58.0"]!.integrity));
    expect(selfBuiltReady("linux-x64-gnu")).toBe(false);
  });
});

describe("platformTriple", () => {
  it("names the binding for Linux glibc and Windows x64, and says why not elsewhere", () => {
    expect(platformTriple("linux", "x64", false)).toEqual({ triple: "linux-x64-gnu", reason: null });
    expect(platformTriple("linux", "arm64", false)).toEqual({ triple: "linux-arm64-gnu", reason: null });
    expect(platformTriple("win32", "x64", false)).toEqual({ triple: "win32-x64-msvc", reason: null });
    expect(platformTriple("linux", "x64", true).triple).toBeNull();
    expect(platformTriple("freebsd", "x64", false).reason).toMatch(/freebsd\/x64/);
  });
  it("offers Apple silicon only once this project has published its package, and never Intel Macs", () => {
    expect(platformTriple("darwin", "arm64", false, true)).toEqual({ triple: "darwin-arm64", reason: null });
    expect(platformTriple("darwin", "arm64", false, false)).toMatchObject({ triple: null, reason: expect.stringMatching(/macOS/) });
    expect(platformTriple("darwin", "x64", false, true)).toMatchObject({ triple: null, reason: expect.stringMatching(/Apple silicon/) });
  });
});
