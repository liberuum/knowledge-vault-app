// An AppImage (type 2) keeps its GPG signature in ELF sections of its runtime: `.sha256_sig` holds the
// ASCII-armored signature and `.sig_key` the public key, both NUL-padded. What appimagetool signs is the
// lowercase hex SHA-256 of the whole file with those two sections zeroed, as text with no newline.
import { createHash } from "node:crypto";

export const SIGNATURE_SECTION = ".sha256_sig";
export const KEY_SECTION = ".sig_key";

/** name → { offset, size } for each section of a 64-bit little-endian ELF file (the AppImage runtime). */
export function elfSections(buf) {
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) throw new Error("not an ELF file");
  if (buf[4] !== 2 || buf[5] !== 1) throw new Error("not a 64-bit little-endian ELF file");
  const shoff = Number(buf.readBigUInt64LE(0x28));
  const entsize = buf.readUInt16LE(0x3a);
  const count = buf.readUInt16LE(0x3c);
  const strndx = buf.readUInt16LE(0x3e);
  const header = (i) => {
    const at = shoff + i * entsize;
    return { name: buf.readUInt32LE(at), offset: Number(buf.readBigUInt64LE(at + 24)), size: Number(buf.readBigUInt64LE(at + 32)) };
  };
  const names = header(strndx).offset;
  const sections = new Map();
  for (let i = 0; i < count; i++) {
    const h = header(i);
    const start = names + h.name;
    sections.set(buf.toString("latin1", start, buf.indexOf(0, start)), { offset: h.offset, size: h.size });
  }
  return sections;
}

/** The embedded signature and key (text, padding removed), and where they sit. */
export function signatureParts(buf) {
  const sections = elfSections(buf);
  const signature = sections.get(SIGNATURE_SECTION);
  const key = sections.get(KEY_SECTION);
  if (!signature || !key) throw new Error(`no ${SIGNATURE_SECTION}/${KEY_SECTION} sections: not an AppImage of type 2`);
  const text = ({ offset, size }) => buf.toString("latin1", offset, offset + size).replaceAll("\0", "");
  return { signature: text(signature), key: text(key), regions: [signature, key] };
}

/** The text appimagetool signs: the hex SHA-256 of `buf` with `regions` zeroed, without copying the file. */
export function signedDigest(buf, regions) {
  const hash = createHash("sha256");
  let at = 0;
  for (const { offset, size } of [...regions].sort((a, b) => a.offset - b.offset)) {
    hash.update(buf.subarray(at, offset));
    hash.update(Buffer.alloc(size));
    at = offset + size;
  }
  hash.update(buf.subarray(at));
  return hash.digest("hex");
}
