import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BackupInfo } from "./backups.js";
import { ArchivePathError } from "./store-archive.js";
import { createStoreTransfers, TransferBusyError } from "./store-transfers.js";

const imported: BackupInfo = { name: "imported-2026-10-08T09-30-00Z-6.2.3-dev.44", path: "/d/backups/i", bytes: 10, stackVersion: "6.2.3-dev.44", createdAt: "2026-10-07T12:00:00.000Z", kind: "imported" };
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("store transfers", () => {
  it("runs an export in the background with its progress, and reports the file once written", async () => {
    const d = deferred<{ path: string; bytes: number }>();
    let report: ((done: number, total: number) => void) | undefined;
    const t = createStoreTransfers({ dataDir: "/d", appVersion: "0.2.2", stackVersion: "6.2.3-dev.44", restoreImported: () => {}, pack: (_d, _n, _dest, o) => ((report = o.onProgress), d.promise) });
    const dir = mkdtempSync(join(tmpdir(), "kv-transfer-"));
    const job = t.exportBackup("b1", join(dir, "My vaults"));
    expect(job).toMatchObject({ kind: "export", state: "running", file: join(dir, "My vaults.kvbackup"), backup: "b1" });
    report?.(50, 200);
    expect(t.current()).toMatchObject({ done: 50, total: 200 });
    expect(() => t.importFile("/home/u/x.kvbackup", false)).toThrow(TransferBusyError);
    d.resolve({ path: join(dir, "My vaults.kvbackup"), bytes: 42 });
    await vi.waitFor(() => expect(t.current()).toMatchObject({ state: "done", bytes: 42 }));
    expect(() => t.exportBackup("b1", "relative")).toThrow(ArchivePathError);
  });

  it("an import the user wants restored is handed to the restore once unpacked; a failure is a failed job", async () => {
    const restored: string[] = [];
    let fail = false;
    const t = createStoreTransfers({
      dataDir: "/d",
      appVersion: "0.2.2",
      stackVersion: "6.2.3-dev.44",
      restoreDelayMs: 0,
      restoreImported: (b) => restored.push(b.name),
      unpack: async () => {
        if (fail) throw new Error("not a backup");
        return imported;
      },
    });
    t.importFile("/home/u/vaults.kvbackup", true);
    await vi.waitFor(() => expect(restored).toEqual([imported.name]));
    expect(t.current()).toMatchObject({ kind: "import", state: "done", backup: imported.name, restore: true });
    fail = true;
    t.importFile("/home/u/other.kvbackup", false);
    await vi.waitFor(() => expect(t.current()).toMatchObject({ state: "failed", error: "not a backup" }));
    t.recordFailed("export", "/home/u/z.kvbackup", new Error("No backup was made."));
    expect(t.current()).toMatchObject({ kind: "export", state: "failed", error: "No backup was made." });
  });
});
