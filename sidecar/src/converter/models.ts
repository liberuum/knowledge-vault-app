import { spawn } from "node:child_process";
import { RM_RETRY } from "../fs-retry.js";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The PDF models (~700 MB): the vendored `fetch-models.mjs` run as a child with
 * `DOCLING_RS_HOME` in app-data. It fetches upstream's download script and
 * runs it; the sidecar pins the script's sha256 so a changed upstream fails
 * closed instead of running unseen. The script needs `curl`, `sh` and `tar`; on Windows the fetcher
 * downloads in Node instead (converter/fetch-node.mjs) and needs none of them.
 * Its final step imports `docling.rs` to verify the models — hence the hook
 * and the binding first.
 */
/**
 * The download script of the binding's own version (v1.58.0), not master: the
 * 1.100 line's script no longer fetches pdfium, which the 1.58 binding needs —
 * verified the hard way (720 MB fetched, `missing: ["pdfium"]`). Both the URL
 * and the hash are pinned; a changed script fails closed.
 */
export const DOWNLOAD_SCRIPT_URL = "https://raw.githubusercontent.com/docling-project/docling.rs/v1.58.0/scripts/install/download_dependencies.sh";
export const DOWNLOAD_SCRIPT_SHA256 = "a56bd5ee5039f3bffae5adb58d7c9f6d18261ecb1db04d2c807865147613e963";

export type ModelsProgress = { file: string | null; bytes: number; lines: string[] };

/**
 * Installed means the fetcher's own verification passed (it writes nothing of
 * its own, so this module leaves a marker) and the layout model every PDF
 * needs is still there. Files alone are not enough: a partial set reports
 * `ready: false` from the binding — the 720 MB without pdfium taught that.
 */
export function modelsInstalled(modelsDir: string): boolean {
  return existsSync(join(modelsDir, "models.json")) && existsSync(join(modelsDir, ".models", "layout_heron.onnx"));
}

export function removeModels(modelsDir: string): void {
  rmSync(modelsDir, { recursive: true, force: true, ...RM_RETRY });
}

export function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else total += st.size;
      } catch {
        // removed meanwhile
      }
    }
  };
  walk(dir);
  return total;
}

/** `  > <file>` lines name the asset being fetched; `  = <file> (already present)` is skipped. */
export function parseFetchLine(line: string): { file: string } | null {
  const m = /^\s{2}>\s+(\S.*?)\s*$/.exec(line);
  return m ? { file: m[1]! } : null;
}

export type InstallModelsOptions = {
  modelsDir: string;
  /** The vendored fetch-models.mjs. */
  script: string;
  hooks: string;
  modulesDir: string;
  nodePath: string;
  env: Record<string, string>;
  scriptSha256?: string;
  scriptUrl?: string;
  spawn?: typeof spawn;
  onProgress?: (progress: ModelsProgress) => void;
  pollMs?: number;
};

export function installModels(opts: InstallModelsOptions): Promise<void> {
  mkdirSync(opts.modelsDir, { recursive: true });
  const spawnImpl = opts.spawn ?? spawn;
  const progress = opts.onProgress ?? (() => {});
  return new Promise((resolve, reject) => {
    const child = spawnImpl(opts.nodePath, ["--import", opts.hooks, opts.script], {
      env: {
        ...opts.env,
        DOCLING_RS_HOME: opts.modelsDir,
        CONVERTER_MODULES_DIR: opts.modulesDir,
        DOCLING_DOWNLOAD_SCRIPT_SHA256: opts.scriptSha256 ?? DOWNLOAD_SCRIPT_SHA256,
        DOCLING_DOWNLOAD_SCRIPT_URL: opts.scriptUrl ?? DOWNLOAD_SCRIPT_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let file: string | null = null;
    const report = (): void => progress({ file, bytes: dirBytes(opts.modelsDir), lines: lines.slice(-20) });
    const onLine = (line: string): void => {
      if (!line.trim()) return;
      lines.push(line);
      if (lines.length > 200) lines.shift();
      const parsed = parseFetchLine(line);
      if (parsed) file = parsed.file;
      report();
    };
    let buffer = "";
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) onLine(part);
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    const timer = setInterval(report, opts.pollMs ?? 1_000);
    child.on("error", (error) => {
      clearInterval(timer);
      reject(new Error(`could not run the model fetcher: ${error.message}`));
    });
    child.on("close", (code) => {
      clearInterval(timer);
      if (buffer) onLine(buffer);
      if (code === 0 && existsSync(join(opts.modelsDir, ".models", "layout_heron.onnx"))) {
        writeFileSync(join(opts.modelsDir, "models.json"), JSON.stringify({ installedAt: new Date().toISOString(), script: opts.scriptUrl ?? DOWNLOAD_SCRIPT_URL, bytes: dirBytes(opts.modelsDir) }, null, 2) + "\n");
        report();
        resolve();
        return;
      }
      const tail = lines.slice(-6).join("\n");
      reject(new Error(code === 0 ? `the fetcher finished but the layout model is missing\n${tail}` : `the model fetcher exited with code ${code ?? "null"}\n${tail}`));
    });
  });
}
