#!/usr/bin/env node
// The macOS docling.rs binding (see .github/workflows/converter-binding.yml).
//
//   node scripts/docling-binding.mjs verify <docling-rs.node> <docling.rs package dir>
//     the Mach-O check, then load it through docling.rs's own loader and convert a sample
//   node scripts/docling-binding.mjs pack <docling-rs.node> <version> <out dir>
//     docling.rs-darwin-arm64-<version>.tgz (npm layout: package/…) and its sha512 integrity
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { linkeditAlignment, platformPackageJson, SAMPLE_HTML, sampleProblems } from "./lib/docling-binding.mjs";

const [cmd, ...args] = process.argv.slice(2);
const fail = (msg) => {
  console.error(`[docling-binding] ${msg}`);
  process.exit(1);
};

if (cmd === "verify") {
  const [nodeFile, jsPackage] = args.map((a) => resolve(a));
  if (!nodeFile || !jsPackage) fail("usage: verify <docling-rs.node> <docling.rs package dir>");
  const align = linkeditAlignment(readFileSync(nodeFile));
  if (!align.ok) fail(`the string table is at ${align.stroff} (symbols at ${align.symoff}): not 8-byte aligned, macOS refuses to load it — build with an older Xcode`);
  console.log(`[docling-binding] Mach-O ok: symbols at ${align.symoff}, strings at ${align.stroff}`);
  // The layout the app installs: <modules>/docling.rs and <modules>/docling.rs-darwin-arm64, side by side.
  const modules = join(mkdtempSync(join(tmpdir(), "docling-verify-")), "node_modules");
  cpSync(jsPackage, join(modules, "docling.rs"), { recursive: true });
  mkdirSync(join(modules, "docling.rs-darwin-arm64"), { recursive: true });
  copyFileSync(nodeFile, join(modules, "docling.rs-darwin-arm64", "docling-rs.darwin-arm64.node"));
  writeFileSync(join(modules, "docling.rs-darwin-arm64", "package.json"), JSON.stringify(platformPackageJson("0.0.0"), null, 2));
  const docling = createRequire(join(modules, "..", "probe.js"))("docling.rs");
  const formats = docling.supportedFormats();
  const missing = ["docx", "pptx", "xlsx", "html", "pdf"].filter((f) => !formats.includes(f));
  if (missing.length) fail(`the binding does not support ${missing.join(", ")}`);
  const result = docling.convert({ name: "check.html", data: Buffer.from(SAMPLE_HTML) });
  const problems = sampleProblems(result);
  if (problems.length) fail(`the sample conversion is wrong: ${problems.join("; ")}\n${result?.content}`);
  console.log(`[docling-binding] loaded; ${formats.length} formats; the sample converted:\n${result.content}`);
} else if (cmd === "pack") {
  const [nodeArg, version, outArg] = args;
  if (!nodeArg || !version || !outArg) fail("usage: pack <docling-rs.node> <version> <out dir>");
  const out = resolve(outArg);
  const work = mkdtempSync(join(tmpdir(), "docling-pack-"));
  mkdirSync(join(work, "package"));
  copyFileSync(resolve(nodeArg), join(work, "package", "docling-rs.darwin-arm64.node"));
  writeFileSync(join(work, "package", "package.json"), JSON.stringify(platformPackageJson(version), null, 2) + "\n");
  mkdirSync(out, { recursive: true });
  const tgz = join(out, `docling.rs-darwin-arm64-${version}.tgz`);
  const r = spawnSync("tar", ["-czf", tgz, "-C", work, "package"], { stdio: "inherit" });
  if (r.status !== 0) fail("tar failed");
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tgz)).digest("base64")}`;
  console.log(`[docling-binding] ${tgz}\n[docling-binding] integrity ${integrity}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tgz=${tgz}\nintegrity=${integrity}\n`);
} else {
  fail("usage: verify <docling-rs.node> <docling.rs package dir> | pack <docling-rs.node> <version> <out dir>");
}
