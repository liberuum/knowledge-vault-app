import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { packEngine } from "./pack-engine.mjs";

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("packEngine", () => {
  it("packs .stage/sidecar into one archive and keeps paths longer than Windows' 260 characters", async () => {
    const stage = mkdtempSync(join(tmpdir(), "kv-pack-"));
    dirs.push(stage);
    const deep = join("sidecar", "node_modules", ...Array.from({ length: 12 }, (_, i) => `@scope-${i}/package-with-a-long-name-${i}`));
    mkdirSync(join(stage, deep), { recursive: true });
    writeFileSync(join(stage, deep, "index.js"), "module.exports = 1;\n");
    mkdirSync(join(stage, "sidecar", "dist"), { recursive: true });
    writeFileSync(join(stage, "sidecar", "dist", "main.js"), "// engine\n");

    const file = packEngine(stage);
    expect(file).toBe(join(stage, "engine.tar"));
    expect(statSync(file).size).toBeGreaterThan(0);
    const entries = [];
    await list({ file, onReadEntry: (e) => entries.push(e.path) });
    const long = entries.find((p) => p.endsWith("index.js"));
    expect(long).toBe(`${deep.split("\\").join("/")}/index.js`);
    expect(long.length).toBeGreaterThan(260);
    expect(entries).toContain("sidecar/dist/main.js");
    expect(entries.every((p) => p.startsWith("sidecar/"))).toBe(true);
  });
});
