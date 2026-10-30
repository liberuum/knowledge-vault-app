import { readFileSync } from "node:fs";
import { checkPgliteVersion, checkStackVersions, checkVaultAssets } from "./lib/stack-versions.mjs";
const EXPECTED = "6.2.3-dev.85";
const manifests = ["host", "sidecar"].map((dir) => {
  const p = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), "utf8"));
  return { name: dir, deps: { ...p.dependencies, ...p.devDependencies } };
});
const problems = checkStackVersions(manifests, EXPECTED);
const sidecarPkg = JSON.parse(readFileSync(new URL("../sidecar/package.json", import.meta.url), "utf8"));
let switchboardPglite;
try {
  switchboardPglite = JSON.parse(readFileSync(new URL("../sidecar/node_modules/@powerhousedao/switchboard/package.json", import.meta.url), "utf8")).dependencies?.["@electric-sql/pglite"];
} catch {
  switchboardPglite = undefined;
}
const pglite = checkPgliteVersion(sidecarPkg.dependencies?.["@electric-sql/pglite"], switchboardPglite);
if (pglite) problems.push(pglite);
// The vault package as installed for the sidecar (its own node_modules, else the workspace root's).
let vaultPeers;
for (const base of ["../sidecar/node_modules", "../node_modules"]) {
  try {
    vaultPeers = JSON.parse(readFileSync(new URL(`${base}/@powerhousedao/knowledge-note/package.json`, import.meta.url), "utf8")).peerDependencies;
    break;
  } catch {
    // not installed here
  }
}
const assets = checkVaultAssets(sidecarPkg.dependencies?.["@powerhousedao/knowledge-vault-assets"], vaultPeers?.["@powerhousedao/knowledge-vault-assets"]);
if (assets) problems.push(assets);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `stack ${EXPECTED} pinned in ${manifests.length} workspaces; pglite ${switchboardPglite} matches the Switchboard; vault assets ${vaultPeers["@powerhousedao/knowledge-vault-assets"]} match the vault package`,
);
