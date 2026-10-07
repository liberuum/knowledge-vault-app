import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundlerOnlyBuilds, foreignNative, orphans, prune } from "./prune.mjs";

const FILES = [
  "onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
  "onnxruntime-node/bin/napi-v6/linux/arm64/onnxruntime_binding.node",
  "onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
  "onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node",
  "onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node",
  "@img/sharp-linux-x64/lib/sharp.node",
  "@img/sharp-linuxmusl-x64/lib/sharp.node",
  "@img/sharp-darwin-arm64/lib/sharp.node",
  "@img/sharp-darwin-x64/lib/sharp.node",
  "@img/colour/index.js",
  "@napi-rs/canvas/index.js",
  "@napi-rs/canvas-linux-x64-gnu/skia.node",
  "@napi-rs/canvas-darwin-arm64/skia.node",
  "@napi-rs/canvas-win32-x64-msvc/skia.node",
  "viem/_esm/actions/test/dropTransaction.js",
  "pkg/docs/index.js",
  "pkg/index.js",
  "pkg/index.js.map",
  "pkg/index.d.ts",
  "pkg/index.d.mts",
  "pkg/LICENSE",
  "pkg/README.md",
  "@datadog/pprof/prebuilds/linux-x64/dd_pprof.node.abi137.node",
  "@datadog/pprof/prebuilds/linux-x64/dd_pprof.musl.node.abi137.node",
  "@datadog/pprof/prebuilds/linux-arm64/dd_pprof.node.abi137.node",
  "@datadog/pprof/prebuilds/darwin-arm64/dd_pprof.node.abi137.node",
  "@datadog/pprof/prebuilds/win32-x64/dd_pprof.node.abi137.node",
  "@datadog/pprof/out/src/index.js",
  "utf-8-validate/prebuilds/darwin-x64+arm64/utf-8-validate.node",
  "utf-8-validate/prebuilds/linux-x64/utf-8-validate.node",
  "some-lib/prebuilds/README.txt",
  "some-lib/prebuilds/generic/thing.js",
];
function tree() {
  const nm = join(mkdtempSync(join(tmpdir(), "kv-prune-")), "node_modules");
  for (const f of FILES) {
    mkdirSync(dirname(join(nm, f)), { recursive: true });
    writeFileSync(join(nm, f), "x");
  }
  return nm;
}
const has = (nm, f) => existsSync(join(nm, f));

