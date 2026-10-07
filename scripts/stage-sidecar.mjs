// Plan 6: assemble the engine the installer ships, in .stage/sidecar/:
//   dist/, converter/, powerhouse.config.json, package.json and a self-contained production
//   node_modules — installed from bun.lock (frozen, hoisted, only the sidecar workspace) and
//   pruned for the target. Run on the target OS (native optional packages are the installer's).
//   node scripts/stage-sidecar.mjs [--target <triple>]
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { packEngine } from "./lib/pack-engine.mjs";
import { prune } from "./lib/prune.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const triple = arg("--target") ?? /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];
const root = resolve(".");
const stage = join(root, ".stage");
const ws = join(stage, "ws");
const out = join(stage, "sidecar");

if (!existsSync(join(root, "sidecar", "dist", "main.js"))) {
  console.error("[stage] sidecar/dist/main.js is missing — run `bun run build:sidecar` first");
  process.exit(1);
}
const t0 = Date.now();
// 1. a copy of the workspace's manifests and lockfile: the install resolves exactly what bun.lock pins
rmSync(ws, { recursive: true, force: true });
mkdirSync(join(ws, "host"), { recursive: true });
mkdirSync(join(ws, "sidecar"), { recursive: true });
for (const f of ["package.json", "bun.lock", "bunfig.toml", ".npmrc"]) if (existsSync(join(root, f))) copyFileSync(join(root, f), join(ws, f));
copyFileSync(join(root, "host", "package.json"), join(ws, "host", "package.json"));
copyFileSync(join(root, "sidecar", "package.json"), join(ws, "sidecar", "package.json"));
execFileSync("bun", ["install", "--production", "--frozen-lockfile", "--filter", "@knowledge-vault-app/sidecar", "--linker", "hoisted"], { cwd: ws, stdio: "inherit" });

// 2. the engine as it ships
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const part of ["dist", "converter"]) cpSync(join(root, "sidecar", part), join(out, part), { recursive: true });
for (const f of ["powerhouse.config.json", "package.json"]) copyFileSync(join(root, "sidecar", f), join(out, f));
renameSync(join(ws, "node_modules"), join(out, "node_modules"));
// Command shims (symlinks) live in node_modules/.bin, at the top and inside nested node_modules —
// unused at run time, and symlinks do not survive every bundler. Only `.bin` directly under a node_modules.
const dropShims = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    if (e.name === ".bin" && dir.endsWith("node_modules")) rmSync(p, { recursive: true, force: true });
    else dropShims(p);
  }
};
dropShims(join(out, "node_modules"));
// The workspace's link to itself (`@knowledge-vault-app/sidecar → ../../sidecar`) points outside the bundle.
rmSync(join(out, "node_modules", "@knowledge-vault-app"), { recursive: true, force: true });
rmSync(ws, { recursive: true, force: true });

// 3. this target only
const freed = prune(join(out, "node_modules"), triple);
const links = [];
const size = (p) => {
  const s = lstatSync(p);
  if (s.isSymbolicLink()) {
    links.push(p);
    return 0;
  }
  return s.isDirectory() ? readdirSync(p).reduce((n, e) => n + size(join(p, e)), 0) : s.size;
};
const bytes = size(out);
console.log(`[stage] .stage/sidecar for ${triple}: ${(bytes / 1e6).toFixed(0)} MB (pruned ${(freed / 1e6).toFixed(0)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (links.length) {
  console.error(`[stage] ${links.length} symlink(s) would ship (they break outside this machine): ${links.slice(0, 5).join(", ")}`);
  process.exit(1);
}
// 4. Windows: one archive instead of the deep tree (the installer builder's 260-character path limit);
//    tauri.windows.conf.json ships .stage/engine.tar and the app unpacks it on first launch.
rmSync(join(stage, "engine.tar"), { force: true });
if (triple.includes("windows")) {
  const t1 = Date.now();
  const file = packEngine(stage);
  console.log(`[stage] .stage/engine.tar: ${(lstatSync(file).size / 1e6).toFixed(0)} MB in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
}
