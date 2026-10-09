// Prints the release notes for the current checkout (the release workflow uses it as the body).
import { existsSync, readFileSync } from "node:fs";
import { releaseNotes } from "./lib/release-notes.mjs";
import { NODE_VERSION } from "./node-version.mjs";

const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const sidecar = json("sidecar/package.json").dependencies;
const app = json("package.json").version;
const whatsNewFile = `docs/releases/${app}.md`;
process.stdout.write(
  releaseNotes({
    app,
    whatsNew: existsSync(whatsNewFile) ? readFileSync(whatsNewFile, "utf8") : undefined,
    stack: sidecar["@powerhousedao/switchboard"],
    vaultPackage: sidecar["@powerhousedao/knowledge-note"],
    node: NODE_VERSION,
  }) + "\n",
);
