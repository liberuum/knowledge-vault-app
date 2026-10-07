// Tauri runs this before a release build (build.beforeBuildCommand): an installer must carry the
// real engine and the bundled Node — never ensure-bundle-inputs' development placeholder.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];
const problems = [];
if (existsSync(resolve(".stage/sidecar/PLACEHOLDER.txt")) || !existsSync(resolve(".stage/sidecar/dist/main.js"))) problems.push(".stage/sidecar is not a staged engine — run `node scripts/stage-sidecar.mjs`");
const node = `src-tauri/binaries/kv-node-${triple}${triple.includes("windows") ? ".exe" : ""}`;
if (!existsSync(resolve(node))) problems.push(`${node} is missing — run \`node scripts/fetch-node.mjs --target ${triple}\``);
if (problems.length) {
  console.error(`[bundle] refusing to build an installer:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`[bundle] staged engine and kv-node for ${triple} present`);
