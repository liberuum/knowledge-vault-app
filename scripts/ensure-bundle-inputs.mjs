// Tauri's build script checks that the bundle's inputs exist even for a development build:
// the bundled Node (src-tauri/binaries/kv-node-<triple>) and the staged engine (.stage/sidecar/).
// This makes a fresh clone build: the real Node is fetched (cached, checksum-verified), and an
// empty, marked placeholder stands in for the engine — `bun run build:app` always stages it for real.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const triple = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))[1];
if (!existsSync(resolve("src-tauri", "binaries", `kv-node-${triple}${triple.includes("windows") ? ".exe" : ""}`))) {
  execFileSync(process.execPath, ["scripts/fetch-node.mjs", "--target", triple], { stdio: "inherit" });
}
const stage = resolve(".stage", "sidecar");
if (!existsSync(stage)) {
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "PLACEHOLDER.txt"), "Not a staged engine. Run `node scripts/stage-sidecar.mjs` (bun run build:app does).\n");
  console.log("[bundle-inputs] .stage/sidecar is a placeholder (development build)");
}
