// A .deb must install only the app's own binaries into /usr/bin — never a `node` that would
// collide with (or silently become) the system's (Plan 6 review C1).
//   node scripts/check-deb.mjs <file.deb>
import { execFileSync } from "node:child_process";
import { debBinaries } from "./lib/release-notes.mjs";

const ALLOWED = new Set(["knowledge-vault-app", "kv-node"]);
/** dpkg-deb where it exists (Debian, Ubuntu, CI); elsewhere the .deb's data archive read with ar + tar. */
function listing(deb) {
  try {
    return execFileSync("dpkg-deb", ["-c", deb], { encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const members = execFileSync("ar", ["t", deb], { encoding: "utf8" }).split("\n");
    const data = members.find((m) => m.startsWith("data.tar"));
    if (!data) throw new Error(`${deb}: no data.tar member`);
    const archive = execFileSync("ar", ["p", deb, data], { maxBuffer: 1 << 30 });
    const flag = data.endsWith(".gz") ? ["-z"] : data.endsWith(".xz") ? ["-J"] : data.endsWith(".zst") ? ["--zstd"] : [];
    return execFileSync("tar", [...flag, "-t", "-f", "-"], { input: archive, encoding: "utf8", maxBuffer: 1 << 28 });
  }
}
const found = debBinaries(listing(process.argv[2]));
const extra = found.filter((b) => !ALLOWED.has(b));
if (extra.length) {
  console.error(`[deb] would install into /usr/bin: ${extra.join(", ")}`);
  process.exit(1);
}
console.log(`[deb] /usr/bin: ${found.join(", ")}`);