describe("prune", () => {
  it("keeps this platform's natives and every code directory, whatever its name (never prune by directory name)", () => {
    const nm = tree();
    const freed = prune(nm, "x86_64-unknown-linux-gnu");
    expect(freed).toBeGreaterThan(0);
    for (const f of ["@img/sharp-linux-x64/lib/sharp.node", "@img/colour/index.js", "@napi-rs/canvas/index.js", "@napi-rs/canvas-linux-x64-gnu/skia.node", "viem/_esm/actions/test/dropTransaction.js", "pkg/docs/index.js", "pkg/index.js", "pkg/LICENSE", "pkg/README.md"]) expect(has(nm, f), f).toBe(true);
    for (const f of ["onnxruntime-node", "@img/sharp-linuxmusl-x64", "@img/sharp-darwin-arm64", "@napi-rs/canvas-darwin-arm64", "@napi-rs/canvas-win32-x64-msvc", "pkg/index.js.map", "pkg/index.d.ts", "pkg/index.d.mts"]) expect(has(nm, f), f).toBe(false);
  });
  it("keeps the macOS arm64 natives for that target, and nothing for Linux or Windows", () => {
    const nm = tree();
    prune(nm, "aarch64-apple-darwin");
    expect(has(nm, "@img/sharp-darwin-arm64/lib/sharp.node")).toBe(true);
    expect(has(nm, "@napi-rs/canvas-darwin-arm64/skia.node")).toBe(true);
    for (const f of ["onnxruntime-node", "@img/sharp-linux-x64", "@img/sharp-darwin-x64", "@napi-rs/canvas-linux-x64-gnu"]) expect(has(nm, f), f).toBe(false);
  });
  it("keeps the Windows x64 natives for that target, whether named win32 or windows, and drops the others", () => {
    const t = "x86_64-pc-windows-msvc";
    expect(foreignNative("@img/sharp-win32-x64", { os: "win32", cpu: "x64", libc: null })).toBe(false);
    for (const name of ["@img/sharp-win32-x64", "@napi-rs/canvas-win32-x64-msvc", "docling.rs-win32-x64-msvc", "@oxfmt/binding-windows-x64"]) expect(foreignNative(name, { os: "win32", cpu: "x64", libc: null }), name).toBe(false);
    for (const name of ["@img/sharp-linux-x64", "@img/sharp-darwin-arm64", "@napi-rs/canvas-win32-arm64-msvc", "lightningcss-linux-x64-musl"]) expect(foreignNative(name, { os: "win32", cpu: "x64", libc: null }), name).toBe(true);
    expect(() => prune(tree(), t)).not.toThrow();
  });
  it("refuses a target it does not know", () => {
    expect(() => prune(tree(), "sparc-sun-solaris")).toThrow(/sparc/);
  });
  it("prunes prebuilds/<os>-<cpu> folders (the prebuildify layout) for other targets, and musl builds for a glibc target", () => {
    const nm = tree();
    prune(nm, "x86_64-unknown-linux-gnu");
    expect(has(nm, "@datadog/pprof/prebuilds/linux-x64/dd_pprof.node.abi137.node")).toBe(true);
    expect(has(nm, "@datadog/pprof/out/src/index.js")).toBe(true);
    for (const f of ["@datadog/pprof/prebuilds/linux-x64/dd_pprof.musl.node.abi137.node", "@datadog/pprof/prebuilds/linux-arm64", "@datadog/pprof/prebuilds/darwin-arm64", "@datadog/pprof/prebuilds/win32-x64"]) expect(has(nm, f), f).toBe(false);
    const mac = tree();
    prune(mac, "aarch64-apple-darwin");
    expect(has(mac, "@datadog/pprof/prebuilds/darwin-arm64/dd_pprof.node.abi137.node")).toBe(true);
    expect(has(mac, "@datadog/pprof/prebuilds/linux-x64")).toBe(false);
  });
  it("keeps a universal prebuild that covers the target, and anything in prebuilds/ that is not named <os>-<cpu>", () => {
    const mac = tree();
    prune(mac, "aarch64-apple-darwin");
    expect(has(mac, "utf-8-validate/prebuilds/darwin-x64+arm64/utf-8-validate.node")).toBe(true);
    expect(has(mac, "utf-8-validate/prebuilds/linux-x64")).toBe(false);
    const linux = tree();
    prune(linux, "x86_64-unknown-linux-gnu");
    expect(has(linux, "utf-8-validate/prebuilds/darwin-x64+arm64")).toBe(false);
    expect(has(linux, "some-lib/prebuilds/README.txt")).toBe(true);
    expect(has(linux, "some-lib/prebuilds/generic/thing.js")).toBe(true);
  });
  it("drops @opentelemetry's bundler-only builds in every copy, but never a build Node resolves", () => {
    const nm = tree();
    const put = (f, body = "x") => { mkdirSync(dirname(join(nm, f)), { recursive: true }); writeFileSync(join(nm, f), body); };
    const otel = (dir, pkg) => {
      put(`${dir}/package.json`, JSON.stringify(pkg));
      for (const b of ["src", "esm", "esnext"]) put(`${dir}/build/${b}/index.js`);
    };
    const usual = { main: "build/src/index.js", module: "build/esm/index.js", esnext: "build/esnext/index.js", exports: { ".": { module: "./build/esm/index.js", esnext: "./build/esnext/index.js", require: "./build/src/index.js", default: "./build/src/index.js" } } };
    otel("@opentelemetry/api", usual);
    otel("@apollo/gateway/node_modules/@opentelemetry/core", usual);
    otel("@opentelemetry/odd", { main: "build/src/index.js", exports: { ".": { import: "./build/esm/index.js", require: "./build/src/index.js" } } });
    otel("other/build-alike", usual); // not @opentelemetry: untouched
    prune(nm, "aarch64-apple-darwin");
    for (const d of ["@opentelemetry/api", "@apollo/gateway/node_modules/@opentelemetry/core"]) {
      expect(has(nm, `${d}/build/src/index.js`), d).toBe(true);
      expect(has(nm, `${d}/build/esm`), d).toBe(false);
      expect(has(nm, `${d}/build/esnext`), d).toBe(false);
    }
    // Node's `import` condition points into esm: everything stays
    for (const b of ["src", "esm", "esnext"]) expect(has(nm, `@opentelemetry/odd/build/${b}/index.js`), b).toBe(true);
    expect(has(nm, "other/build-alike/build/esm/index.js")).toBe(true);
    expect(bundlerOnlyBuilds(join(nm, "missing"))).toEqual([]);
  });
  it("drops the typescript compiler at the top level only", () => {
    const nm = tree();
    for (const f of ["typescript/lib/typescript.js", "some-tool/node_modules/typescript/lib/typescript.js"]) { mkdirSync(dirname(join(nm, f)), { recursive: true }); writeFileSync(join(nm, f), "x"); }
    prune(nm, "x86_64-unknown-linux-gnu");
    expect(has(nm, "typescript")).toBe(false);
    expect(has(nm, "some-tool/node_modules/typescript/lib/typescript.js")).toBe(true);
  });
  it("drops the dev toolchain and the unused OpenTelemetry SDK, keeping what the engine loads (nested copies too)", () => {
    const nm = tree();
    const put = (f) => { mkdirSync(dirname(join(nm, f)), { recursive: true }); writeFileSync(join(nm, f), "x"); };
    const dev = ["vite/index.js", "rolldown/index.js", "@rolldown/binding-darwin-arm64/r.node", "@rolldown/pluginutils/index.js", "esbuild/lib/main.js", "esbuild-darwin-arm64/bin/esbuild", "lightningcss/node/index.js", "lightningcss-darwin-arm64/l.node", "@powerhousedao/vetra/index.js", "@powerhousedao/codegen/index.js", "ts-morph/index.js", "@ts-morph/common/index.js", "oxfmt/index.js", "@oxfmt/binding-darwin-arm64/o.node"];
    dev.push("@opentelemetry/sdk-node/index.js", "@opentelemetry/exporter-trace-otlp-http/index.js", "@opentelemetry/sdk-metrics/index.js");
    const kept = ["@opentelemetry/api/index.js", "@opentelemetry/core/index.js", "@opentelemetry/resource-detector-aws/index.js", "@apollo/gateway/node_modules/@opentelemetry/sdk-metrics/index.js", "@powerhousedao/switchboard/index.js", "@powerhousedao/reactor-api/index.js", "vitest-like/index.js", "esbuildish/index.js", "onnxruntime-common/index.js"];
    for (const f of [...dev, ...kept]) put(f);
    prune(nm, "aarch64-apple-darwin");
    for (const f of dev) expect(has(nm, f), f).toBe(false);
    for (const f of kept) expect(has(nm, f), f).toBe(true);
  });
  it("trims onnxruntime-web to the build and wasm the embedder loads, and leaves it whole when one is missing", () => {
    const KEEP = ["ort.webgpu.bundle.min.mjs", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm", "ort.node.min.mjs", "ort.node.min.js"];
    const DROP = ["ort.all.mjs", "ort.webgl.js", "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.jspi.wasm", "ort-wasm-simd-threaded.wasm"];
    const build = (keep) => {
      const nm = tree();
      const put = (f) => { mkdirSync(dirname(join(nm, f)), { recursive: true }); writeFileSync(join(nm, f), "x"); };
      for (const f of [...keep, ...DROP]) put(`onnxruntime-web/dist/${f}`);
      for (const f of ["onnxruntime-web/package.json", "onnxruntime-web/lib/index.ts", "onnxruntime-web/docs/a.md", "onnxruntime-web/node_modules/onnxruntime-common/index.js", "@powerhousedao/knowledge-note/dist/node/wasm/ort-wasm-simd-threaded.asyncify.wasm", "@powerhousedao/knowledge-note/dist/node/models/m.onnx"]) put(f);
      prune(nm, "x86_64-unknown-linux-gnu");
      return nm;
    };
    const nm = build(KEEP);
    for (const f of KEEP) expect(has(nm, `onnxruntime-web/dist/${f}`), f).toBe(true);
    for (const f of DROP) expect(has(nm, `onnxruntime-web/dist/${f}`), f).toBe(false);
    for (const f of ["onnxruntime-web/lib", "onnxruntime-web/docs", "@powerhousedao/knowledge-note/dist/node/wasm"]) expect(has(nm, f), f).toBe(false);
    for (const f of ["onnxruntime-web/package.json", "onnxruntime-web/node_modules/onnxruntime-common/index.js", "@powerhousedao/knowledge-note/dist/node/models/m.onnx"]) expect(has(nm, f), f).toBe(true);
    // a version whose files are named differently: nothing goes, the fallback wasm included
    const renamed = build(KEEP.slice(1));
    for (const f of DROP) expect(has(renamed, `onnxruntime-web/dist/${f}`), f).toBe(true);
    expect(has(renamed, "onnxruntime-web/lib/index.ts")).toBe(true);
    expect(has(renamed, "@powerhousedao/knowledge-note/dist/node/wasm/ort-wasm-simd-threaded.asyncify.wasm")).toBe(true);
  });
  it("sweeps packages nothing declares any more, transitively, keeping the app's dependencies and undeclared imports", () => {
    const nm = tree();
    const pkg = (name, deps = {}, extra = {}) => { mkdirSync(join(nm, name), { recursive: true }); writeFileSync(join(nm, name, "package.json"), JSON.stringify({ name, dependencies: deps, ...extra })); };
    writeFileSync(join(nm, "..", "package.json"), JSON.stringify({ name: "app", dependencies: { engine: "1" } }));
    pkg("engine", { lib: "1" });
    pkg("lib", {}, { peerDependencies: { peer: "1" } });
    pkg("peer");
    pkg("nested-host", {});
    mkdirSync(join(nm, "lib", "node_modules", "inner"), { recursive: true });
    writeFileSync(join(nm, "lib", "node_modules", "inner", "package.json"), JSON.stringify({ name: "inner", dependencies: { "hoisted-for-inner": "1" } }));
    pkg("hoisted-for-inner");
    pkg("codegen-cli", { "codegen-loader": "1" }); // its dependent was dropped: an orphan, and so is what only it needs
    pkg("codegen-loader", { "codegen-util": "1" });
    pkg("codegen-util");
    pkg("string-width"); // imported without being declared
    const gone = orphans(nm, join(nm, "..", "package.json"));
    for (const p of ["codegen-cli", "codegen-loader", "codegen-util", "nested-host"]) expect(gone, p).toContain(p);
    for (const p of ["engine", "lib", "peer", "hoisted-for-inner", "string-width"]) expect(gone, p).not.toContain(p);
    prune(nm, "aarch64-apple-darwin");
    expect(has(nm, "codegen-util")).toBe(false);
    expect(has(nm, "hoisted-for-inner/package.json")).toBe(true);
  });
});
