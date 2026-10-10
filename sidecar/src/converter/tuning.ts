import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * How the converter may use this computer.
 *
 * Left to itself, docling.rs sizes itself to the whole machine: page workers on every core (two
 * threads each) plus a TableFormer pool as wide as the CPU again, so one PDF pins every core and the
 * computer stops answering while it converts. The extra threads buy nothing: TableFormer decodes the
 * tables one at a time, through one shared session, and that queue is what a PDF with tables waits
 * on. Measured with docling.rs 1.58.0 on a 16-core x86 (a 144-page paper with 21 tables):
 *
 * - all cores, the stock decoder (before): 114 s; on a 48-page slice 42 s and ~250 CPU-seconds;
 * - half the cores, two TableFormer threads, the KV-cache decoder: 66 s; the slice 22 s and ~105
 *   CPU-seconds, with byte-identical Markdown. Four or eight threads made no difference to the time.
 *
 * - The KV-cache decoder ships in the models download; the Node wrapper pins the older decoder, and
 *   an explicit path wins over its pin. It halves TableFormer, the step every page with a table waits on.
 * - Without ONNX Runtime's memory arena the helper gives memory back after a conversion (held after the
 *   slice: 3.9 GB → 1.2 GB) at the same speed; upstream's own server and CLI run this way.
 * - The graph cache keeps the optimised model graphs between runs. docling.rs puts it under $HOME, which
 *   Windows does not set, so there it was off; here it lives with the converter.
 * - The service's OCR (ocrmypdf --jobs) gets the same thread budget.
 */

/** Below-normal: work the person is doing comes first. `nice -n 10` on macOS and Linux, BELOW_NORMAL on Windows. */
export const CONVERTER_NICE = 10;

/** Threads docling.rs may use for one PDF: half the cores, so the other half stays free for the person; 1–8. */
export function converterThreads(cores: number): number {
  return Math.max(1, Math.min(8, Math.floor(cores / 2)));
}

/** The environment the helper starts with, beyond the OS allowlist. Recomputed at every start: models may arrive later. */
export function converterTuning(opts: { cores: number; modelsDir: string; cacheDir: string; exists?: (path: string) => boolean }): Record<string, string> {
  const exists = opts.exists ?? existsSync;
  const threads = converterThreads(opts.cores);
  const env: Record<string, string> = {
    DOCLING_RS_PDF_THREADS: String(threads),
    DOCLING_RS_TF_INTRA: String(Math.min(2, threads)),
    DOCLING_RS_NO_ARENA: "1",
    DOCLING_RS_GRAPH_CACHE_DIR: opts.cacheDir,
    CONVERT_OCR_JOBS: String(threads),
  };
  const kv = join(opts.modelsDir, ".models", "tableformer", "decoder_kv.onnx");
  if (exists(kv) && exists(`${kv}.data`)) env.DOCLING_TABLEFORMER_DECODER = kv;
  return env;
}

/**
 * How to start the helper at background priority. On macOS and Linux through `nice`, so the process and
 * every thread it creates start niced (Linux keeps nice per thread: renicing a running process misses the
 * threads it already has, and their children). Where there is no `nice` — Windows, an unusual Linux —
 * the caller lowers the priority right after the spawn; on Windows that sets the class for all threads.
 */
export function lowPriorityLaunch(
  platform: NodeJS.Platform,
  cmd: string,
  args: string[],
  exists: (path: string) => boolean = existsSync,
): { cmd: string; args: string[]; reniceAfterSpawn: boolean } {
  if (platform !== "win32") {
    const nice = ["/usr/bin/nice", "/bin/nice"].find((p) => exists(p));
    if (nice) return { cmd: nice, args: ["-n", String(CONVERTER_NICE), cmd, ...args], reniceAfterSpawn: false };
  }
  return { cmd, args, reniceAfterSpawn: true };
}
