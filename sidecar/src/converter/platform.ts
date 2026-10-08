import { selfBuiltReady } from "./install.js";

/**
 * The platform packages the converter installs: the ones `docling.rs` publishes on npm, and darwin-arm64,
 * which upstream does not publish and this project builds from the same release.
 */
export type PlatformTriple = "linux-x64-gnu" | "linux-arm64-gnu" | "win32-x64-msvc" | "darwin-arm64";

/** A Linux without glibc (Alpine, …) gets a musl build upstream does not publish for us. Mirrors native.js's probe. */
export function isMusl(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux") return false;
  try {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    return !header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** Which binding this machine can install, or why none. */
export function platformTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(platform),
  darwinReady: boolean = selfBuiltReady("darwin-arm64"),
): { triple: PlatformTriple | null; reason: string | null } {
  if (platform === "linux") {
    if (musl) return { triple: null, reason: "docling.rs publishes no binding for musl-based Linux." };
    if (arch === "x64") return { triple: "linux-x64-gnu", reason: null };
    if (arch === "arm64") return { triple: "linux-arm64-gnu", reason: null };
  }
  if (platform === "win32" && arch === "x64") return { triple: "win32-x64-msvc", reason: null };
  if (platform === "darwin" && arch === "arm64") {
    if (darwinReady) return { triple: "darwin-arm64", reason: null };
    return { triple: null, reason: "The converter for macOS is coming — docling.rs publishes no macOS binding yet; text PDFs, Markdown and plain text work now." };
  }
  if (platform === "darwin") return { triple: null, reason: "The converter needs an Apple silicon Mac; text PDFs, Markdown and plain text work now." };
  return { triple: null, reason: `docling.rs publishes no binding for ${platform}/${arch}.` };
}
