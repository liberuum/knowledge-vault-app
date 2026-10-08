import type { SidecarInfo } from "../sidecar.js";

/**
 * Files from a drop that carried only their addresses (WebKitGTK gives a page `text/uri-list` for files dragged from
 * a file manager): the engine reads each one, and the page gets real files to hand to the intake.
 */
export async function filesFromUriList(info: SidecarInfo, uriList: string, fetchImpl: typeof fetch = fetch): Promise<{ files: File[]; failed: string[] }> {
  const uris = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("file:"));
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
