import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { describe, expect, it } from "vitest";
import { BackupTooNewError, createBackup, listBackups, NotEnoughSpaceError, pruneBackups, restoreBackup } from "./backups.js";
import { ArchivePathError, archiveTarget, cleanImportStaging, importArchive, inspectArchive, NotABackupFileError, packBackup, suggestedFileName } from "./store-archive.js";

const STACK = "6.2.3-dev.44";
const plenty = () => ({ available: 10 ** 12 });
const NOW = () => "2026-10-07T12:00:00.000Z";
const LATER = () => "2026-10-08T09:30:00.000Z";

function store(): string {
  const d = mkdtempSync(join(tmpdir(), "kv-archive-"));
  for (const sub of ["reactor/base/1", "read-model/base", "attachments/ab", "secrets"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, "reactor", "base", "1", "2619_fsm"), "r".repeat(40_000));
  writeFileSync(join(d, "reactor", "PG_VERSION"), "17");
  writeFileSync(join(d, "read-model", "base", "16384"), "m".repeat(9_000));
  writeFileSync(join(d, "attachments", "ab", "cd.pdf"), "%PDF-1.7");
  writeFileSync(join(d, "secrets", "llm.key"), "sk-secret");
  writeFileSync(join(d, "config.json"), JSON.stringify({ version: 1, stackVersion: STACK }));
  writeFileSync(join(d, "pipelines.json"), '{"v":1}');
  return d;
}
const folder = () => mkdtempSync(join(tmpdir(), "kv-out-"));

/** A tar.gz built by hand, for files a Knowledge Vault would never write. */
async function craft(dir: string, entries: string[], file = join(folder(), "crafted.kvbackup")): Promise<string> {
  await create({ cwd: dir, gzip: true, file, portable: true, preservePaths: true }, entries);
  return file;
}
function manifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "evil", stackVersion: STACK, createdAt: NOW(), bytes: 10, complete: true, format: "knowledge-vault-backup", formatVersion: 1, ...over });
}

