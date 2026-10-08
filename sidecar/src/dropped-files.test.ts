import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { droppedFilePath } from "./dropped-files.js";

const base = mkdtempSync(join(tmpdir(), "kv-drop-"));
const home = join(base, "home");
const outside = join(base, "elsewhere");
mkdirSync(join(home, "Downloads"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(home, "Downloads", "report.pdf"), "%PDF");
writeFileSync(join(outside, "secret.txt"), "no");
symlinkSync(join(outside, "secret.txt"), join(home, "link.txt"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("droppedFilePath", () => {
  it("reads a file dropped from the home folder, given as a file:// address", () => {
    // Real paths on both sides: macOS resolves the temp folder through /private.
    expect(droppedFilePath(pathToFileURL(join(home, "Downloads", "report.pdf")).href, [home])).toEqual({ path: realpathSync(join(home, "Downloads", "report.pdf")) });
  });
  it("refuses anything outside the allowed folders, including through a symlink or ..", () => {
    expect(droppedFilePath(join(outside, "secret.txt"), [home])).toMatchObject({ status: 403 });
    expect(droppedFilePath(join(home, "link.txt"), [home])).toMatchObject({ status: 403 });
    expect(droppedFilePath(join(home, "..", "elsewhere", "secret.txt"), [home])).toMatchObject({ status: 403 });
  });
  it("refuses folders, relative paths and files that are gone", () => {
    expect(droppedFilePath(join(home, "Downloads"), [home])).toMatchObject({ status: 400 });
    expect(droppedFilePath("Downloads/report.pdf", [home])).toMatchObject({ status: 400 });
    expect(droppedFilePath(join(home, "gone.pdf"), [home])).toMatchObject({ status: 404 });
  });
});
