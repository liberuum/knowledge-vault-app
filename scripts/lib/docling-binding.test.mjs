import { describe, expect, it } from "vitest";
import { linkeditAlignment, platformPackageJson, sampleProblems } from "./docling-binding.mjs";

/** A minimal Mach-O 64 header with one LC_SYMTAB command. */
function macho(symoff, stroff) {
  const b = Buffer.alloc(32 + 24);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(1, 16); // ncmds
  b.writeUInt32LE(24, 20); // sizeofcmds
  b.writeUInt32LE(0x2, 32); // LC_SYMTAB
  b.writeUInt32LE(24, 36);
  b.writeUInt32LE(symoff, 40);
  b.writeUInt32LE(10, 44);
  b.writeUInt32LE(stroff, 48);
  b.writeUInt32LE(100, 52);
  return b;
}

describe("the macOS docling.rs binding", () => {
  it("accepts an 8-byte aligned string table and refuses the one macOS 27 will not load", () => {
    expect(linkeditAlignment(macho(44678352, 46942320))).toEqual({ symoff: 44678352, stroff: 46942320, ok: true });
    expect(linkeditAlignment(macho(44678352, 46942316)).ok).toBe(false); // the ld-27037 build
    expect(() => linkeditAlignment(Buffer.from("not a mach-o file, long enough to read"))).toThrow(/Mach-O/);
  });
  it("names the package the way docling.rs's loader requires it", () => {
    expect(platformPackageJson("1.58.0")).toMatchObject({ name: "docling.rs-darwin-arm64", version: "1.58.0", main: "docling-rs.darwin-arm64.node", os: ["darwin"], cpu: ["arm64"] });
  });
  it("judges the sample conversion by its structure", () => {
    expect(sampleProblems({ status: "success", content: "# Binding check\n\n| Metric | Value |\n|---|---|\n| Notes | 24 |" })).toEqual([]);
    expect(sampleProblems({ status: "success", content: "Binding check Metric Value" })).toEqual(["no level-1 heading", "no table header row"]);
    expect(sampleProblems({ status: "failure", content: "" })).toContain("status is failure");
  });
});
