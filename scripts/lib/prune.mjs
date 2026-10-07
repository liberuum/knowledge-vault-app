import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Plan 6: trim a production node_modules for one target. Only these things go:
 *  - other platforms' native builds — a package whose name carries an OS *and* a CPU
 *    (`@img/sharp-darwin-arm64`, `lightningcss-linux-x64-musl`) that is not this target's;
 *  - source maps and type declarations;
 *  - named packages, files and build folders the engine never loads (DROP_PACKAGES, TRIMS, bundlerOnlyBuilds),
 *    and the packages nothing depends on once those are gone (orphans).
 * Never a directory by its name: `viem/_esm/actions/test` is code (the probe broke the engine that way).
 */
const TARGETS = {
  "x86_64-unknown-linux-gnu": { os: "linux", cpu: "x64", libc: "gnu" },
  "aarch64-unknown-linux-gnu": { os: "linux", cpu: "arm64", libc: "gnu" },
  "aarch64-apple-darwin": { os: "darwin", cpu: "arm64", libc: null },
  "x86_64-apple-darwin": { os: "darwin", cpu: "x64", libc: null },
  "x86_64-pc-windows-msvc": { os: "win32", cpu: "x64", libc: null },
};
const OS = new Set(["linux", "linuxmusl", "darwin", "win32", "windows", "android", "freebsd", "openbsd", "netbsd", "sunos", "aix", "wasm32", "openharmony", "wasi"]);
const CPU = new Set(["x64", "arm64", "arm", "ia32", "s390x", "ppc64", "riscv64", "loong64", "universal", "x86_64", "aarch64", "mips64el"]);
const CPU_ALIAS = { x86_64: "x64", aarch64: "arm64" };
const LIBC = new Set(["gnu", "musl", "msvc", "gnueabihf", "musleabihf"]);
const DROP_FILE = /\.(map|d\.ts|d\.mts|d\.cts)$/;
/**
 * The OpenTelemetry SDK, exporters and auto-instrumentation: switchboard starts them only from its CLI entry or
 * when an OTLP endpoint is configured, which the app never does. A load trace of the packaged engine (start,
 * seeding a vault, semantic search) touched none of them. What it does load stays: api, api-logs, core,
 * instrumentation, resources, sdk-trace(-base), semantic-conventions and the four resource detectors
 * @apollo/gateway requires at import.
 */
const OTEL_UNUSED = [
  "configuration", "context-async-hooks", "otlp-exporter-base", "otlp-grpc-exporter-base", "otlp-transformer",
  "exporter-logs-otlp-grpc", "exporter-logs-otlp-http", "exporter-logs-otlp-proto",
  "exporter-metrics-otlp-grpc", "exporter-metrics-otlp-http", "exporter-metrics-otlp-proto",
  "exporter-trace-otlp-grpc", "exporter-trace-otlp-http", "exporter-trace-otlp-proto",
  "exporter-prometheus", "exporter-zipkin",
  "instrumentation-express", "instrumentation-graphql", "instrumentation-http", "instrumentation-pg", "instrumentation-undici",
  "propagator-b3", "propagator-jaeger", "sdk-logs", "sdk-metrics", "sdk-node", "sdk-trace-node", "sql-common",
].map((n) => `@opentelemetry/${n}`);
/**
 * Whole packages the engine never imports (top level only — a nested copy is someone's real dependency).
 *  - typescript: only an optional peer of viem, ox, abitype and cosmiconfig; cosmiconfig loads it lazily for a
 *    .ts config file, on codegen paths reached only in dev mode.
 *  - onnxruntime-node: knowledge-note's embedder bundles its binding with a path relative to the bundle, so the
 *    native load always fails and it runs on onnxruntime-web (the log says "Model loaded (wasm onnxruntime)").
 *  - the dev toolchain: switchboard imports vite (and with it rolldown, esbuild, lightningcss) and vetra (and with
 *    it codegen, ts-morph, oxfmt) only when `dev` is set; the sidecar starts it with dev: false.
 */
export const DROP_PACKAGES = [
  "typescript",
  "onnxruntime-node",
  "vite", "rolldown", "esbuild", "lightningcss", "@originjs/vite-plugin-commonjs",
  "@powerhousedao/vetra", "@powerhousedao/codegen", "ts-morph", "oxfmt",
  ...OTEL_UNUSED,
];
/** Their per-platform builds and helpers, by name: `@rolldown/binding-darwin-arm64`, `esbuild-darwin-arm64`, … */
const DROP_PACKAGE_NAMED = /^(@rolldown\/|@esbuild\/|esbuild-|lightningcss-|@oxfmt\/|@ts-morph\/|@types\/)/;

/**
 * Packages the orphan sweep keeps although nothing declares them: imported without being a declared dependency
 * (string-width, by @powerhousedao/workflow and markdown-table).
 */