describe("a backup as one file", () => {
  it("packs a backup into a .kvbackup, previews it from its head, and unpacks it into an imported backup — the store whole, never a key", async () => {
    const d = store();
    const made = createBackup(d, STACK, { now: NOW, statfs: plenty }, { vaults: [{ name: "Research", noteCount: 39 }] });
    const steps: number[] = [];
    const out = await packBackup(d, made.name, join(folder(), "My vaults"), { appVersion: "0.2.2", onProgress: (done, total) => steps.push(done / total) });
    expect(out.path.endsWith("My vaults.kvbackup")).toBe(true);
    expect(out.bytes).toBeGreaterThan(0);
    expect(out.bytes).toBeLessThan(made.bytes); // a store's pages pack small
    expect(steps.at(-1)).toBe(1);
    expect(existsSync(`${out.path}.partial`)).toBe(false);

    const summary = await inspectArchive(out.path, STACK);
    expect(summary).toMatchObject({ name: made.name, createdAt: NOW(), stackVersion: STACK, appVersion: "0.2.2", vaults: [{ name: "Research", noteCount: 39 }], tooNew: false, fileBytes: out.bytes });

    const other = store(); // another computer
    const progress: number[] = [];
    const imported = await importArchive(other, out.path, STACK, { now: LATER, statfs: plenty, onProgress: (done, total) => progress.push(done / total) });
    expect(imported).toMatchObject({ name: `imported-2026-10-08T09-30-00Z-${STACK}`, kind: "imported", importedFrom: "My vaults.kvbackup", createdAt: NOW(), vaults: [{ name: "Research", noteCount: 39 }] });
    expect(progress.at(-1)).toBe(1);
    expect(readFileSync(join(imported.path, "reactor", "base", "1", "2619_fsm"), "utf8")).toBe("r".repeat(40_000));
    expect(readFileSync(join(imported.path, "attachments", "ab", "cd.pdf"), "utf8")).toBe("%PDF-1.7");
    expect(readFileSync(join(imported.path, "pipelines.json"), "utf8")).toBe('{"v":1}');
    expect(existsSync(join(imported.path, "secrets"))).toBe(false);
    expect(existsSync(join(other, "import-staging"))).toBe(false);

    // …and it restores like any backup: the other computer's store becomes this one's.
    restoreBackup(other, imported.name, STACK, { now: LATER, statfs: plenty });
    expect(readFileSync(join(other, "read-model", "base", "16384"), "utf8")).toBe("m".repeat(9_000));
  });

  it("names the file to propose, adds the extension, and refuses a relative path or a folder that is not there", () => {
    expect(suggestedFileName("2026-10-10T17:19:09.000Z")).toBe("Knowledge Vault backup 2026-10-10.kvbackup");
    const f = folder();
    expect(archiveTarget(join(f, "a.KVBACKUP"))).toBe(join(f, "a.KVBACKUP"));
    expect(archiveTarget(join(f, "a"))).toBe(join(f, "a.kvbackup"));
    expect(() => archiveTarget("a.kvbackup")).toThrow(ArchivePathError);
    expect(() => archiveTarget(join(f, "missing", "a.kvbackup"))).toThrow(/does not exist/);
  });

  it("an imported backup is the user's: pruning keeps it however many backups follow", async () => {
    const d = store();
    const made = createBackup(d, STACK, { now: NOW, statfs: plenty });
    const file = (await packBackup(d, made.name, join(folder(), "x"), { appVersion: "0.2.2" })).path;
    const imported = await importArchive(d, file, STACK, { now: LATER, statfs: plenty });
    for (let i = 0; i < 12; i++) createBackup(d, STACK, { now: () => `2026-10-09T10:00:${String(i).padStart(2, "0")}.000Z`, statfs: plenty });
    pruneBackups(d);
    const names = listBackups(d).map((b) => b.name);
    expect(names).toContain(imported.name);
    expect(names.filter((n) => !n.startsWith("imported-"))).toHaveLength(10);
  });

  it("refuses a file that is not a backup, one made by a newer app, and an import without room for it", async () => {
    const f = folder();
    writeFileSync(join(f, "notes.txt"), "just text");
    await expect(inspectArchive(join(f, "notes.txt"), STACK)).rejects.toThrow(NotABackupFileError);
    await expect(inspectArchive(join(f, "absent.kvbackup"), STACK)).rejects.toThrow(ArchivePathError);
    // A tar whose first entry is not a manifest.
    mkdirSync(join(f, "src", "evil"), { recursive: true });
    writeFileSync(join(f, "src", "evil", "readme.md"), "hi");
    await expect(inspectArchive(await craft(join(f, "src"), ["evil/readme.md"]), STACK)).rejects.toThrow(NotABackupFileError);

    const d = store();
    const made = createBackup(d, "9.0.0", { now: NOW, statfs: plenty });
    const newer = (await packBackup(d, made.name, join(folder(), "newer"), { appVersion: "9.0.0" })).path;
    expect((await inspectArchive(newer, STACK)).tooNew).toBe(true);
    await expect(importArchive(store(), newer, STACK, { statfs: plenty })).rejects.toThrow(BackupTooNewError);

    const ok = createBackup(d, STACK, { now: LATER, statfs: plenty });
    const file = (await packBackup(d, ok.name, join(folder(), "ok"), { appVersion: "0.2.2" })).path;
    await expect(importArchive(store(), file, STACK, { statfs: () => ({ available: 10 }) })).rejects.toThrow(NotEnoughSpaceError);
  });

  it("unpacks only the store's own files: a path that climbs out, a link, or a stray folder stays out", async () => {
    const f = folder();
    const src = join(f, "src");
    mkdirSync(join(src, "evil", "reactor"), { recursive: true });
    mkdirSync(join(src, "evil", "read-model"), { recursive: true });
    mkdirSync(join(src, "evil", "scripts"), { recursive: true });
    writeFileSync(join(src, "evil", "manifest.json"), manifest());
    writeFileSync(join(src, "evil", "reactor", "PG_VERSION"), "17");
    writeFileSync(join(src, "evil", "read-model", "PG_VERSION"), "17");
    writeFileSync(join(src, "evil", "scripts", "run.sh"), "rm -rf ~");
    symlinkSync("/etc/passwd", join(src, "evil", "reactor", "passwd"));
    writeFileSync(join(f, "outside.txt"), "outside");
    const file = await craft(src, ["evil/manifest.json", "evil/reactor", "evil/read-model", "evil/scripts", "../outside.txt"]);

    const d = store();
    const imported = await importArchive(d, file, STACK, { now: LATER, statfs: plenty });
    expect(existsSync(join(imported.path, "reactor", "PG_VERSION"))).toBe(true);
    expect(existsSync(join(imported.path, "reactor", "passwd"))).toBe(false);
    expect(existsSync(join(imported.path, "scripts"))).toBe(false);
    expect(existsSync(join(d, "outside.txt"))).toBe(false);
    expect(existsSync(join(d, "backups", "outside.txt"))).toBe(false);
  });

  it("refuses a file without the store's databases, and leaves nothing half-unpacked behind", async () => {
    const f = folder();
    mkdirSync(join(f, "src", "evil", "reactor"), { recursive: true });
    writeFileSync(join(f, "src", "evil", "manifest.json"), manifest());
    writeFileSync(join(f, "src", "evil", "reactor", "PG_VERSION"), "17");
    const file = await craft(join(f, "src"), ["evil/manifest.json", "evil/reactor"]);
    const d = store();
    await expect(importArchive(d, file, STACK, { statfs: plenty })).rejects.toThrow(/has no read-model/);
    expect(listBackups(d)).toEqual([]);
    expect(existsSync(join(d, "import-staging"))).toBe(false);
    mkdirSync(join(d, "import-staging", "x"), { recursive: true });
    expect(cleanImportStaging(d)).toBe(true);
    expect(cleanImportStaging(d)).toBe(false);
  });
});
