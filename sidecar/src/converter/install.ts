import { spawn } from "node:child_process";
import { renameWithRetry, RM_RETRY } from "../fs-retry.js";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * Installing the `docling.rs` binding into the app's data dir (Plan 4, Stage B).
 *
 * Two npm tarballs — the JS package and this machine's platform package —
 * downloaded resumably into `downloads/`, verified against the registry's
 * `dist.integrity` (sha512) before anything is extracted, unpacked with `tar`
 * into a staging dir, then swapped into `node_modules/` in one rename. The
 * version is the one the vendored service is tested against.
 */
export const BINDING_VERSION = "1.58.0";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** The registry's integrity strings for the pinned version, recorded 2026-10-07: a registry answer that differs is refused before any download. */
export const PINNED_INTEGRITY: Record<string, string> = {
  "docling.rs@1.58.0": "sha512-6PkJ2g1O44FjPFIzrRANZSVR5gv95OYDg/rjy5Ellmkc1YIuSPJN3AXzEbJg4W0lNURsCkqMizW+G6ogj6qHLw==",
  "docling.rs-linux-x64-gnu@1.58.0": "sha512-4be77AUbYgCn7QiwBGEGnUR2lYRnaJDOLTfr2AN/ttUeBqJPEP8Z0bieexWVjeSpdhXbJRstiWZJY15wqdpQfw==",
  "docling.rs-linux-arm64-gnu@1.58.0": "sha512-G0KvOVbrsm0h2XCgjMUgVQ4JAEmvbswTdN5uM6QdnMjqWxvFZJobLOxpMNf1E4lLEfdvazM1Mk4xflzcCUKuUQ==",
  "docling.rs-win32-x64-msvc@1.58.0": "sha512-rmQxc+hYfaI8HblD53DOATOlPqvllLv7B2fD8pG4C4zrKOTRO98UhUvN5iFy80WU53UR7NERqZyTYLshi5AdBw==",
};

/**
 * Platform packages docling.rs does not publish on npm, built from the same release by this project's
 * `converter-binding` workflow and attached to a GitHub release (a pre-release: never the app's "latest").
 * An entry with no integrity yet has not been published: the platform stays unsupported (platform.ts).
 */
export type SelfBuiltPackage = { url: string; integrity: string };
export const SELF_BUILT: Record<string, SelfBuiltPackage> = {
  "docling.rs-darwin-arm64@1.58.0": {
    url: "https://github.com/liberuum/knowledge-vault-app/releases/download/docling-binding-v1.58.0/docling.rs-darwin-arm64-1.58.0.tgz",
    // Published by the converter-binding workflow (run 37761132274, Xcode 15.4), recorded 2026-10-08.
    integrity: "sha512-iMpG0OcQ/jX1kIfmWmolx8ZtQQWCOYymuhSHMcEVdbiLfaJQ8wpqDRTQrv68TWF9ksOeyQT7iamMZM0lONg2oA==",
  },
};

/** Whether this project publishes the platform package for `triple` at `version`. */
export function selfBuiltReady(triple: string, version: string = BINDING_VERSION): boolean {
  return Boolean(SELF_BUILT[`docling.rs-${triple}@${version}`]?.integrity);
}

export type InstallPhase = "metadata" | "downloading" | "verifying" | "extracting" | "done";
export type InstallProgress = { phase: InstallPhase; file?: string; bytes?: number; total?: number | null };
export type BindingManifest = { version: string; platform: string; installedAt: string; bytes: number };

export class IntegrityError extends Error {}

export type InstallBindingOptions = {
  /** The converter's dir in app-data (`<dataDir>/converter`). */
  dir: string;
  triple: string;
  version?: string;
  registry?: string;
  fetchImpl?: typeof fetch;
  /** Runs `tar` with the given arguments; injectable for tests. */
  tar?: (args: string[]) => Promise<void>;
  onProgress?: (progress: InstallProgress) => void;
  maxAttempts?: number;
  /** Abort a download that sends nothing for this long; the attempt is retried (resumed). */
  idleMs?: number;
  metadataTimeoutMs?: number;
  /** Integrity strings the registry must agree with; `{}` disables the check (tests). */
  pins?: Record<string, string>;
  /** Packages fetched from this project's releases instead of the registry (tests override). */
  selfBuilt?: Record<string, SelfBuiltPackage>;
};

export async function installBinding(opts: InstallBindingOptions): Promise<BindingManifest> {
  const version = opts.version ?? BINDING_VERSION;
  const registry = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const progress = opts.onProgress ?? (() => {});
  const tar = opts.tar ?? runTar;
  const downloads = join(opts.dir, "downloads");
  const staging = join(opts.dir, "node_modules.staging");
  mkdirSync(downloads, { recursive: true });
  rmSync(staging, { recursive: true, force: true, ...RM_RETRY });
  let bytes = 0;
  for (const name of ["docling.rs", `docling.rs-${opts.triple}`]) {
    progress({ phase: "metadata", file: name });
    const selfBuilt = (opts.selfBuilt ?? SELF_BUILT)[`${name}@${version}`];
    if (selfBuilt && !selfBuilt.integrity) throw new IntegrityError(`${name}@${version} is not published yet — refusing to download an unpinned package.`);
    const meta = selfBuilt
      ? { tarball: selfBuilt.url, integrity: selfBuilt.integrity }
      : await registryMetadata(fetchImpl, registry, name, version, opts.metadataTimeoutMs ?? 30_000, opts.pins ?? PINNED_INTEGRITY);
    const tgz = join(downloads, `${name}-${version}.tgz`);
    await download(fetchImpl, meta.tarball, tgz, (b, total) => progress({ phase: "downloading", file: name, bytes: b, total }), opts.maxAttempts ?? 5, opts.idleMs ?? 30_000);
    progress({ phase: "verifying", file: name });
    await verifyIntegrity(tgz, meta.integrity);
    progress({ phase: "extracting", file: name });
    const dest = join(staging, name);
    mkdirSync(dest, { recursive: true });
    await tar(["-xzf", tgz, "-C", dest, "--strip-components=1"]);
    bytes += statSync(tgz).size;
    rmSync(tgz, { force: true });
  }
  const final = join(opts.dir, "node_modules");
  rmSync(final, { recursive: true, force: true, ...RM_RETRY });
  renameWithRetry(staging, final);
  const manifest: BindingManifest = { version, platform: opts.triple, installedAt: new Date().toISOString(), bytes };
  writeFileSync(join(opts.dir, "binding.json"), JSON.stringify(manifest, null, 2) + "\n");
  progress({ phase: "done" });
  return manifest;
}

