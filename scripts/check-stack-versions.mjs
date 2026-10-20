import { readFileSync } from "node:fs";
import { checkPgliteVersion, checkStackVersions } from "./lib/stack-versions.mjs";
const EXPECTED = "6.2.3-dev.66";
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
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`stack ${EXPECTED} pinned in ${manifests.length} workspaces; pglite ${switchboardPglite} matches the Switchboard`);
