import { join } from "node:path";
import { create } from "tar";

/**
 * Windows: the staged engine (.stage/sidecar) as one archive, .stage/engine.tar. The installer builder (NSIS)
 * cannot open files whose path passes 260 characters, and the engine's nested node_modules go deeper (277
 * characters inside the bundle, before C:\Users\…\AppData\Local\…). The installer carries the one file; the
 * app unpacks it on first launch (src-tauri/src/engine_archive.rs). Entries are `sidecar/…`, uncompressed
 * (the installer compresses), portable (no owner, no mtime), long names in pax headers.
 */
export function packEngine(stageDir) {
  const file = join(stageDir, "engine.tar");
  create({ file, cwd: stageDir, sync: true, portable: true, noMtime: true }, ["sidecar"]);
  return file;
}
