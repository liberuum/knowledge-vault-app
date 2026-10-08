/**
 * The macOS docling.rs binding this project builds (docling.rs publishes its Node binding for Linux and
 * Windows only). Pure helpers for scripts/docling-binding.mjs and its tests.
 */

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SYMTAB = 0x2;

/**
 * Where a 64-bit Mach-O keeps its symbol and string tables, and whether dyld will accept them. macOS 27's
 * dyld refuses a library whose string table is not 8-byte aligned ("mis-aligned LINKEDIT string pool");
 * the linker in Xcode 27's command-line tools (ld-27037) writes such files when the indirect symbol table
 * has an odd number of 4-byte entries. Building on an older Xcode avoids it; this check catches it.
 */
export function linkeditAlignment(buf) {
  if (buf.length < 32 || buf.readUInt32LE(0) !== MH_MAGIC_64) throw new Error("not a thin 64-bit Mach-O file");
  const ncmds = buf.readUInt32LE(16);
  let off = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (cmd === LC_SYMTAB) {
      const symoff = buf.readUInt32LE(off + 8);
      const stroff = buf.readUInt32LE(off + 16);
      return { symoff, stroff, ok: symoff % 8 === 0 && stroff % 8 === 0 };
    }
    off += size;
  }
  throw new Error("no LC_SYMTAB load command");
}

/** The npm-shaped package.json of the platform package, as docling.rs's loader requires it by name. */
export function platformPackageJson(version) {
  return {
    name: "docling.rs-darwin-arm64",
    version,
    description: "docling.rs Node binding for macOS on Apple silicon, built by knowledge-vault-app from the docling.rs release of the same version.",
    os: ["darwin"],
    cpu: ["arm64"],
    main: "docling-rs.darwin-arm64.node",
    files: ["docling-rs.darwin-arm64.node"],
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/docling-project/docling.rs.git", directory: "crates/docling-node" },
  };
}

/** A small document whose Markdown proves the converter parsed structure, not just text. */
export const SAMPLE_HTML = "<html><body><h1>Binding check</h1><p>One <b>claim</b> per note.</p><table><tr><th>Metric</th><th>Value</th></tr><tr><td>Notes</td><td>24</td></tr></table></body></html>";

/** What a working conversion of SAMPLE_HTML must contain. */
export function sampleProblems(result) {
  const problems = [];
  if (result?.status !== "success") problems.push(`status is ${result?.status}`);
  const md = String(result?.content ?? "");
  if (!/^# Binding check/m.test(md)) problems.push("no level-1 heading");
  if (!/\|\s*Metric\s*\|\s*Value\s*\|/.test(md)) problems.push("no table header row");
  return problems;
}