export const UNDECLARED_IMPORTS = ["string-width"];

/** Top-level package names in a node_modules folder (`@scope/name` for scoped ones). */
function topLevel(nodeModules) {
  const out = [];
  for (const e of readdirSync(nodeModules)) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) for (const x of readdirSync(join(nodeModules, e))) out.push(`${e}/${x}`);
    else out.push(e);
  }
  return out;
}

/** What a package declares (dependencies, optional, peers), including what its own nested node_modules declare. */
function declaredBy(dir) {
  const out = new Set();
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) for (const k of Object.keys(pkg[field] ?? {})) out.add(k);
  } catch {
    // no manifest: declares nothing
  }
  const nested = join(dir, "node_modules");
  if (existsSync(nested)) for (const name of topLevel(nested)) for (const k of declaredBy(join(nested, name))) out.add(k);
  return out;
}

/**
 * Top-level packages nothing needs once the drops above are gone: not a dependency of the app's own package.json,
 * not declared by any package still installed — repeated until nothing more falls out (codegen's graphql-tools
 * loaders, the OTLP exporters' gRPC stack, …). Cross-checked against a load trace of the packaged engine.
 */
export function orphans(nodeModules, rootManifest) {
  const root = JSON.parse(readFileSync(rootManifest, "utf8"));
  const roots = new Set([...Object.keys({ ...root.dependencies, ...root.optionalDependencies }), ...UNDECLARED_IMPORTS]);
  const alive = new Set(topLevel(nodeModules));
  const declared = new Map([...alive].map((p) => [p, declaredBy(join(nodeModules, p))]));
  const gone = [];
  for (let changed = true; changed; ) {
    changed = false;
    const needed = new Set(roots);
    for (const p of alive) for (const k of declared.get(p)) needed.add(k);
    for (const p of [...alive]) if (!needed.has(p)) { alive.delete(p); gone.push(p); changed = true; }
  }
  return gone;
}

/**
 * Packages trimmed to the files the engine loads. onnxruntime-web ships every flavour (all, webgl, jsep, jspi, …,
 * ~118 MB); transformers.web.js imports `onnxruntime-web/webgpu` → ort.webgpu.bundle.min.mjs, which loads the
 * asyncify wasm. Applied only when every kept file is there: a renamed file in a new version leaves the package
 * whole rather than breaking search. `alsoDrop` goes only with it — knowledge-note's own copy of the wasm is the
 * embedder's fallback for when onnxruntime-web/dist is missing (and for its CDN mode, unused here).
 */
export const TRIMS = [
  {
    pkg: "onnxruntime-web",
    dir: "dist",
    keep: ["ort.webgpu.bundle.min.mjs", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm", "ort.node.min.mjs", "ort.node.min.js"],
    dropDirs: ["lib", "docs"],
    alsoDrop: ["@powerhousedao/knowledge-note/dist/node/wasm"],
  },
];
/** Build folders only a bundler reads (the `module` / `esnext` conditions); Node resolves build/src. */
const BUNDLER_BUILDS = ["build/esm", "build/esnext"];
const BUNDLER_CONDITIONS = new Set(["module", "esnext", "browser", "webpack"]);

/** Every target Node can resolve from a package.json: `main`, and `exports` minus bundler-only conditions. */
function nodeTargets(pkg) {
  const out = typeof pkg.main === "string" ? [pkg.main] : [];
  const visit = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!BUNDLER_CONDITIONS.has(k)) visit(x);
  };
  visit(pkg.exports);
  return out;
}

/**
 * The bundler-only builds of a package that Node never loads, or [] when any Node target points into them.
 * @opentelemetry ships each package three times (build/src CommonJS, build/esm, build/esnext): ~42 MB.
 */
