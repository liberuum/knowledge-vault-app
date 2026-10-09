import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * This store's identity: made once with the data folder, gone with it ("Delete all local data" removes everything
 * there). The window keeps a few things of its own per store (the setup guide's progress, getting-started ticks,
 * chat threads); a new id tells it it is facing a new install (host/src/state/window-state.ts).
 */
export function ensureStoreId(dataDir: string): string {
  const file = join(dataDir, "store-id");
  if (existsSync(file)) {
    const id = readFileSync(file, "utf8").trim();
    if (id) return id;
  }
  mkdirSync(dataDir, { recursive: true });
  const id = randomUUID();
  writeFileSync(file, `${id}\n`);
  return id;
}
