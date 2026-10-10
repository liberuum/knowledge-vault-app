import { existsSync, lstatSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_SUBDIRS, prepareDataDir, setAsideStaleSnapshots } from "./data-dir.js";

describe("prepareDataDir", () => {
  it("creates the layout with a private secrets dir and removes a leftover node_modules link", () => {
    const dir = mkdtempSync(join(tmpdir(), "kv data äö-"));
    symlinkSync("/nowhere/that/exists", join(dir, "node_modules")); // the Phase 0 link, now dangling
    prepareDataDir(dir);
    for (const sub of DATA_SUBDIRS) expect(existsSync(join(dir, sub)), sub).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(dir, "secrets")).mode & 0o777).toBe(0o700);
    expect(() => lstatSync(join(dir, "node_modules"))).toThrow(/ENOENT/);
    prepareDataDir(dir); // idempotent
    expect(existsSync(join(dir, "reactor"))).toBe(true);
  });
});

describe("setAsideStaleSnapshots", () => {
  it("renames a snapshot beside a plain store, and leaves a real snapshot store to the Switchboard", () => {
    const dir = mkdtempSync(join(tmpdir(), "kv data äö-"));
    prepareDataDir(dir);
    // reactor: a plain directory with a leftover snapshot (the Switchboard would restore it over the store)
    writeFileSync(join(dir, "reactor", "PG_VERSION"), "17\n");
    writeFileSync(join(dir, "reactor", "snapshot.bin"), "old");
    // read-model: a snapshot store with no PG_VERSION, which the Switchboard converts itself
    writeFileSync(join(dir, "read-model", "snapshot.bin"), "real");
    const moved = setAsideStaleSnapshots(dir, new Date("2026-10-10T12:00:00.000Z"));
    expect(moved).toEqual([join(dir, "reactor", "snapshot.bin.stale-2026-10-10T12-00-00-000Z")]);
    expect(readdirSync(join(dir, "reactor")).sort()).toEqual(["PG_VERSION", "snapshot.bin.stale-2026-10-10T12-00-00-000Z"]);
    expect(existsSync(join(dir, "read-model", "snapshot.bin"))).toBe(true);
    expect(setAsideStaleSnapshots(dir)).toEqual([]); // nothing left to move
  });
});
