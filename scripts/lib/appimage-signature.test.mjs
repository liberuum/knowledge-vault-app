import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { elfSections, signatureParts, signedDigest } from "./appimage-signature.mjs";

/** A minimal 64-bit little-endian ELF with the two AppImage signature sections, a string table and a payload. */
function fakeAppImage({ signature, key, withSignatureSections = true }) {
  const names = withSignatureSections ? "\0.sha256_sig\0.sig_key\0.shstrtab\0" : "\0.shstrtab\0";
  const pad = (text, size) => Buffer.concat([Buffer.from(text, "latin1"), Buffer.alloc(size - text.length)]);
  const strtab = pad(names, 64);
  const sig = pad(signature ?? "", 64);
  const keyBytes = pad(key ?? "", 64);
  const payload = Buffer.from("hsqs-squashfs-payload".padEnd(64, "."), "latin1");
  const sections = withSignatureSections
    ? [{ name: 1, offset: 128, size: 64 }, { name: 13, offset: 192, size: 64 }, { name: 22, offset: 64, size: 64 }]
    : [{ name: 1, offset: 64, size: 64 }];
  const shoff = 320;
  const headers = Buffer.alloc((sections.length + 1) * 64); // entry 0 is the null section
  sections.forEach((s, i) => {
    const at = (i + 1) * 64;
    headers.writeUInt32LE(s.name, at);
    headers.writeBigUInt64LE(BigInt(s.offset), at + 24);
    headers.writeBigUInt64LE(BigInt(s.size), at + 32);
  });
  const elf = Buffer.alloc(64);
  elf.writeUInt32BE(0x7f454c46, 0);
  elf[4] = 2; // 64-bit
  elf[5] = 1; // little-endian
  elf.writeBigUInt64LE(BigInt(shoff), 0x28);
  elf.writeUInt16LE(64, 0x3a);
  elf.writeUInt16LE(sections.length + 1, 0x3c);
  elf.writeUInt16LE(sections.length, 0x3e); // the string table is the last section
  const body = withSignatureSections ? [elf, strtab, sig, keyBytes, payload] : [elf, strtab, Buffer.alloc(192)];
  return Buffer.concat([...body, headers]);
}

const SIGNATURE = "-----BEGIN PGP SIGNATURE-----\niHUE\n-----END PGP SIGNATURE-----\n";
const KEY = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmDME\n";

describe("AppImage signature sections", () => {
  it("finds the signature and key sections of the runtime's ELF header", () => {
    const sections = elfSections(fakeAppImage({ signature: SIGNATURE, key: KEY }));
    expect(sections.get(".sha256_sig")).toEqual({ offset: 128, size: 64 });
    expect(sections.get(".sig_key")).toEqual({ offset: 192, size: 64 });
  });
  it("reads the signature and key without their NUL padding", () => {
    const parts = signatureParts(fakeAppImage({ signature: SIGNATURE, key: KEY }));
    expect(parts.signature).toBe(SIGNATURE);
    expect(parts.key).toBe(KEY);
  });
  it("digests the file with both sections zeroed, as appimagetool signs it, in any region order", () => {
    const buf = fakeAppImage({ signature: SIGNATURE, key: KEY });
    const { regions } = signatureParts(buf);
    const zeroed = Buffer.from(buf);
    for (const { offset, size } of regions) zeroed.fill(0, offset, offset + size);
    const expected = createHash("sha256").update(zeroed).digest("hex");
    expect(signedDigest(buf, regions)).toBe(expected);
    expect(signedDigest(buf, [...regions].reverse())).toBe(expected);
    // An unsigned AppImage digests to the same value: the signature never covers itself.
    const { regions: unsignedRegions } = signatureParts(fakeAppImage({ signature: "", key: "" }));
    expect(signedDigest(fakeAppImage({ signature: "", key: "" }), unsignedRegions)).toBe(expected);
  });
  it("refuses a file that is not an ELF, or an ELF without the signature sections", () => {
    expect(() => elfSections(Buffer.from("not an appimage, just text ....".padEnd(80, ".")))).toThrow("not an ELF file");
    expect(() => signatureParts(fakeAppImage({ withSignatureSections: false }))).toThrow("not an AppImage of type 2");
  });
});
