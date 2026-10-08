import { createReadStream, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Files dropped on the window, read by the engine. WebKitGTK hands a page the dropped files' addresses
 * (text/uri-list), not the files, so the page asks the engine — which runs as the person — to read them.
 * Only regular files under the home folder or a mounted drive, symlinks resolved first.
 */
export function droppedFileRoots(home = homedir()): string[] {
  return [home, "/media", "/run/media", "/mnt", "/Volumes"].filter((r) => r.length > 0);
}

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function droppedFilePath(input: string, roots: readonly string[] = droppedFileRoots()): { path: string } | { error: string; status: number } {
  let path: string;
  try {
    path = input.startsWith("file:") ? fileURLToPath(input) : input;
  } catch {
    return { error: "That is not a file address.", status: 400 };
  }
  if (!isAbsolute(path)) return { error: "That is not a file address.", status: 400 };
  let real: string;
  try {
    real = realpathSync(normalize(path));
  } catch {
    return { error: "That file is not there any more.", status: 404 };
  }
  const realRoots = roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  if (!realRoots.some((r) => inside(real, r))) return { error: "Only files in your home folder or on a mounted drive can be added this way.", status: 403 };
  if (!statSync(real).isFile()) return { error: "That is a folder, not a file.", status: 400 };
  return { path: real };
}

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".doc": "application/msword",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".epub": "application/epub+zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export function serveDroppedFile(res: ServerResponse, path: string, origin?: string): void {
  const size = statSync(path).size;
  res.statusCode = 200;
  res.setHeader("content-type", TYPES[extname(path).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("content-length", String(size));
  res.setHeader("x-file-name", encodeURIComponent(basename(path)));
  res.setHeader("vary", "Origin");
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-expose-headers", "x-file-name");
  }
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
}
