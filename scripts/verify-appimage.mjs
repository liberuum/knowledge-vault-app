// Checks that an AppImage is signed, and by the release key:
//   node scripts/verify-appimage.mjs <file.AppImage> [<fingerprint>]
// The signature is verified against the key embedded beside it; with a fingerprint, that key must be it —
// otherwise anyone could embed a key of their own. Needs gpg. Used by the release workflow after bundling.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signatureParts, signedDigest } from "./lib/appimage-signature.mjs";

const [file, expected] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/verify-appimage.mjs <file.AppImage> [<fingerprint>]");
  process.exit(2);
}
const fail = (why) => {
  console.error(`[appimage] ${file}: ${why}`);
  process.exit(1);
};
const buf = readFileSync(file);
const { signature, key, regions } = signatureParts(buf);
if (!signature.includes("-----BEGIN PGP SIGNATURE-----")) fail("not signed (its signature section is empty)");
if (!key.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")) fail("signed, but carries no key to check it with");

const home = mkdtempSync(join(tmpdir(), "kv-appimage-verify-"));
try {
  chmodSync(home, 0o700);
  writeFileSync(join(home, "key.asc"), key);
  writeFileSync(join(home, "signature.asc"), signature);
  writeFileSync(join(home, "digest.txt"), signedDigest(buf, regions));
  execFileSync("gpg", ["--batch", "--homedir", home, "--import", join(home, "key.asc")], { stdio: "ignore" });
  const verify = spawnSync("gpg", ["--batch", "--homedir", home, "--status-fd", "1", "--verify", join(home, "signature.asc"), join(home, "digest.txt")], { encoding: "utf8" });
  const valid = /^\[GNUPG:\] VALIDSIG ([0-9A-F]{40})/m.exec(verify.stdout ?? "");
  if (verify.status !== 0 || !valid) fail(`the signature does not match the file${verify.stderr ? `:\n${verify.stderr.trim()}` : ""}`);
  const signer = valid[1];
  if (expected && signer !== expected.replace(/\s+/g, "").toUpperCase()) fail(`signed by ${signer}, not by the release key ${expected}`);
  console.log(`[appimage] ${file}: signed by ${signer}${expected ? " (the release key)" : ""}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