export function bundlerOnlyBuilds(pkgDir) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const targets = nodeTargets(pkg).map((t) => t.replace(/^\.\//, ""));
  if (targets.length === 0) return [];
  if (targets.some((t) => BUNDLER_BUILDS.some((b) => t.startsWith(b)))) return [];
  return BUNDLER_BUILDS.filter((b) => existsSync(join(pkgDir, b)));
}

/** Is a package named like a platform build, and is it another platform's? */
export function foreignNative(name, target) {
  const tokens = name.split("/").pop().split("-");
  const os = tokens.find((t) => OS.has(t));
  const cpu = tokens.find((t) => CPU.has(t));
  if (!os || !cpu) return false; // not a platform build
  const libc = tokens.find((t) => LIBC.has(t)) ?? (os === "linuxmusl" ? "musl" : null);
  // Windows builds are named win32 or windows; macOS ones darwin.
  const osName = os === "linuxmusl" ? "linux" : os === "windows" ? "win32" : os;
  if (osName !== target.os) return true;
  if (cpu !== "universal" && (CPU_ALIAS[cpu] ?? cpu) !== target.cpu) return true;
  if (target.os === "linux" && libc && !libc.startsWith(target.libc)) return true;
  return false;
}

function size(path) {
  const s = lstatSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((n, e) => n + size(join(path, e)), 0);
}

/** Prunes `nodeModules` in place for `triple`; returns the bytes freed. */
export function prune(nodeModules, triple) {
  const target = TARGETS[triple];
  if (!target) throw new Error(`No prune rules for target ${triple} (known: ${Object.keys(TARGETS).join(", ")}).`);
  let freed = 0;
  const remove = (p) => {
    freed += size(p);
    rmSync(p, { recursive: true, force: true });
  };
  // other platforms' packages, top level and scoped
  for (const entry of readdirSync(nodeModules)) {
    const p = join(nodeModules, entry);
    if (entry.startsWith("@")) {
      for (const pkg of readdirSync(p)) if (foreignNative(`${entry}/${pkg}`, target)) remove(join(p, pkg));
    } else if (foreignNative(entry, target)) {
      remove(p);
    }
  }
  // prebuildify's layout: <pkg>/prebuilds/<os>-<cpu>/… (e.g. @datadog/pprof) — other targets' folders go,
  // and for a glibc target the musl builds in its own folder (a bundler cannot resolve libc.musl for them).
  const prebuilds = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name === "prebuilds") {
        for (const plat of readdirSync(p, { withFileTypes: true })) {
          if (!plat.isDirectory()) continue;
          // Only folders named <os>-<cpu>[+<cpu>…] are platform builds; anything else in prebuilds/ stays.
          const m = /^([a-z0-9]+)-([a-z0-9_]+(?:\+[a-z0-9_]+)*)$/.exec(plat.name);
          if (!m || !OS.has(m[1])) continue;
          const cpus = m[2].split("+").map((c) => CPU_ALIAS[c] ?? c);
          const pp = join(p, plat.name);
          const wrongLibc = m[1] === "linuxmusl" && target.libc === "gnu";
          if (wrongLibc || (m[1] === "linuxmusl" ? "linux" : m[1]) !== target.os || !cpus.includes(target.cpu)) {
            remove(pp);
          } else if (target.libc === "gnu") {
            for (const f of readdirSync(pp)) if (f.includes(".musl.") || f.includes("-musl")) remove(join(pp, f));
          }
        }
      } else if (depth < 6) {
        prebuilds(p, depth + 1);
      }
    }
  };
  prebuilds(nodeModules, 0);
  // packages the engine never imports (top level only: a nested copy is someone's real dependency)
  for (const name of DROP_PACKAGES) if (existsSync(join(nodeModules, name))) remove(join(nodeModules, name));
  for (const entry of readdirSync(nodeModules)) {
    const names = entry.startsWith("@") ? readdirSync(join(nodeModules, entry)).map((x) => `${entry}/${x}`) : [entry];
    for (const name of names) if (DROP_PACKAGE_NAMED.test(name)) remove(join(nodeModules, name));
  }
  // what nothing needs any more — only with the app's manifest beside node_modules (the staged sidecar)
  const manifest = join(nodeModules, "..", "package.json");
  if (existsSync(manifest)) for (const name of orphans(nodeModules, manifest)) remove(join(nodeModules, name));
  // packages trimmed to the files the engine loads
  for (const t of TRIMS) {
    const dir = join(nodeModules, t.pkg, t.dir);
    if (!existsSync(dir) || !t.keep.every((f) => existsSync(join(dir, f)))) continue;
    for (const f of readdirSync(dir)) if (!t.keep.includes(f)) remove(join(dir, f));
    for (const d of t.dropDirs) if (existsSync(join(nodeModules, t.pkg, d))) remove(join(nodeModules, t.pkg, d));
    for (const d of t.alsoDrop) if (existsSync(join(nodeModules, d))) remove(join(nodeModules, d));
  }
  // @opentelemetry's bundler-only builds, in every copy (nested node_modules included)
  const scopes = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name === "@opentelemetry") {
        for (const pkg of readdirSync(p)) for (const b of bundlerOnlyBuilds(join(p, pkg))) remove(join(p, pkg, b));
      }
      const nested = e.name.startsWith("@") ? readdirSync(p).map((x) => join(p, x, "node_modules")) : [join(p, "node_modules")];
      for (const n of nested) if (depth < 8 && existsSync(n)) scopes(n, depth + 1);
    }
  };
  scopes(nodeModules, 0);
  // maps and declarations — files only
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && DROP_FILE.test(e.name)) remove(p);
    }
  };
  walk(nodeModules);
  return freed;
}
