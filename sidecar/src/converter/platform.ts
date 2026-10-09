import { existsSync } from "node:fs";
import { win32 } from "node:path";
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

/** The Microsoft Visual C++ runtime the Windows binding links against; not on a clean Windows, and the app does not ship it. */
const VC_RUNTIME = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"];
export const VC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
/**
 * Whether Windows would find the runtime the binding imports. The loader looks, file by file, in the app's own folder,
 * System32, the Windows folder and every PATH folder. The redistributable installs into System32, but a PC where
 * another program left its copy on PATH loads the binding too, and must not be told it cannot.
 */
export function hasVcRuntime(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  appDir: string = win32.dirname(process.execPath),
): boolean {
  if (platform !== "win32") return true;
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? "C:\\Windows";
  const onPath = (env.Path ?? env.PATH ?? "").split(";").map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const dirs = [appDir, win32.join(root, "System32"), root, ...onPath];
  return VC_RUNTIME.every((dll) => dirs.some((dir) => exists(win32.join(dir, dll))));
}

/** Which binding this machine can install, or why none. */
export function platformTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(platform),
  darwinReady: boolean = selfBuiltReady("darwin-arm64"),
  vcRuntime: boolean = hasVcRuntime(platform),
): { triple: PlatformTriple | null; reason: string | null } {
  if (platform === "linux") {
    if (musl) return { triple: null, reason: "docling.rs publishes no binding for musl-based Linux." };
    if (arch === "x64") return { triple: "linux-x64-gnu", reason: null };
    if (arch === "arm64") return { triple: "linux-arm64-gnu", reason: null };
  }
  if (platform === "win32" && arch === "x64") {
    // Without the runtime the binding installs but cannot load: nothing converts, and the models download fails.
    if (!vcRuntime) return { triple: null, reason: `The converter needs the Microsoft Visual C++ Redistributable (x64). Install it from ${VC_REDIST_URL}, then restart the app; text PDFs, Markdown and plain text work now.` };
    return { triple: "win32-x64-msvc", reason: null };
  }
  if (platform === "darwin" && arch === "arm64") {
    if (darwinReady) return { triple: "darwin-arm64", reason: null };
    return { triple: null, reason: "The converter for macOS is coming — docling.rs publishes no macOS binding yet; text PDFs, Markdown and plain text work now." };
  }
  if (platform === "darwin") return { triple: null, reason: "The converter needs an Apple silicon Mac; text PDFs, Markdown and plain text work now." };
  return { triple: null, reason: `docling.rs publishes no binding for ${platform}/${arch}.` };
}
