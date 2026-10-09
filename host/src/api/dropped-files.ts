import type { SidecarInfo } from "../sidecar.js";
import { invokeIfTauri } from "../shell/tauri.js";

/**
 * Files from a drop that carried only their addresses (WebKitGTK gives a page `text/uri-list` for files dragged from
 * a file manager): the engine reads each one, and the page gets real files to hand to the intake.
 */
export async function filesFromUriList(info: SidecarInfo, uriList: string, fetchImpl: typeof fetch = fetch): Promise<{ files: File[]; failed: string[] }> {
  // file:// addresses, or absolute paths (some file managers hand those over as plain text)
  const uris = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("file:") || line.startsWith("/") || /^[A-Za-z]:\\/.test(line));
  const files: File[] = [];
  const failed: string[] = [];
  for (const uri of uris) {
    const fallbackName = decodeURIComponent(uri.split("/").pop() ?? "file");
    try {
      const res = await fetchImpl(`${info.controlOrigin}/dropped-file?path=${encodeURIComponent(uri)}`, { headers: { authorization: `Bearer ${info.controlToken}` } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        failed.push(`${fallbackName}: ${body.error ?? `the engine answered ${res.status}`}`);
        continue;
      }
      const name = decodeURIComponent(res.headers.get("x-file-name") ?? fallbackName);
      const blob = await res.blob();
      files.push(new File([blob], name, { type: blob.type }));
    } catch (e) {
      failed.push(`${fallbackName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { files, failed };
}

/**
 * The files of a drop that held none the page could read. On Linux, WebKitGTK shows a page only the first file's
 * address, so the window's own list of the drop comes first (the shell keeps it, src-tauri/src/drop_capture.rs);
 * the addresses the page saw are the fallback. Windows and macOS hand pages the files themselves, so their drops
 * never get here with any.
 */
export async function filesFromDrop(info: SidecarInfo, shown: string, fetchImpl: typeof fetch = fetch): Promise<{ files: File[]; failed: string[] }> {
  const whole = await invokeIfTauri<string[]>("take_dropped_paths").catch(() => undefined);
  return filesFromUriList(info, whole?.length ? whole.join("\n") : shown, fetchImpl);
}