/** The installed binding, if `binding.json` and the package are both there. */
export function installedBinding(dir: string): BindingManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "binding.json"), "utf8")) as BindingManifest;
    return existsSync(join(dir, "node_modules", "docling.rs", "package.json")) ? manifest : null;
  } catch {
    return null;
  }
}

export function removeBinding(dir: string): void {
  rmSync(join(dir, "node_modules"), { recursive: true, force: true, ...RM_RETRY });
  rmSync(join(dir, "node_modules.staging"), { recursive: true, force: true, ...RM_RETRY });
  rmSync(join(dir, "binding.json"), { force: true });
}

async function registryMetadata(
  fetchImpl: typeof fetch,
  registry: string,
  name: string,
  version: string,
  timeoutMs: number,
  pins: Record<string, string>,
): Promise<{ tarball: string; integrity: string }> {
  const res = await fetchImpl(`${registry}/${name}/${version}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`The registry answered HTTP ${res.status} for ${name}@${version}.`);
  const body = (await res.json()) as { dist?: { tarball?: string; integrity?: string } };
  if (!body.dist?.tarball || !body.dist.integrity) throw new Error(`The registry's metadata for ${name}@${version} has no tarball or integrity.`);
  const pin = pins[`${name}@${version}`];
  if (Object.keys(pins).length > 0 && !pin) throw new IntegrityError(`No pinned integrity for ${name}@${version} — refusing to download an unpinned package.`);
  if (pin && pin !== body.dist.integrity) throw new IntegrityError(`The registry's integrity for ${name}@${version} differs from the one this app pins — refusing to download it.`);
  return { tarball: body.dist.tarball, integrity: body.dist.integrity };
}

/**
 * Download to `<dest>.part`, resuming with a Range request after a dropped
 * connection or a short read, and rename to `dest` when the byte count says
 * the file is complete. Integrity is checked afterwards, not here.
 */
async function download(
  fetchImpl: typeof fetch,
  url: string,
  dest: string,
  onProgress: (bytes: number, total: number | null) => void,
  maxAttempts: number,
  idleMs: number,
): Promise<void> {
  if (existsSync(dest)) return; // a complete download from an earlier attempt; verified next
  const part = `${dest}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // A socket that goes quiet is abandoned and the attempt resumed, so an install can fail but never hang.
    const controller = new AbortController();
    let idle = setTimeout(() => controller.abort(new Error(`no data for ${idleMs} ms`)), idleMs);
    const touch = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new Error(`no data for ${idleMs} ms`)), idleMs);
    };
    try {
      const res = await fetchImpl(url, { ...(have > 0 ? { headers: { range: `bytes=${have}-` } } : {}), signal: controller.signal });
      touch();
      if (res.status === 416) break; // nothing left to fetch
      if (res.status === 200 && have > 0) {
        // The server ignored the range: start over.
        rmSync(part, { force: true });
        have = 0;
      }
      if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status} for ${url}`);
      const length = Number(res.headers.get("content-length") ?? 0) || null;
      const total = res.status === 206 ? totalFromContentRange(res.headers.get("content-range")) : length;
      if (!res.body) throw new Error(`empty body for ${url}`);
      const out = createWriteStream(part, { flags: have > 0 ? "a" : "w" });
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          have += chunk.length;
          touch();
          onProgress(have, total);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), counter, out);
      if (total === null || have >= total) {
        renameWithRetry(part, dest);
        return;
      }
      lastError = new Error(`short read: ${have} of ${total} bytes`);
    } catch (error) {
      lastError = controller.signal.aborted ? (controller.signal.reason as Error) : error;
      have = existsSync(part) ? statSync(part).size : 0;
    } finally {
      clearTimeout(idle);
    }
  }
  if (existsSync(part) && !existsSync(dest)) {
    // Nothing left to fetch: the file is complete.
    if (lastError === null) {
      renameWithRetry(part, dest);
      return;
    }
  }
  throw new Error(`The download of ${url} did not complete: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function totalFromContentRange(header: string | null): number | null {
  const m = /\/(\d+)\s*$/.exec(header ?? "");
  return m ? Number(m[1]) : null;
}

/** `sha512-<base64>` as the registry states it, against the bytes on disk; a mismatch removes the file. */
export async function verifyIntegrity(file: string, integrity: string): Promise<void> {
  const [algorithm, expected] = integrity.split("-", 2);
  if (!algorithm || !expected || !/^sha(256|384|512)$/.test(algorithm)) throw new IntegrityError(`unsupported integrity: ${integrity}`);
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  const actual = hash.digest("base64");
  if (actual !== expected) {
    rmSync(file, { force: true });
    throw new IntegrityError(`${file} does not match the registry's ${algorithm} — removed; try again.`);
  }
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (error) => reject(new Error(`tar could not run: ${error.message}`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}: ${stderr.trim()}`))));
  });
}
