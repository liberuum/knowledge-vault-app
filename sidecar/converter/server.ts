/**
 * A local document-conversion service over `docling.rs`.
 *
 * The vault talks to this over HTTP (`CONVERT_SERVICE_URL`) through the
 * `subgraphs/convert` proxy. It is deliberately its own process: the binding
 * keeps hundreds of megabytes of ONNX weights resident once it has converted a
 * PDF, and the Switchboard should not carry that.
 *
 * Design points that come from measurement, not taste:
 *
 * - **It starts instantly and loads nothing.** The process started is a
 *   coordinator: HTTP, slots, progress, the upload on disk. Each conversion runs
 *   in a worker process (this same file, `CONVERT_ROLE=worker`), started on
 *   demand, which imports the native binding and creates the warm `Pipeline` —
 *   the ONNX models — only when a PDF or image arrives. A process that has
 *   served no documents costs no model memory.
 * - **A worker can be stopped.** docling.rs has no abort; a process can be
 *   ended. `DELETE /convert/:id`, or a caller that disconnects, ends the worker
 *   (and the OCR/ghostscript helpers in its process group) and frees its slot.
 *   A crash or out-of-memory takes down one worker, not the service.
 * - **Two lanes.** PDFs and images (`models`) run one at a time by default —
 *   measured fastest on one machine's CPU budget, since a conversion already
 *   spreads its pages over every thread it has; everything else (`other`) runs
 *   alongside, so a quick `.docx` never waits behind a long PDF.
 * - **The warm `Pipeline` serves `pdf` and `image` only.** Its own typings say
 *   so; every declarative format (`md`, `html`, `docx`, `csv`, `epub`, …) goes
 *   through the per-call functions and needs no models at all. That is what
 *   makes "conversion works before the 700 MB is fetched" true rather than
 *   aspirational.
 * - **A document is converted once.** One pass to docling JSON; the Markdown is
 *   rendered from it (`json_docling`, no models) and the chunks chunked from it
 *   (`chunkDocumentAsync`), and the figures are cut from it — byte-identical
 *   Markdown and identical chunks to the three passes this replaced, in a third
 *   of the time (see `convertOnce`).
 * - Model files are ~750 MB and are *not* fetched here at start-up. See
 *   `fetch-models.mjs`, and `/health`, which reports `ready: false` and the
 *   missing list until they exist.
 *
 * Cache hygiene, since "where does the scratch go?" is a fair question:
 *
 * - Per-request scratch (the uploaded bytes, and any qpdf/gs rewrite) lives in
 *   a `mkdtemp` dir removed in a `finally`, so it is gone on the error path
 *   too. Measured after a conversion: zero dirs left behind.
 * - `DOCLING_RS_HOME` is *not* a cache: a conversion writes nothing into it.
 *   The 707 MB there is the models, downloaded once on purpose.
 * - Leftovers therefore only come from a hard kill (`SIGKILL` skips `finally`),
 *   which `sweepStaleTempDirs()` clears at start-up.
 * - **Do not switch on `imageMode: "referenced"`** without cleaning up after
 *   it: that mode writes image files into `artifactsDir`, and nothing here
 *   removes those. `ConvertResult.images` is empty in the current calls, which
 *   is why no artifact cleanup exists.
 * - The one thing that cannot be freed per extraction is a worker's warm
 *   models (~1.2 GB) — that warmth is what avoids reloading them per request.
 *   `CONVERT_IDLE_RELEASE_MS` stops an idle worker, which gives it all back.
 *
 * Runs on Node and Bun: `node:http` and `node:child_process` are both
 * implemented by Bun, and Node is what Vetra deploys the vault with.
 */
import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as DoclingRs from "docling.rs";
import type { Chunk, Pipeline } from "docling.rs";
import {
  decideRoute,
  DOCLING_OCR_SECONDS_PER_PAGE,
  looksGarbled,
  type OcrCapabilities,
} from "./routing.mjs";
import { conversionQuality, type ConversionQuality } from "./quality.mjs";
import { restorePlaceholders } from "./docjson.mjs";
import {
  documentToBlocks,
  insertFigurePlaceholders,
  renderPages,
  runFromItem,
  spliceTables,
  type PageBlocks,
  type Run,
} from "./textlayer.mjs";
import { detectTables, renderTable } from "./tables.mjs";
import {
  altFor,
  applyBudget,
  DEFAULT_MAX_FIGURE_BYTES,
  formulaRegions,
  interiorRows,
  pictureFigures,
  toPixels,
  type Figure,
} from "./figures.mjs";

const PORT = Number(
  process.env.CONVERT_SERVICE_PORT ?? process.env.PORT ?? 5007,
);
const HOST = process.env.CONVERT_SERVICE_HOST ?? "127.0.0.1";

/** `src/server.ts` sits one level below the repository root. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// docling.rs resolves its model home from `DOCLING_RS_HOME` and otherwise falls
// back to the **CWD** — which is wherever the *host* process happened to start,
// so a service autostarted by the vault would look in a different directory from
// the one it was told to. Pin the default to the package root: `<root>/.models`
// is then the same location whether the service is started by hand from the
// repo, from anywhere else, or by the subgraph. An explicit `DOCLING_RS_HOME`
// still wins, which is the knob a real deployment sets (a mounted volume).
process.env.DOCLING_RS_HOME ??= PACKAGE_ROOT;
const MAX_BYTES = Number(process.env.CONVERT_MAX_BYTES ?? 256 * 1024 * 1024);
/**
 * How often to emit a keep-alive byte during a conversion, in ms. 0 disables it.
 *
 * Default 15 s: comfortably inside nginx's 60 s `proxy_read_timeout`, most cloud
 * load balancers' 60 s, and Cloudflare's ~100 s, so the tightest common hop
 * still sees traffic long before it gives up. See `startHeartbeat`.
 */
const HEARTBEAT_MS = Number(process.env.CONVERT_HEARTBEAT_MS ?? 15_000);

/** Prefix for this service's per-request scratch dirs, so it can find its own. */
const TMP_PREFIX = "vault-convert-";

/**
 * How old a scratch dir must be before startup will delete it.
 *
 * Generous on purpose: two services can share one temp dir, and a dir younger
 * than this may belong to a conversion in flight right now.
 */
const STALE_TMP_MS = Number(
  process.env.CONVERT_TMP_STALE_MS ?? 6 * 60 * 60_000,
);

/**
 * Stop a worker after this long with no conversion, giving its memory back to
 * the system — its warm models among it. `0` = never.
 *
 * Off by default, because warmth is the whole point: the models cost ~1.2 GB
 * resident but a reload per request costs seconds. Turn it on where memory
 * matters more than latency (the desktop app does). Stopping the process is
 * what frees native memory for certain; dropping a reference left it to GC.
 */
const IDLE_RELEASE_MS = Number(process.env.CONVERT_IDLE_RELEASE_MS ?? 0);

/**
 * How many conversions run at once, per lane. A document that needs the models
 * (PDF, image) goes to the `models` lane; everything else (Office, HTML,
 * Markdown, …) to `other`, so a quick file never waits behind a long PDF.
 *
 * One model conversion at a time by default — measured: 12 PDFs (144 pages) on
 * one 8-thread budget took 78.7 s one at a time, and 84.6 / 75.2 / 85.9 s with
 * 2 / 3 / 4 at once, each file 2–2.5× slower and 0.5–0.9 GB more at peak. A
 * conversion already uses every thread it is given across its pages, so more
 * at once only splits the same CPU. A bigger server may still want two.
 */
const MODEL_SLOTS = boundedInt(process.env.CONVERT_MODEL_SLOTS, 1, 1, 16);
const OTHER_SLOTS = boundedInt(process.env.CONVERT_OTHER_SLOTS, 2, 1, 16);

/**
 * The PDF thread budget (docling.rs reads `DOCLING_RS_PDF_THREADS`; all cores
 * when unset). With several model slots it is split between them, so N at once
 * never take N times the CPU.
 */
const PDF_THREAD_BUDGET = boundedInt(
  process.env.DOCLING_RS_PDF_THREADS,
  availableParallelism(),
  1,
  1024,
);

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value))
    return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Format ids that cannot be converted without the downloaded models. */
const MODEL_BACKED_FORMATS = new Set(["pdf", "image", "mets_gbs"]);

// --- binding, resolved on demand -------------------------------------------

/**
 * `CONVERT_DISABLE_BINDING=1` runs the service as if `docling.rs` were not
 * installed — the desktop app's fresh-install state — on a machine that has
 * it, so that path stays under test and can be diagnosed.
 */
const BINDING_DISABLED = /^(1|true|yes|on)$/i.test(
  (process.env.CONVERT_DISABLE_BINDING ?? "").trim(),
);

/** Import the native binding once, on first use — not at start-up. */
const load = (): Promise<typeof DoclingRs> =>
  BINDING_DISABLED
    ? Promise.reject(new Error("CONVERT_DISABLE_BINDING is set"))
    : import("docling.rs");

let binding: ReturnType<typeof load> | null = null;

function docling(): ReturnType<typeof load> {
  binding ??= load();
  return binding;
}

/**
 * Whether the binding loads, probed once at first need. A binding installed
 * while the service runs is seen after a restart — whoever installs it (the
 * desktop app) restarts the service.
 */
let bindingProbe: Promise<boolean> | null = null;
function bindingAvailable(): Promise<boolean> {
  bindingProbe ??= docling().then(
    () => true,
    () => false,
  );
  return bindingProbe;
}

/**
 * What the service reads with no binding installed: the pdf.js text layer,
 * and text that already is text. Everything else needs `docling.rs`.
 */
const NO_BINDING_FORMATS = ["pdf", "md", "markdown", "txt"] as const;

function formatWithoutBinding(filename: string): "pdf" | "md" | "txt" | null {
  const ext = extname(filename).slice(1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "txt" || ext === "text") return "txt";
  return null;
}

/** Long sections split at paragraph boundaries around this many characters. */
const LOCAL_CHUNK_CHARS = 1200;

/**
 * docling's chunker without docling: one chunk per heading section (ATX
 * headings), long sections split at paragraph boundaries, each chunk carrying
 * its heading path — the shape `subgraphs/convert/lib/sections.ts` cuts
 * sections from. `docItems` has nothing to point at and stays empty.
 */
function localChunks(markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  const path: string[] = [];
  let buffer: string[] = [];
  let inCode = false;
  const flush = (): void => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (!text) return;
    for (const piece of splitAtParagraphs(text, LOCAL_CHUNK_CHARS)) {
      chunks.push({
        text: piece,
        ...(path.length > 0 ? { headings: [...path] } : {}),
        docItems: [],
        contextualized: [...path, piece].join("\n"),
      });
    }
  };
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inCode = !inCode;
    const heading = inCode ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const depth = heading[1].length;
      path.length = Math.min(path.length, depth - 1);
      path.push(heading[2]);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

function splitAtParagraphs(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    if (current && current.length + paragraph.length + 2 > max) {
      out.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) out.push(current);
  return out;
}

let warmPipeline: Pipeline | null = null;

/**
 * The warm pipeline, for `pdf` / `image` only.
 *
 * `Pipeline` rejects anything else: it exists to keep the ONNX models loaded
 * across calls, and declarative formats have no models to keep.
 */
function pipelineFor(PipelineClass: typeof Pipeline): Pipeline {
  warmPipeline ??= new PipelineClass();
  return warmPipeline;
}

/**
 * Delete leftover scratch dirs from a previous run.
 *
 * The per-request dir is removed in a `finally`, so this is only for the cases
 * that skip it: `SIGKILL`, a crash, or the machine going down mid-conversion.
 * Measured after a normal conversion: zero dirs left, which is why this is a
 * safety net rather than routine cleanup.
 *
 * Only entries with this service's prefix, and only ones older than
 * `STALE_TMP_MS`, so a conversion running right now is never deleted.
 */
async function sweepStaleTempDirs(): Promise<number> {
  const root = tmpdir();
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(TMP_PREFIX)) continue;
    const path = join(root, entry);
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs < STALE_TMP_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Raced with another process, or not ours to remove. Not worth failing over.
    }
  }
  return removed;
}

// --- helpers ----------------------------------------------------------------

function runtimeName(): string {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return bun ? `bun ${bun.version}` : `node ${process.version}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // A heartbeat may already have opened the response to keep a proxy from
  // timing the connection out (see `startHeartbeat`). Once headers are on the
  // wire the status is fixed at 200, so the outcome has to travel in the body:
  // `deferredStatus` carries the code this would have been. Every existing
  // error path funnels through here, so they all keep working unchanged.
  const payload = JSON.stringify(
    res.headersSent && status >= 400 && body && typeof body === "object"
      ? { ...(body as Record<string, unknown>), deferredStatus: status }
      : body,
  );
  if (res.headersSent) {
    res.end(payload);
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Keep a slow conversion's connection from being culled by an idle timeout.
 *
 * A 238-page book takes minutes, and the client allows 30 of them — but nginx's
 * `proxy_read_timeout` defaults to 60 s, most cloud load balancers to 60, and
 * Cloudflare to ~100. Whichever hop is tightest cuts the connection first, and
 * the client sees a network error rather than anything about the document.
 *
 * Proxies reset that timer on **any** byte from upstream, so this writes a
 * single space at intervals. JSON ignores leading whitespace, so a client that
 * calls `response.json()` parses the eventual body unchanged and needs no
 * knowledge of this at all.
 *
 * The cost is honest and worth stating: the first heartbeat commits the status
 * to 200, so an error *after* that point cannot be a 4xx/5xx. `sendJson` puts
 * the real code in `deferredStatus` instead. Errors that arrive before the
 * first interval — the overwhelming majority, since bad input is rejected in
 * milliseconds — are unaffected.
 *
 * Set `CONVERT_HEARTBEAT_MS=0` to switch it off where no proxy sits in front.
 */
function startHeartbeat(res: ServerResponse, intervalMs: number) {
  if (intervalMs <= 0) return { stop: () => {} };

  const timer = setInterval(() => {
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "application/json",
        // No content-length: the body is now chunked, since its size is not
        // known until the conversion that is still running finishes.
        "cache-control": "no-store",
      });
    }
    res.write(" ");
  }, intervalMs);
  // Do not hold the process open for a heartbeat.
  timer.unref();

  return { stop: () => clearInterval(timer) };
}

/** Run a helper binary, resolving to whether it succeeded. */
function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false)); // binary absent
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * The rewrites to try, in order, when the parser refuses a PDF.
 *
 * `qpdf --linearize` first because it is lossless and fast, `gs` second because
 * it rebuilds the page tree wholesale — which is the only thing that helps for
 * some malformations.
 */
const REWRITERS = [
  {
    tool: "qpdf" as const,
    args: (src: string, dst: string) => ["--linearize", src, dst],
  },
  {
    tool: "gs" as const,
    args: (src: string, dst: string) => [
      "-q",
      "-dNOPAUSE",
      "-dBATCH",
      "-sDEVICE=pdfwrite",
      `-sOutputFile=${dst}`,
      src,
    ],
  },
];

/**
 * The parser refused the file. docling.rs 1.x read PDFs with pdfium
 * (`PdfiumLibraryInternalError(FormatError|Unknown)`); 2.x reads them itself and
 * says `pdf: not a readable PDF: the file is damaged or not a PDF …`. Either
 * way the file may still be rescued by a rewrite.
 */
const isFormatError = (error: unknown): boolean =>
  /FormatError|pdfium|not a readable PDF/i.test(
    error instanceof Error ? error.message : String(error),
  );

// --- conversion -------------------------------------------------------------

interface Conversion {
  markdown: string;
  chunks: Chunk[];
  format: string;
  inputName: string;
  timings: { convertMs: number; chunkMs: number };
  /**
   * The docling JSON the Markdown and chunks were derived from, when a model
   * conversion produced them: the figures are cut from the same document, so
   * their placeholder indices are the Markdown's. `null` for text-layer and
   * declarative conversions.
   */
  json: string | null;
}

/**
 * Markdown and chunks from a docling JSON document, without the models: the
 * render is a declarative conversion (milliseconds) and the chunker reads the
 * document it is given. Chunking our own JSON gives the same chunks as
 * `chunkFileAsync` re-converting the file — measured identical on four PDFs
 * (1, 1, 1 and 439 chunks) with 2.13 and on 434 chunks with 1.58; the table
 * disagreement once seen came from comparing two separate conversions.
 */
async function conversionFromJson(
  library: typeof DoclingRs,
  json: string,
  meta: { format: string; inputName: string; convertMs: number },
): Promise<Conversion> {
  const chunkStart = Date.now();
  const [rendered, chunks] = await Promise.all([
    library.convertAsync(
      { name: "document.json", data: Buffer.from(json), format: "json_docling" },
      { to: "markdown" },
    ),
    library.chunkDocumentAsync(json),
  ]);
  return {
    // The render escapes docling's placeholder comments (docjson.mjs); 1.58
    // also escapes one URL's underscores, which nothing reads.
    markdown: restorePlaceholders(rendered.content),
    chunks,
    format: meta.format,
    inputName: meta.inputName,
    timings: { convertMs: meta.convertMs, chunkMs: Date.now() - chunkStart },
    json,
  };
}

/**
 * The OCR path, for a PDF whose text layer exists but lies.
 *
 * One OCR conversion to docling JSON; the Markdown, the chunks and the figures
 * all come from it (`conversionFromJson`). It used to OCR the whole document
 * twice — once for the Markdown, once for the chunks.
 *
 * The module-level `convertFileAsync`, not the warm pipeline: up to docling.rs
 * 1.71 `Pipeline` ignored `forceFullPageOcr` entirely (measured on a 19-page
 * document: 94.0 % single-character tokens either way, against 1.5 % here), and
 * this path is rare enough that a model load per call costs nothing that matters.
 */
async function convertWithOcr(file: string): Promise<Conversion> {
  const library = await docling();
  const convertStart = Date.now();
  const asJson = await library.convertFileAsync(file, {
    to: "json",
    forceFullPageOcr: true,
  });
  return conversionFromJson(library, asJson.content, {
    format: extname(file).slice(1).toLowerCase() || "pdf",
    inputName: basename(file),
    convertMs: Date.now() - convertStart,
  });
}

// --- progress: what the caller can watch while it waits ------------------------

type Phase =
  | "starting"
  | "reading"
  | "structuring"
  | "text-layer"
  | "ocr"
  | "figures"
  | "done"
  | "failed"
  | "cancelled";

/**
 * One entry per in-flight conversion (`?job=<id>`, or an id the service picks).
 * `pages` is the document's page count once pdf.js has read it. A model
 * conversion is one pass to docling JSON, which reports nothing until it is
 * done, so `reading` carries no page count of its own — `pagesDone` stays 0 and
 * a client shows the phase and the time it has taken, never a guessed share.
 * (It used to stream Markdown page by page, at the cost of two more passes.)
 * `figures` counts formulas located. Entries linger a minute after completion
 * so a late poll still gets the final state.
 */
interface JobProgress {
  phase: Phase;
  pages: number | null;
  pagesDone: number;
  startedAt: number;
  finishedAt: number | null;
}
const jobs = new Map<string, JobProgress>();
const JOB_TTL_MS = 60_000;

function startJob(id: string | null): JobProgress | null {
  if (!id || !/^[\w-]{1,80}$/.test(id)) return null;
  const job: JobProgress = {
    phase: "starting",
    pages: null,
    pagesDone: 0,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}
function finishJob(
  id: string | null,
  job: JobProgress | null,
  phase: "done" | "failed" | "cancelled",
): void {
  if (!id || !job) return;
  job.phase = phase;
  job.finishedAt = Date.now();
  setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref();
}

interface ProgressHooks {
  onPhase?: (phase: Phase) => void;
  onPage?: (pagesDone: number) => void;
}

/**
 * One conversion: the Markdown for the source's own content, the chunks the
 * vault turns into sections, and — for PDFs and images — the docling JSON the
 * figures are cut from.
 *
 * A model-backed document (PDF, image) is converted **once**, to docling JSON,
 * on the warm pipeline; the Markdown and the chunks are derived from that
 * (`conversionFromJson`), and the figures reuse it. It used to be converted
 * three times — streamed Markdown, then `chunkFileAsync` re-converting the file
 * (and, being a one-shot call, reloading every model), then JSON for the
 * figures. Measured on a 48-page paper: 25 s for the JSON pass, 35 ms for the
 * Markdown render and 159 ms for the chunks, against ~75 s for the three passes,
 * with byte-identical Markdown and identical chunks.
 *
 * A declarative format (Office, HTML, Markdown, …) needs no models and takes
 * milliseconds, so it keeps the direct path: Markdown and chunks from the file.
 */
async function convertOnce(
  file: string,
  usePipeline: boolean,
  progress: ProgressHooks = {},
): Promise<Conversion> {
  const library = await docling();
  progress.onPhase?.("reading");
  const convertStart = Date.now();
  if (!usePipeline) {
    const converted = await library.convertFileAsync(file, { to: "markdown" });
    const convertMs = Date.now() - convertStart;
    progress.onPhase?.("structuring");
    const chunkStart = Date.now();
    const chunks = await library.chunkFileAsync(file);
    return {
      markdown: converted.content,
      chunks,
      format: converted.format,
      inputName: converted.inputName,
      timings: { convertMs, chunkMs: Date.now() - chunkStart },
      json: null,
    };
  }
  const asJson = await pipelineFor(library.Pipeline).convertFileAsync(file, {
    to: "json",
  });
  progress.onPhase?.("structuring");
  return conversionFromJson(library, asJson.content, {
    format: extname(file).slice(1).toLowerCase() || "pdf",
    inputName: basename(file),
    convertMs: Date.now() - convertStart,
  });
}

// --- what this machine can do ------------------------------------------------

/** Run `cmd --version`; true when it exists and exits 0. */
function probeBinary(
  command: string,
  args: string[] = ["--version"],
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

type Capabilities = Omit<OcrCapabilities, "doclingOcr"> & {
  qpdf: boolean;
  gs: boolean;
  /** `sharp` (npm) loads: formula crops need it, together with `gs`. */
  sharp: boolean;
  nice: boolean;
  /** `DOCLING_RS_EP` when a GPU build is in use; the stock binding is CPU-only. */
  executionProvider: string;
};

let probed: Promise<Capabilities> | null = null;

/**
 * Detected once, at first need, and reported through `/health` — the service
 * installs nothing. Tesseract makes a scan fast; without it docling's own OCR
 * is slow but present wherever the models are; without either a scan is
 * `unreadable`, and the response says which tool would change that.
 */
function capabilities(): Promise<Capabilities> {
  probed ??= (async () => {
    const [tesseract, ocrmypdf, qpdf, gs, nice, sharp] = await Promise.all([
      probeBinary("tesseract"),
      probeBinary("ocrmypdf"),
      probeBinary("qpdf"),
      probeBinary("gs"),
      process.platform === "win32"
        ? Promise.resolve(false)
        : probeBinary("nice"),
      import("sharp").then(
        () => true,
        () => false,
      ),
    ]);
    return {
      tesseract,
      ocrmypdf,
      qpdf,
      gs,
      sharp,
      nice,
      executionProvider: process.env.DOCLING_RS_EP ?? "cpu",
    };
  })();
  return probed;
}

/** OCR runs in parallel across this many pages; bounded so it never takes the whole box. */
const OCR_JOBS = Math.max(
  1,
  Math.min(cpus().length, Number(process.env.CONVERT_OCR_JOBS ?? 8)),
);
/** Above this estimated cost, OCR is offered rather than run — the user decides. */
const AUTO_OCR_BUDGET_SECONDS = Number(
  process.env.CONVERT_AUTO_OCR_SECONDS ?? 60,
);
const OCR_LANG = process.env.CONVERT_OCR_LANG ?? "eng";

/** Run a helper with lower scheduling priority when `nice` exists, capturing stderr for the error path. */
function runNiced(
  command: string,
  args: string[],
  canNice: boolean,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = canNice
      ? spawn("nice", ["-n", "10", command, ...args], {
          stdio: ["ignore", "ignore", "pipe"],
        })
      : spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", (error) => resolve({ ok: false, stderr: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stderr }));
  });
}

// --- the text layer, read by pdf.js -------------------------------------------

/**
 * pdf.js reads fonts docling's reader could not: measured on a report re-exported with
 * Type 3 fonts under custom encodings, docling.rs 1.x (pdfium) returned 96 % single-character
 * tokens and pdf.js 1.2 %, in 0.4 s for 19 pages. Pure npm, so this rung exists
 * on every machine the service runs on. It yields text, not layout.
 */
async function extractTextWithPdfjs(bytes: Uint8Array): Promise<{
  text: string;
  markdown: string;
  pages: number;
  headings: number;
  blocks: PageBlocks[];
}> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const pages: Run[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const runs: Run[] = [];
    for (const item of content.items)
      if ("str" in item) runs.push(runFromItem(item));
    pages.push(runs);
  }
  const count = doc.numPages;
  await task.destroy();
  // `text` is the flat layer (garble check, coverage); `markdown` has the
  // headings and paragraphs the geometry gives away — see textlayer.mjs.
  // Blocks first, then the tables that cover some of them: a table's cells
  // arrive as ordinary blocks, so the grid has to take their place or every
  // number is written twice (see tables.mjs).
  const blocks = documentToBlocks(pages).pages.map((page, index) => ({
    ...page,
    blocks: spliceTables(
      page.blocks,
      detectTables(pages[index]).map((table) => ({
        ...table,
        markdown: renderTable(table.grid),
      })),
    ),
  }));
  const markdown = renderPages(blocks);
  const flat = pages
    .map((runs) =>
      runs
        .map((r) => r.str + (r.eol ? "\n" : " "))
        .join("")
        .trim(),
    )
    .join("\n\n");
  return {
    text: flat,
    markdown,
    pages: count,
    headings: (markdown.match(/^#{1,2} /gm) ?? []).length,
    // The same blocks, so a figure can be placed among them when this rung's
    // markdown is the one that ships.
    blocks,
  };
}

/**
 * OCR'd text comes back with doubled spaces between words ("Total  stablecoin
 * supply"); collapse them in prose only — table rows, indented and fenced code
 * keep theirs.
 */
function tidyOcrSpacing(markdown: string): string {
  let inCode = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("```")) inCode = !inCode;
      if (inCode || line.startsWith("|") || line.startsWith("    "))
        return line;
      return line.replace(/(\S) {2,}(?=\S)/g, "$1 ");
    })
    .join("\n");
}

/** A conversion built from plain text: the text is the markdown, chunked by docling — or locally, without the binding. */
async function conversionFromText(
  text: string,
  dir: string,
  inputName: string,
): Promise<Conversion> {
  const chunkStart = Date.now();
  let chunks: Chunk[];
  if (await bindingAvailable()) {
    const library = await docling();
    const path = join(dir, "text-layer.md");
    await writeFile(path, text);
    chunks = await library.chunkFileAsync(path);
  } else {
    chunks = localChunks(text);
  }
  return {
    markdown: text,
    chunks,
    format: "pdf",
    inputName,
    timings: { convertMs: 0, chunkMs: Date.now() - chunkStart },
    json: null,
  };
}

/**
 * Tesseract, through ocrmypdf: writes a PDF with a real text layer, which
 * docling then reads with its normal pass — headings, tables and the section
 * rule keep working, which the pdf.js rung cannot offer. `--skip-text` OCRs
 * only pages without text; `--force-ocr` replaces a text layer that lies.
 */
async function ocrWithTesseract(
  file: string,
  dir: string,
  mode: "skip-text" | "force-ocr",
  canNice: boolean,
): Promise<{ path: string } | { error: string }> {
  const out = join(dir, "tesseract.pdf");
  const args = [
    `--${mode}`,
    "--jobs",
    String(OCR_JOBS),
    "--output-type",
    "pdf",
    "-l",
    OCR_LANG,
    file,
    out,
  ];
  const { ok, stderr } = await runNiced("ocrmypdf", args, canNice);
  return ok
    ? { path: out }
    : {
        error:
          stderr.trim().split("\n").slice(-3).join(" ") || "ocrmypdf failed",
      };
}

/** Above this many base64 bytes of figures per file, formulas are dropped first, then pictures. */
const MAX_FIGURE_BYTES = Number(
  process.env.CONVERT_FIGURES_MAX_BYTES ?? DEFAULT_MAX_FIGURE_BYTES,
);
/**
 * Resolution of the page renders figures are cut from, per kind.
 *
 * A picture is page-sized, so the PDF's own 72 dpi already gives a sharp crop
 * (the Sky report's charts come out ~1300 px wide). A display formula is one
 * line tall: at 72 dpi it is ~240×34 px and its superscripts are mush, which
 * defeats the point — the crop exists to be read, by a person or a vision
 * model. Rendering costs roughly the square of the resolution (measured on
 * the 19-page Sky report: 6.7 s at 72 dpi, 24.7 s at 200), so each page is
 * rendered at what the figures on it need, and no page twice at one setting.
 */
const FIGURE_TARGET_PX = Math.max(
  200,
  Number(process.env.CONVERT_FIGURE_TARGET_PX ?? 900),
);
/** An embed at least this wide is accepted as is — rendering its page buys little. */
/**
 * How figure PNGs are written. Charts, diagrams and formula crops are flat
 * colour on white, so a 256-colour palette is visually identical and a
 * fraction of the bytes — these live in the attachment store and travel to
 * every reader, human or model.
 */
const FIGURE_PNG = {
  compressionLevel: 9,
  palette: true,
  colours: Math.max(2, Number(process.env.CONVERT_FIGURE_COLOURS ?? 128)),
  quality: Math.max(10, Number(process.env.CONVERT_FIGURE_PNG_QUALITY ?? 80)),
  effort: 8,
} as const;

/** Pictures never need the high end: they are read whole, not glyph by glyph. */
const FIGURE_MAX_PICTURE_DPI = Math.max(
  36,
  Number(process.env.CONVERT_FIGURE_MAX_PICTURE_DPI ?? 150),
);
const FIGURE_EMBED_FLOOR_PX = Math.max(
  200,
  Number(process.env.CONVERT_FIGURE_EMBED_FLOOR_PX ?? 600),
);
const FIGURE_MIN_DPI = Math.max(
  36,
  Number(process.env.CONVERT_FIGURE_MIN_DPI ?? 72),
);
const FIGURE_MAX_DPI = Math.max(
  FIGURE_MIN_DPI,
  Number(process.env.CONVERT_FIGURE_MAX_DPI ?? 200),
);

/**
 * The resolution a figure is rendered at, from its width on the page.
 *
 * Kind is the wrong dial: the Sky report's charts are page-wide and sharp at
 * the PDF's own 72 dpi (~1300 px), while the paper's inline diagrams come out
 * 180 px and its display formulas ~240x34 — mush, which defeats a crop whose
 * purpose is to be read, by a person or a vision model. So each figure asks
 * for about `FIGURE_TARGET_PX` of width, bounded, rounded to a step so
 * near-identical widths share one page render. Rendering costs roughly the
 * square of the resolution (19-page Sky report: 6.7 s at 72 dpi, 24.7 s at 200).
 */
/**
 * Whether docling's own PNG is at least as good as rendering the page would
 * be. It usually is for a designed report (the Sky charts embed at 2655 px)
 * and usually is not for a paper's inline diagrams (683 px for a figure a
 * render gives at 951). Using it skips the page render entirely.
 */
function embedIsEnough(picture: {
  width: number;
  png: string;
  box: { l: number; r: number } | null;
}): boolean {
  if (!picture.png || picture.width <= 0) return false;
  // Readable on its own terms: no page render just to gain pixels nobody reads.
  if (picture.width >= FIGURE_EMBED_FLOOR_PX) return true;
  const widthPt = picture.box ? Math.max(1, picture.box.r - picture.box.l) : 0;
  if (widthPt <= 0) return true; // no box to render from: the embed is all there is
  const renderedWidth = (dpiFor(picture.box, "picture") / 72) * widthPt;
  return picture.width >= renderedWidth * 0.9;
}

function dpiFor(
  box: { l: number; r: number } | null,
  kind: "picture" | "formula" = "formula",
): number {
  const widthPt = box ? Math.max(1, box.r - box.l) : 0;
  const wanted =
    widthPt > 0 ? (FIGURE_TARGET_PX / widthPt) * 72 : FIGURE_MIN_DPI;
  // A formula is read glyph by glyph, so it earns the high end; a picture that
  // is small on the page is a logo or an inline mark, and rendering its whole
  // page at 200 dpi (measured: 16 s across the Sky report) buys nothing.
  const max = kind === "formula" ? FIGURE_MAX_DPI : FIGURE_MAX_PICTURE_DPI;
  const clamped = Math.min(max, Math.max(FIGURE_MIN_DPI, wanted));
  return Math.ceil(clamped / 25) * 25;
}

interface FigureStats {
  pictures: number;
  formulas: number;
  located: number;
  skipped: number;
  droppedForBudget: number;
  /** Figures the text-layer rung could not position among the blocks (no box). */
  unplaced?: number;
  jsonMs: number;
  renderMs: number;
}

/**
 * The pictures and display formulas of a PDF, as PNGs (see figures.mjs).
 * Pictures come embedded in docling's JSON; formulas are located by the gap
 * between their neighbours and cut from a Ghostscript render of the page at
 * a resolution chosen from its size (dpiFor). Degrades: no `gs`/`sharp` → pictures only.
 */
async function collectFigures(
  file: string,
  dir: string,
  usePipeline: boolean,
  hooks: ProgressHooks,
  /** The docling JSON the Markdown came from; converted here only when absent. */
  documentJson: string | null,
): Promise<{ figures: Figure[]; stats: FigureStats }> {
  const jsonStart = Date.now();
  let content = documentJson;
  if (content === null) {
    const library = await docling();
    const warm = usePipeline ? pipelineFor(library.Pipeline) : null;
    content = (
      warm
        ? await warm.convertFileAsync(file, { to: "json" })
        : await library.convertFileAsync(file, { to: "json" })
    ).content;
  }
  const jsonMs = Date.now() - jsonStart;
  const doc = JSON.parse(content) as {
    pages?: Record<string, { size: { width: number; height: number } }>;
  };
  const pageSize = (page: number) => doc.pages?.[String(page)]?.size;

  const pictures = pictureFigures(doc);
  const { regions, total } = formulaRegions(doc);
  const caps = await capabilities();
  const canRender = caps.gs && caps.sharp;

  const figures: Figure[] = [];
  /**
   * Down to `FIGURE_TARGET_PX` wide, when it is wider and sharp is here: a
   * 2655 px chart is 2 MB on the wire and in the attachment store for no gain
   * over ~1000 px, which is what a reader or a vision model uses.
   */
  async function fit(
    base64: string,
    width: number,
    height: number,
  ): Promise<{ base64: string; width: number; height: number }> {
    if (width <= FIGURE_TARGET_PX || !canRender)
      return { base64, width, height };
    try {
      const sharp = (await import("sharp")).default;
      const out = await sharp(Buffer.from(base64, "base64"))
        .resize({ width: FIGURE_TARGET_PX, withoutEnlargement: true })
        .png(FIGURE_PNG)
        .toBuffer({ resolveWithObject: true });
      return {
        base64: out.data.toString("base64"),
        width: out.info.width,
        height: out.info.height,
      };
    } catch {
      return { base64, width, height };
    }
  }

  const embedded = (p: (typeof pictures)[number]): Figure => ({
    id: `picture-${p.placeholderIndex + 1}`,
    kind: "picture",
    page: p.page,
    box: p.box,
    placeholderIndex: p.placeholderIndex,
    alt: altFor({
      kind: "picture",
      page: p.page,
      placeholderIndex: p.placeholderIndex,
      caption: p.caption,
    }),
    mimeType: "image/png",
    width: p.width,
    height: p.height,
    bytesBase64: p.png,
  });

  let renderMs = 0;
  let located = 0;
  if (!canRender) {
    // No Ghostscript or no sharp: docling's own PNGs, formulas stay placeholders.
    for (const p of pictures) figures.push(embedded(p));
  } else {
    const sharp = (await import("sharp")).default;
    const renderStart = Date.now();
    // One render per page that holds a picture with a box or a located formula.
    // (page, dpi) pairs: a page is rendered once per resolution its own
    // figures ask for — small diagrams and formulas pull it up, page-wide
    // charts leave it at the PDF's own 72 dpi.
    const wanted = new Map<string, { page: number; dpi: number }>();
    for (const p of pictures) {
      // docling embeds every picture; render one only when its embed is
      // smaller than we want to read. On a report of page-wide charts that
      // skips the page renders entirely (measured: 19.7 s → 6.8 s).
      if (!p.box || !p.page || embedIsEnough(p)) continue;
      const dpi = dpiFor(p.box, "picture");
      wanted.set(`${p.page}@${dpi}`, { page: p.page, dpi });
    }
    for (const r of regions) {
      const dpi = dpiFor(r.box);
      wanted.set(`${r.page}@${dpi}`, { page: r.page, dpi });
    }
    const rendered = new Map<string, string>();
    for (const { page, dpi } of wanted.values()) {
      const out = join(dir, `page-${page}-${dpi}.png`);
      const ok = await run("gs", [
        "-q",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-sDEVICE=png16m",
        `-r${dpi}`,
        `-dFirstPage=${page}`,
        `-dLastPage=${page}`,
        `-sOutputFile=${out}`,
        file,
      ]);
      if (ok) rendered.set(`${page}@${dpi}`, out);
    }

    // Pictures: docling embeds them at 72 dpi; the page render is 2.8× sharper.
    for (const p of pictures) {
      if (embedIsEnough(p)) {
        const shrunk = await fit(p.png, p.width, p.height);
        figures.push({
          ...embedded(p),
          width: shrunk.width,
          height: shrunk.height,
          bytesBase64: shrunk.base64,
        });
        continue;
      }
      // The resolution it was rendered at (above): looked up at the formula
      // default instead, a small picture always fell back to its 72 dpi embed
      // and the sharper render it had paid for went unused.
      const dpi = dpiFor(p.box, "picture");
      const png =
        p.box && p.page ? rendered.get(`${p.page}@${dpi}`) : undefined;
      const size = pageSize(p.page);
      if (!png || !size || !p.box) {
        figures.push(embedded(p));
        continue;
      }
      const rect = toPixels(p.box, size, dpi);
      try {
        const buffer = await sharp(png)
          .extract(rect)
          .png(FIGURE_PNG)
          .toBuffer();
        figures.push({
          ...embedded(p),
          width: rect.width,
          height: rect.height,
          bytesBase64: buffer.toString("base64"),
        });
      } catch {
        figures.push(embedded(p));
      }
    }

    // Formulas: the gap includes the neighbours' line spacing, so the raw crop
    // starts with the bottom of one line and ends with the top of the next.
    // Keep the interior ink band (figures.mjs interiorRows).
    for (const region of regions) {
      const dpi = dpiFor(region.box);
      const png = rendered.get(`${region.page}@${dpi}`);
      const size = pageSize(region.page);
      if (!png || !size) continue;
      const rect = toPixels(region.box, size, dpi);
      try {
        const raw = await sharp(png)
          .extract(rect)
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const { width, height } = raw.info;
        const rowInk: number[] = [];
        for (let y = 0; y < height; y++) {
          let ink = 0;
          for (let x = 0; x < width; x++)
            if (raw.data[y * width + x] < 160) ink += 1;
          rowInk.push(ink);
        }
        const band = interiorRows(rowInk, { minGap: 4 });
        const tight = {
          left: rect.left,
          top: rect.top + band.top,
          width: rect.width,
          height: band.height,
        };
        const buffer = await sharp(png)
          .extract(tight)
          .png(FIGURE_PNG)
          .toBuffer();
        figures.push({
          id: `formula-${region.placeholderIndex + 1}`,
          kind: "formula",
          page: region.page,
          box: region.box,
          placeholderIndex: region.placeholderIndex,
          alt: altFor({
            kind: "formula",
            page: region.page,
            placeholderIndex: region.placeholderIndex,
          }),
          mimeType: "image/png",
          width: tight.width,
          height: tight.height,
          bytesBase64: buffer.toString("base64"),
        });
        located += 1;
        hooks.onPage?.(located); // the client shows "figure N" while this runs
      } catch {
        // a crop outside the render: the placeholder stays
      }
    }
    renderMs = Date.now() - renderStart;
  }

  const { kept, dropped } = applyBudget(figures, MAX_FIGURE_BYTES);
  return {
    figures: kept,
    stats: {
      pictures: pictures.length,
      formulas: total,
      located,
      skipped: total - located,
      droppedForBudget: dropped,
      jsonMs,
      renderMs,
    },
  };
}

/**
 * The service with no binding — a fresh desktop install. Text PDFs read
 * through the pdf.js text layer; Markdown and plain text pass through; every
 * other format names what would read it. Never an empty source: a PDF whose
 * text layer is missing or garbled is refused with the remedy, not converted
 * to nothing.
 */
async function convertWithoutBinding(
  filename: string,
  bytes: Buffer,
  reply: Reply,
  jobId: string | null,
  job: JobProgress | null,
  hooks: ProgressHooks,
): Promise<void> {
  const started = Date.now();
  const format = formatWithoutBinding(filename);
  const refuse = (status: number, body: Record<string, unknown>): void => {
    finishJob(jobId, job, "failed");
    reply(status, { ...body, binding: false });
  };
  {
    if (format === null) {
      const ext = extname(filename).slice(1).toLowerCase() || "this file";
      refuse(415, {
        error: `cannot convert ${ext} without the docling.rs binding — install the converter`,
        code: "BINDING_REQUIRED",
        hint: "Install the converter, or point the vault at a conversion service.",
      });
      return;
    }
    if (format === "md" || format === "txt") {
      const text = bytes.toString("utf8");
      hooks.onPhase?.("structuring");
      const chunkStart = Date.now();
      const chunks = localChunks(text);
      finishJob(jobId, job, "done");
      reply(200, {
        markdown: text,
        chunks,
        format,
        inputName: filename,
        pages: null,
        // Already text: nothing read it, nothing recognised it.
        textSource: "text",
        ocr: null,
        timings: {
          convertMs: 0,
          chunkMs: Date.now() - chunkStart,
          ocrMs: 0,
          totalMs: Date.now() - started,
        },
        binding: false,
      });
      return;
    }
    await convertPdfTextLayer(filename, bytes, reply, jobId, job, hooks, {
      remedy: "install the converter",
    });
  }
}

/**
 * From this many pages on, a text layer under this many words per page reads
 * as a scan with a stray header, not as the document. Shorter documents are
 * judged only by having words at all: a certificate or a cover page with a
 * handful of words is a document, not a scan.
 */
const TEXT_LAYER_FLOOR_FROM_PAGES = 3;
const TEXT_LAYER_MIN_WORDS_PER_PAGE = 10;
/** Fewer words than this in the whole file is a stray mark, not text. */
const TEXT_LAYER_MIN_WORDS = 3;

/**
 * A PDF through the pdf.js text layer alone — the rung that works without the
 * binding, and with the binding but without the models. Never an empty source:
 * a missing or garbled layer, or one too thin to be the document (words per
 * page under the floor — a scan with a header), is refused with
 * NEEDS_CONVERTER and the remedy that would read it.
 */
async function convertPdfTextLayer(
  filename: string,
  bytes: Buffer,
  reply: Reply,
  jobId: string | null,
  job: JobProgress | null,
  hooks: ProgressHooks,
  opts: { remedy: string; missing?: string[] },
): Promise<void> {
  const started = Date.now();
  const binding = await bindingAvailable();
  const refuse = (body: Record<string, unknown>): void => {
    finishJob(jobId, job, "failed");
    reply(415, {
      ...body,
      code: "NEEDS_CONVERTER",
      binding,
      ...(opts.missing ? { missing: opts.missing } : {}),
    });
  };
  hooks.onPhase?.("text-layer");
  let layer: Awaited<ReturnType<typeof extractTextWithPdfjs>>;
  try {
    layer = await extractTextWithPdfjs(new Uint8Array(bytes));
  } catch (error) {
    refuse({
      error: `pdf.js could not open this PDF; the converter would read it — ${opts.remedy}`,
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (job) job.pages = layer.pages;
  const words = layer.text.split(/\s+/).filter(Boolean).length;
  const perPage = words / Math.max(1, layer.pages);
  const thin = layer.pages >= TEXT_LAYER_FLOOR_FROM_PAGES && perPage < TEXT_LAYER_MIN_WORDS_PER_PAGE;
  if (words < TEXT_LAYER_MIN_WORDS || thin || looksGarbled(layer.text)) {
    refuse({
      error:
        words === 0
          ? `this PDF has no text layer — a scan. The converter's OCR would read it; ${opts.remedy}`
          : thin
            ? `this PDF's text layer is too thin to be the document (${words} words over ${layer.pages} pages — a scan with a header). The converter's OCR would read it; ${opts.remedy}`
            : words < TEXT_LAYER_MIN_WORDS
              ? `this PDF's text layer holds only ${words} word${words === 1 ? "" : "s"} — a scan with a stray mark. The converter's OCR would read it; ${opts.remedy}`
              : `this PDF's text layer is unreadable (encoded fonts). The converter would read it; ${opts.remedy}`,
      pages: layer.pages,
      words,
      needsOcr: {
        via: "docling-ocr",
        estimateSeconds: Math.round(layer.pages * DOCLING_OCR_SECONDS_PER_PAGE),
      },
    });
    return;
  }
  hooks.onPhase?.("structuring");
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "vault-convert-"));
    const conversion = await conversionFromText(layer.markdown, dir, filename);
    finishJob(jobId, job, "done");
    reply(200, {
      markdown: conversion.markdown,
      chunks: conversion.chunks,
      format: "pdf",
      inputName: filename,
      pages: layer.pages,
      textSource: "pdfjs",
      ocr: null,
      needsOcr: null,
      ocrOffer: null,
      timings: { ...conversion.timings, ocrMs: 0, totalMs: Date.now() - started },
      binding,
    });
  } catch (error) {
    finishJob(jobId, job, "failed"); // the dispatcher answers 500 with the message
    throw error;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** How a conversion answers: the status and body the coordinator sends back. */
type Reply = (status: number, body: Record<string, unknown>) => void;

/** What the coordinator hands a worker: the upload is already on disk, in a dir the coordinator owns. */
interface JobRequest {
  id: string;
  /** The job's scratch dir; the upload is `<dir>/<filename>`. Removed by the coordinator. */
  dir: string;
  filename: string;
  ocr: boolean;
  figures: boolean;
}

/**
 * One document, converted — runs in a worker process (see `startWorker`), which
 * holds the warm pipeline. Everything before this (the upload, the slot, the
 * heartbeat) is the coordinator's; everything here answers through `reply`.
 */
async function convertJob(
  request: JobRequest,
  job: JobProgress,
  reply: Reply,
): Promise<void> {
  const { filename } = request;
  const jobId = request.id;
  const bytes = await readFile(join(request.dir, filename));
  const hooks: ProgressHooks = {
    onPhase: (phase) => {
      job.phase = phase;
    },
    onPage: (n) => {
      job.pagesDone = job.pages === null ? n : Math.min(n, job.pages);
    },
  };

  if (!(await bindingAvailable())) {
    await convertWithoutBinding(filename, bytes, reply, jobId, job, hooks);
    return;
  }

  let library: Awaited<ReturnType<typeof docling>>;
  try {
    library = await docling();
  } catch (error) {
    finishJob(jobId, job, "failed");
    reply(503, {
      error: "the docling.rs binding is not installed",
      detail: error instanceof Error ? error.message : String(error),
      hintForOperators: "run `bun install` in the vault package",
    });
    return;
  }

  const format = library.formatFromName(filename);
  const usePipeline = format !== null && MODEL_BACKED_FORMATS.has(format);
  const dependencies = library.checkDependencies();

  // Models are only needed for the model-backed formats. Everything else works
  // on a fresh install, which is what lets the UI offer the 700 MB download
  // instead of failing.
  if (usePipeline && !dependencies.ready) {
    if (format === "pdf") {
      // The binding without the models: the text layer still reads a text PDF
      // (the same rung as a fresh install); only a scan waits for the models.
      await convertPdfTextLayer(filename, bytes, reply, jobId, job, hooks, {
        remedy: "install the PDF models",
        missing: dependencies.missing,
      });
      return;
    }
    finishJob(jobId, job, "failed");
    reply(415, {
      error: `cannot convert ${format} without the docling models`,
      code: "MODELS_REQUIRED",
      missing: dependencies.missing,
      modelsDir: dependencies.home,
      hintForOperators: "npm run fetch-models — downloads ~700 MB, once",
    });
    return;
  }

  const dir = request.dir;
  const started = Date.now();
  try {
    const file = join(dir, filename);

    // The text layer, read once up front by pdf.js (0.4 s for 19 pages): the
    // page count feeds the progress bar, the text feeds the quality score, and
    // both feed the routing decision if docling's result turns out garbled.
    const isPdf = filename.toLowerCase().endsWith(".pdf");
    let layer: {
      garbled: boolean;
      chars: number;
      text: string;
      markdown: string;
      pages: number;
      blocks: PageBlocks[];
    } | null = null;
    if (isPdf) {
      try {
        const extracted = await extractTextWithPdfjs(new Uint8Array(bytes));
        layer = {
          garbled: looksGarbled(extracted.text),
          chars: extracted.text.trim().length,
          text: extracted.text,
          markdown: extracted.markdown,
          pages: extracted.pages,
          blocks: extracted.blocks,
        };
        job.pages = extracted.pages;
      } catch {
        layer = null; // pdf.js could not open it; the OCR rungs decide later
      }
    }

    let result: Conversion | null = null;
    let normalised: "qpdf" | "gs" | null = null;
    let refusal: unknown = null;

    try {
      result = await convertOnce(file, usePipeline, hooks);
    } catch (error) {
      // Rewrite only when the parser actually refused the file, and only for PDFs.
      if (!isPdf || !isFormatError(error)) throw error;
      refusal = error;

      // "The tool exited 0" is NOT the test — "the rewritten file converts" is.
      // Measured: on a PDF whose page tree declares more pages than it has,
      // `qpdf --linearize` exits 0 and leaves the file just as refused (it
      // preserves the bad /Count), while `gs` rebuilds the tree and cures it.
      // So each rewrite is tried and then converted; the first that works wins.
      for (const rewriter of REWRITERS) {
        const target = join(dir, `normalised-${rewriter.tool}.pdf`);
        if (!(await run(rewriter.tool, rewriter.args(file, target)))) continue;
        try {
          result = await convertOnce(target, usePipeline, hooks);
          normalised = rewriter.tool;
          break;
        } catch {
          // This rewrite did not help; try the next one.
        }
      }
    }

    // The parser refused it and no rewrite produced something it accepts.
    if (result === null) {
      finishJob(jobId, job, "failed");
      reply(415, {
        error: "the document could not be read, even after rewriting it",
        detail: refusal instanceof Error ? refusal.message : String(refusal),
        attempted: REWRITERS.map((rewriter) => rewriter.tool),
        hintForOperators:
          "docling.rs refused this PDF and neither qpdf nor ghostscript produced a file it accepts",
      });
      return;
    }

    // docling read the file, but did it read words? If not — or if the caller
    // asked for OCR outright with `?ocr=1` — decide how to read it from what the
    // file is and what this machine has (see routing.mjs). Cheapest rung first;
    // nothing is installed; the response says which rung produced the text.
    let ocr: "tesseract" | "docling" | null = null;
    let textSource: "docling" | "pdfjs" | "tesseract" | "docling-ocr" =
      "docling";
    let needsOcr: {
      via: "tesseract" | "docling-ocr";
      estimateSeconds: number;
    } | null = null;
    let pages: number | null = null;
    let ocrMs = 0;
    const ocrRequested = request.ocr;
    const wantFigures = request.figures;
    // The figures are cut from the docling JSON of the conversion whose Markdown
    // ships, so their placeholder indices line up; the text-layer rung keeps the
    // first conversion's (its Markdown has no placeholders of its own).
    const initialJson = result.json;
    const doclingGarbled = looksGarbled(result.markdown);
    if (usePipeline && (ocrRequested || doclingGarbled)) {
      const source = normalised
        ? join(dir, `normalised-${normalised}.pdf`)
        : file;
      pages = layer?.pages ?? null;
      const caps = await capabilities();
      const route = decideRoute({
        doclingGarbled,
        pdfjs: layer ? { garbled: layer.garbled, chars: layer.chars } : null,
        pages: pages ?? 1,
        capabilities: {
          tesseract: caps.tesseract,
          ocrmypdf: caps.ocrmypdf,
          doclingOcr: dependencies.ocr,
        },
        forceOcr: ocrRequested,
        autoOcrBudgetSeconds: AUTO_OCR_BUDGET_SECONDS,
        jobs: OCR_JOBS,
      });

      const ocrStart = Date.now();
      switch (route.kind) {
        case "docling":
          break;
        case "pdfjs":
          if (layer) {
            hooks.onPhase?.("text-layer");
            result = await conversionFromText(layer.markdown, dir, filename);
            textSource = "pdfjs";
          }
          break;
        case "tesseract": {
          hooks.onPhase?.("ocr");
          const out = await ocrWithTesseract(
            source,
            dir,
            route.mode,
            caps.nice,
          );
          if ("path" in out) {
            result = await convertOnce(out.path, true, hooks);
            ocr = "tesseract";
            textSource = "tesseract";
          } else if (dependencies.ocr) {
            // Tesseract is installed but failed on this file: docling's own OCR is the last rung.
            result = await convertWithOcr(source);
            ocr = "docling";
            textSource = "docling-ocr";
          } else {
            finishJob(jobId, job, "failed");
            reply(415, {
              error:
                "the document could not be read: its text is unusable and OCR failed",
              detail: out.error,
              capabilities: caps,
            });
            return;
          }
          break;
        }
        case "docling-ocr":
          hooks.onPhase?.("ocr");
          result = await convertWithOcr(source);
          ocr = "docling";
          textSource = "docling-ocr";
          break;
        case "needs-ocr":
          // Over the budget: say what it would cost and let the caller decide
          // (`?ocr=1`). No text is returned — glyph soup is not a source.
          needsOcr = { via: route.via, estimateSeconds: route.estimateSeconds };
          result = { ...result, markdown: "", chunks: [] };
          break;
        case "unreadable":
          finishJob(jobId, job, "failed");
          reply(415, {
            error:
              "the document's text is unusable and nothing here can OCR it",
            capabilities: caps,
            hintForOperators:
              "install tesseract + ocrmypdf on the machine running the conversion service, or fetch the docling models (npm run fetch-models)",
          });
          return;
      }
      // OCR that still reads as soup is worse than the text layer already in
      // hand: fall back to it rather than hand the user unreadable parts.
      if (result && ocr !== null) {
        if (looksGarbled(result.markdown) && layer && !layer.garbled) {
          result = await conversionFromText(layer.markdown, dir, filename);
          ocr = null;
          textSource = "pdfjs";
        } else {
          result = { ...result, markdown: tidyOcrSpacing(result.markdown) };
        }
      }
      ocrMs = Date.now() - ocrStart;
    }

    // The text layer read, but flat: tables and bullets are gone. Say what OCR
    // would cost to get them back, so the UI can offer it instead of guessing.
    let ocrOffer: {
      via: "tesseract" | "docling-ocr";
      estimateSeconds: number;
    } | null = null;
    if (textSource === "pdfjs") {
      const caps = await capabilities();
      const offer = decideRoute({
        doclingGarbled: true,
        pdfjs: layer ? { garbled: layer.garbled, chars: layer.chars } : null,
        pages: pages ?? layer?.pages ?? 1,
        capabilities: {
          tesseract: caps.tesseract,
          ocrmypdf: caps.ocrmypdf,
          doclingOcr: dependencies.ocr,
        },
        forceOcr: true,
        autoOcrBudgetSeconds: AUTO_OCR_BUDGET_SECONDS,
        jobs: OCR_JOBS,
      });
      if (offer.kind === "tesseract" || offer.kind === "docling-ocr") {
        ocrOffer = { via: offer.kind, estimateSeconds: offer.estimateSeconds };
      }
    }

    // The document's pictures and display formulas as images, on request. Only
    // when docling wrote the markdown: the text-layer rung has no placeholders
    // to put them in.
    let figures: Figure[] = [];
    let figureStats: FigureStats | null = null;
    if (wantFigures && isPdf && !needsOcr) {
      hooks.onPhase?.("figures");
      job.pagesDone = 0;
      job.pages = null;
      const figureSource = normalised
        ? join(dir, `normalised-${normalised}.pdf`)
        : file;
      try {
        const collected = await collectFigures(
          figureSource,
          dir,
          usePipeline,
          hooks,
          textSource === "pdfjs" ? initialJson : (result.json ?? initialJson),
        );
        figures = collected.figures;
        figureStats = collected.stats;

        // The text-layer rung wrote this markdown from pdf.js runs, so it has
        // no `<!-- image -->` / `<!-- formula-not-decoded -->` placeholders for
        // the figures to land in — docling's layout model still found them
        // (it reads pixels, not fonts), and both sides use the same page
        // coordinates. Place each figure among the text blocks, renumber the
        // placeholders in the order they now appear, and re-chunk, because the
        // sections are cut from the markdown.
        if (textSource === "pdfjs" && layer && figures.length > 0 && result) {
          const placed = insertFigurePlaceholders(layer.blocks, figures, {
            picture: "<!-- image -->",
            formula: "<!-- formula-not-decoded -->",
          });
          const counters = { picture: 0, formula: 0 };
          figures = placed.placed.map((figure) => {
            // The caption may have just arrived from the chart's own title,
            // absorbed out of the text layer, so the alt text — the first
            // thing a model reads about a figure — is rebuilt from it.
            const renumbered = {
              ...figure,
              placeholderIndex: counters[figure.kind]++,
            };
            return { ...renumbered, alt: altFor(renumbered) };
          });
          result = await conversionFromText(placed.markdown, dir, filename);
          // `unplaced` is its own count: a figure with no box could not be
          // positioned among the text — not the same as one left out for size.
          figureStats = {
            ...collected.stats,
            unplaced: placed.unplaced.length,
          };
        }
      } catch (error) {
        console.warn(
          `[convert] figures failed for ${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // How much of the file's own text made it through — measured against the
    // text layer pdf.js read, so it is a floor on completeness, never a proof.
    const quality: ConversionQuality | null =
      layer && !needsOcr
        ? conversionQuality(layer.text, result.markdown)
        : null;

    finishJob(jobId, job, "done");

    reply(200, {
      markdown: result.markdown,
      chunks: result.chunks,
      format: result.format,
      inputName: result.inputName,
      timings: { ...result.timings, ocrMs, totalMs: Date.now() - started },
      backend: "docling.rs",
      normalised,
      ocr,
      textSource,
      needsOcr,
      ocrOffer,
      pages: pages ?? layer?.pages ?? null,
      quality,
      figures,
      figureStats,
    });
  } catch (error) {
    // The worker answers 500 with the message; the job must not linger as running.
    finishJob(jobId, job, "failed");
    throw error;
  }
}

/** `/health`: the two independent states — binding present, models present. */
async function handleHealth(res: ServerResponse): Promise<void> {
  if (!(await bindingAvailable())) {
    // A working service, honestly described: what it reads, and what the
    // binding would add. 200, not 503 — the caller's vault is not broken.
    sendJson(res, 200, {
      ok: true,
      backend: "pdfjs",
      binding: false,
      runtime: runtimeName(),
      ready: false,
      missing: ["binding", "models"],
      modelsDir: process.env.DOCLING_RS_HOME ?? null,
      modelsLoaded: false,
      formats: [...NO_BINDING_FORMATS],
      capabilities: { ...(await capabilities()), doclingOcr: false },
      ocrEngine: null,
      autoOcrBudgetSeconds: AUTO_OCR_BUDGET_SECONDS,
      ...(await slotsReport()),
      hint: "Install the docling.rs binding for Word, slides, spreadsheets and scanned PDFs.",
    });
    return;
  }
  try {
    const library = await docling();
    const dependencies = library.checkDependencies();
    sendJson(res, 200, {
      ok: true,
      backend: "docling.rs",
      binding: true,
      runtime: runtimeName(),
      ready: dependencies.ready,
      missing: dependencies.missing,
      modelsDir: dependencies.home,
      // A model worker alive keeps the models warm (they load in the worker).
      modelsLoaded: lanes.models.idle.length > 0 || [...lanes.models.running].some((r) => r.worker !== null),
      formats: library.supportedFormats(),
      // What this machine can do about a scan, so a UI can say "fast", "slow" or
      // "install …" before anyone drops a file.
      capabilities: { ...(await capabilities()), doclingOcr: dependencies.ocr },
      ocrEngine:
        (await capabilities()).tesseract && (await capabilities()).ocrmypdf
          ? "tesseract"
          : dependencies.ocr
            ? "docling"
            : null,
      autoOcrBudgetSeconds: AUTO_OCR_BUDGET_SECONDS,
      ...(await slotsReport()),
    });
  } catch (error) {
    sendJson(res, 503, {
      ok: false,
      backend: "docling.rs",
      runtime: runtimeName(),
      error: "the docling.rs binding is not installed",
      detail: error instanceof Error ? error.message : String(error),
      hintForOperators: "run `bun install` in the vault package",
    });
  }
}

// --- the coordinator: HTTP, slots, cancellation -------------------------------

/**
 * The service is two kinds of process. The **coordinator** — the one started —
 * answers HTTP, holds the slots and the progress table, and keeps the upload on
 * disk; it never converts. Each conversion runs in a **worker**: a child process
 * of this same file (`CONVERT_ROLE=worker`) holding its own warm pipeline. So a
 * conversion can be stopped for real — docling.rs has no abort, but a process
 * can be ended — and a crash or an out-of-memory in one document is that
 * worker's, not the service's.
 */
type Lane = "models" | "other";

interface Worker {
  child: ChildProcess;
  /** Resolves true once the worker said it is ready, false if it died first. */
  ready: Promise<boolean>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Running {
  id: string;
  filename: string;
  lane: Lane;
  since: number;
  worker: Worker | null;
  cancelled: boolean;
  /** Stops whatever stage the job is in: the upload, or the worker converting it. */
  stop: (() => void) | null;
}

const lanes: Record<
  Lane,
  { capacity: number; running: Set<Running>; idle: Worker[] }
> = {
  models: { capacity: MODEL_SLOTS, running: new Set(), idle: [] },
  other: { capacity: OTHER_SLOTS, running: new Set(), idle: [] },
};
const runningJobs = new Map<string, Running>();
const JOB_ID = /^[\w-]{1,80}$/;
const SELF = fileURLToPath(import.meta.url);
const CANCELLED: Settled = {
  status: 409,
  body: { error: "the conversion was cancelled", code: "CONVERSION_CANCELLED" },
};

/** A worker's answer: small bodies travel inline, a converted document as a file the coordinator streams. */
type Settled =
  | { status: number; body: Record<string, unknown> }
  | { status: 200; resultPath: string };

/** Image extensions docling.rs may read as `image`; filtered through the binding's own naming. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp", "gif"];

let modelExtensionsProbe: Promise<string[]> | null = null;
/** The extensions that go to the model lane: PDF always, images when the binding reads them. */
function modelExtensions(): Promise<string[]> {
  modelExtensionsProbe ??= (async () => {
    if (!(await bindingAvailable())) return ["pdf"];
    const library = await docling();
    const backed = IMAGE_EXTENSIONS.filter((ext) => {
      const format = library.formatFromName(`file.${ext}`);
      return format !== null && MODEL_BACKED_FORMATS.has(format);
    });
    return ["pdf", ...backed];
  })();
  return modelExtensionsProbe;
}

async function laneFor(filename: string): Promise<Lane> {
  const ext = extname(filename).slice(1).toLowerCase();
  return (await modelExtensions()).includes(ext) ? "models" : "other";
}

/** `/health`'s `slots` and `modelExtensions`: a client sends no more at once than these. */
async function slotsReport(): Promise<{
  slots: { models: number; other: number; busyModels: number; busyOther: number };
  modelExtensions: string[];
}> {
  return {
    slots: {
      models: lanes.models.capacity,
      other: lanes.other.capacity,
      busyModels: lanes.models.running.size,
      busyOther: lanes.other.running.size,
    },
    modelExtensions: await modelExtensions(),
  };
}

/** A worker's environment: this process's, with the PDF thread budget split when several model slots share it. */
function workerEnv(lane: Lane): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CONVERT_ROLE: "worker" };
  if (lane === "models" && MODEL_SLOTS > 1) {
    const share = Math.max(1, Math.floor(PDF_THREAD_BUDGET / MODEL_SLOTS));
    env.DOCLING_RS_PDF_THREADS = String(share);
    env.DOCLING_RS_TF_INTRA = String(Math.min(2, share));
    env.CONVERT_OCR_JOBS = String(share);
  }
  return env;
}

function spawnWorker(lane: Lane): Worker {
  const child = fork(SELF, [], {
    env: workerEnv(lane),
    // Its own process group on POSIX, so stopping it stops the helpers it
    // started too (ocrmypdf, tesseract, gs, qpdf) — they are not detached.
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const ready = new Promise<boolean>((resolve) => {
    const onMessage = (message: { type?: string } | null) => {
      if (message?.type !== "ready") return;
      child.off("message", onMessage);
      resolve(true);
    };
    child.on("message", onMessage);
    child.once("exit", () => resolve(false));
    child.once("error", () => resolve(false));
  });
  return { child, ready, idleTimer: null };
}

/** End a worker and everything it started. Its slot's job, if any, settles from its exit. */
function stopWorker(worker: Worker): void {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  const { child } = worker;
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    // No process groups: taskkill walks the tree.
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    }).on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function acquireWorker(lane: Lane): Promise<Worker> {
  const pool = lanes[lane];
  for (let worker = pool.idle.pop(); worker; worker = pool.idle.pop()) {
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
    if (worker.child.exitCode === null && worker.child.signalCode === null)
      return worker;
  }
  const worker = spawnWorker(lane);
  if (!(await worker.ready)) {
    throw new Error("the conversion worker did not start (see the converter log)");
  }
  return worker;
}

function releaseWorker(lane: Lane, worker: Worker): void {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const pool = lanes[lane];
  pool.idle.push(worker);
  if (IDLE_RELEASE_MS > 0) {
    worker.idleTimer = setTimeout(() => {
      const index = pool.idle.indexOf(worker);
      if (index < 0) return;
      pool.idle.splice(index, 1);
      stopWorker(worker);
      console.log(`[convert] stopped an idle ${lane} worker after ${IDLE_RELEASE_MS} ms`);
    }, IDLE_RELEASE_MS);
    worker.idleTimer.unref();
  }
}

const isCancelled = (entry: Running): boolean => entry.cancelled;

/** Cancel a job: its upload stops, or its worker is ended; the slot is freed when it settles. */
function cancelRunning(entry: Running): void {
  if (entry.cancelled) return;
  entry.cancelled = true;
  const job = jobs.get(entry.id);
  if (job) job.phase = "cancelled";
  entry.stop?.();
}

class BodyTooLarge extends Error {}
class UploadCancelled extends Error {}

/** Stream the upload to `path`, refusing anything over `MAX_BYTES`. Never held in memory whole. */
function receiveBody(
  req: IncomingMessage,
  path: string,
  entry: Running,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path);
    let size = 0;
    let failed = false;
    const fail = (error: Error): void => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      req.resume(); // drain the rest, so the answer still reaches the caller
      reject(error);
    };
    entry.stop = () => fail(new UploadCancelled("the conversion was cancelled"));
    req.on("data", (part: Buffer) => {
      size += part.length;
      if (size > MAX_BYTES) fail(new BodyTooLarge(`body exceeds ${MAX_BYTES} bytes`));
    });
    req.on("error", (error) => fail(error));
    out.on("error", (error) => fail(error));
    out.on("finish", () => {
      if (!failed) resolve(size);
    });
    req.pipe(out);
  });
}

/** A converted document, streamed from the worker's file: the coordinator never parses it. */
function sendResultFile(res: ServerResponse, path: string): Promise<void> {
  return new Promise((resolve) => {
    void stat(path).then(
      (info) => {
        if (!res.headersSent) {
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": info.size,
          });
        }
        const stream = createReadStream(path);
        stream.on("error", () => {
          res.destroy();
          resolve();
        });
        res.once("close", () => resolve());
        stream.pipe(res);
      },
      () => {
        sendJson(res, 500, { error: "the converted document could not be read back" });
        resolve();
      },
    );
  });
}

async function handleConvertRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const filename = basename(url.searchParams.get("filename") ?? "");
  if (!filename) {
    req.resume();
    sendJson(res, 400, { error: "filename query parameter is required" });
    return;
  }
  const lane = await laneFor(filename);
  const pool = lanes[lane];
  // The slot is taken before the upload is read: a caller that would be turned
  // away learns it at once, instead of after sending 100 MB.
  if (pool.running.size >= pool.capacity) {
    req.resume();
    const busyWith = [...pool.running].sort((a, b) => a.since - b.since);
    sendJson(res, 503, {
      error: `${busyWith.length === 1 ? "a conversion is" : `${busyWith.length} conversions are`} already running (${busyWith.map((r) => r.filename).join(", ")}); try again when ${busyWith.length === 1 ? "it finishes" : "one finishes"}`,
      code: "CONVERSION_BUSY",
      busyWith: busyWith[0]?.filename ?? null,
      sinceMs: busyWith[0] ? Date.now() - busyWith[0].since : 0,
    });
    return;
  }
  const asked = url.searchParams.get("job");
  if (asked !== null && JOB_ID.test(asked) && runningJobs.has(asked)) {
    req.resume();
    sendJson(res, 409, { error: `job ${asked} is already running`, code: "JOB_EXISTS" });
    return;
  }
  const id = asked !== null && JOB_ID.test(asked) ? asked : randomUUID();
  const entry: Running = {
    id,
    filename,
    lane,
    since: Date.now(),
    worker: null,
    cancelled: false,
    stop: null,
  };
  pool.running.add(entry);
  runningJobs.set(id, entry);
  const job = startJob(id);
  // A caller that goes away takes its conversion with it. `res`, not `req`: a
  // request reports "close" as soon as its body has been read.
  res.once("close", () => {
    if (!res.writableFinished) cancelRunning(entry);
  });
  let dir: string | null = null;
  let worker: Worker | null = null;
  let outcome: Settled;
  try {
    dir = await mkdtemp(join(tmpdir(), TMP_PREFIX));
    let size: number;
    try {
      size = await receiveBody(req, join(dir, filename), entry);
    } catch (error) {
      outcome =
        error instanceof UploadCancelled
          ? CANCELLED
          : { status: 413, body: { error: error instanceof Error ? error.message : String(error) } };
      return;
    }
    if (size === 0) {
      outcome = { status: 400, body: { error: "empty body" } };
      return;
    }
    if (entry.cancelled) {
      outcome = CANCELLED;
      return;
    }
    worker = await acquireWorker(lane);
    entry.worker = worker;
    const request: JobRequest = {
      id,
      dir,
      filename,
      ocr: url.searchParams.get("ocr") === "1",
      figures: url.searchParams.get("figures") === "1",
    };
    const child = worker.child;
    const live = worker;
    outcome = await new Promise<Settled>((resolve) => {
      const onMessage = (message: WorkerMessage | null) => {
        if (!message || message.id !== id) return;
        if (message.type === "progress" && job) {
          job.phase = entry.cancelled ? "cancelled" : message.progress.phase;
          job.pages = message.progress.pages;
          job.pagesDone = message.progress.pagesDone;
          return;
        }
        if (message.type !== "result") return;
        done();
        resolve(
          message.resultPath
            ? { status: 200, resultPath: message.resultPath }
            : { status: message.status, body: message.body ?? {} },
        );
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        done();
        resolve(
          entry.cancelled
            ? CANCELLED
            : {
                status: 500,
                body: {
                  error: `the converter stopped while converting ${filename} (${signal ?? `exit ${code}`}) — it may have run out of memory`,
                  code: "WORKER_EXITED",
                },
              },
        );
      };
      const done = () => {
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      entry.stop = () => stopWorker(live);
      child.send({ type: "convert", request });
    });
    // Read through a call: a cancel lands while the conversion is awaited.
    if (isCancelled(entry)) outcome = CANCELLED;
  } catch (error) {
    outcome = {
      status: 500,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    entry.stop = null;
    // A cancel may have ended the worker; one that finished goes back to its lane.
    if (worker && !entry.cancelled) releaseWorker(lane, worker);
    const settled = outcome!;
    finishJob(
      id,
      job,
      entry.cancelled ? "cancelled" : settled.status === 200 ? "done" : "failed",
    );
    if (!res.destroyed && !res.writableEnded) {
      if ("resultPath" in settled) await sendResultFile(res, settled.resultPath);
      else sendJson(res, settled.status, settled.body);
    }
    pool.running.delete(entry);
    runningJobs.delete(id);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

type WorkerMessage =
  | { type: "ready"; id?: undefined }
  | {
      type: "progress";
      id: string;
      progress: { phase: Phase; pages: number | null; pagesDone: number };
    }
  | {
      type: "result";
      id: string;
      status: number;
      body?: Record<string, unknown>;
      resultPath?: string;
    };

function startCoordinator(): void {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          await handleHealth(res);
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/progress/")) {
          const job = jobs.get(
            decodeURIComponent(url.pathname.slice("/progress/".length)),
          );
          if (!job) {
            sendJson(res, 404, {
              error: "no such job (finished jobs are kept for a minute)",
              code: "JOB_NOT_FOUND",
            });
            return;
          }
          sendJson(res, 200, {
            phase: job.phase,
            pages: job.pages,
            pagesDone: job.pagesDone,
            elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/convert") {
          // The heartbeat starts before the work, not after the body is read: a
          // large upload over a slow link is itself long enough to trip an idle
          // timeout, and nothing has been written yet at that point.
          const heartbeat = startHeartbeat(res, HEARTBEAT_MS);
          try {
            await handleConvertRequest(req, res, url);
          } finally {
            heartbeat.stop();
          }
          return;
        }
        if (req.method === "DELETE" && url.pathname.startsWith("/convert/")) {
          const id = decodeURIComponent(url.pathname.slice("/convert/".length));
          if (!JOB_ID.test(id)) {
            sendJson(res, 400, { error: "malformed job id", code: "INVALID_JOB" });
            return;
          }
          const entry = runningJobs.get(id);
          if (!entry) {
            sendJson(res, 404, { cancelled: false });
            return;
          }
          cancelRunning(entry);
          sendJson(res, 200, { cancelled: true });
          return;
        }
        if (url.pathname === "/") {
          sendJson(res, 200, {
            service: "vault-convert",
            endpoints: [
              "GET /health",
              "POST /convert?filename=<name>&job=<id>",
              "GET /progress/<id>",
              "DELETE /convert/<id>",
            ],
          });
          return;
        }
        sendJson(res, 404, { error: "not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ENOENT|command not found/i.test(message)) {
          sendJson(res, 415, { error: message });
          return;
        }
        sendJson(res, 500, { error: message });
      }
    })();
  });

  const stopAll = () => {
    for (const lane of Object.values(lanes)) {
      for (const worker of lane.idle) stopWorker(worker);
      for (const entry of lane.running) if (entry.worker) stopWorker(entry.worker);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopAll();
      server.close(() => process.exit(0));
    });
  }
  process.on("exit", stopAll);

  server.listen(PORT, HOST, () => {
    // One line, so `docker logs` / journald show something useful at start-up.
    console.log(
      `vault-convert listening on http://${HOST}:${PORT} (${runtimeName()}; slots: ${MODEL_SLOTS} model, ${OTHER_SLOTS} other)`,
    );
    if (IDLE_RELEASE_MS > 0) {
      console.log(`[convert] idle workers stop after ${IDLE_RELEASE_MS} ms`);
    }
    // After listening, so a slow sweep never delays readiness.
    void sweepStaleTempDirs().then((removed) => {
      if (removed > 0) {
        console.log(
          `[convert] swept ${removed} stale scratch dir(s) from a previous run`,
        );
      }
    });
  });
}

// --- the worker ----------------------------------------------------------------

/** How often a worker reports its progress to the coordinator while converting. */
const PROGRESS_REPORT_MS = 300;

function startWorker(): void {
  // The coordinator went away (ended, or killed outright): so does its worker.
  process.on("disconnect", () => process.exit(0));
  process.on("message", (message: { type?: string; request?: JobRequest } | null) => {
    if (message?.type === "convert" && message.request)
      void runJob(message.request);
  });
  process.send?.({ type: "ready" });
}

async function runJob(request: JobRequest): Promise<void> {
  const job: JobProgress = {
    phase: "starting",
    pages: null,
    pagesDone: 0,
    startedAt: Date.now(),
    finishedAt: null,
  };
  let last = "";
  const report = (): void => {
    const progress = { phase: job.phase, pages: job.pages, pagesDone: job.pagesDone };
    const key = JSON.stringify(progress);
    if (key === last) return;
    last = key;
    process.send?.({ type: "progress", id: request.id, progress });
  };
  const ticker = setInterval(report, PROGRESS_REPORT_MS);
  let outcome: { status: number; body: Record<string, unknown> } | null = null;
  try {
    await convertJob(request, job, (status, body) => {
      outcome = { status, body };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome = {
      status: /ENOENT|command not found/i.test(message) ? 415 : 500,
      body: { error: message },
    };
  } finally {
    clearInterval(ticker);
    report();
  }
  const settled: { status: number; body: Record<string, unknown> } = outcome ?? {
    status: 500,
    body: { error: "the conversion ended without an answer" },
  };
  if (settled.status === 200) {
    // A document can be megabytes of Markdown, chunks and figures: it travels
    // as a file the coordinator streams, never as one IPC message to parse.
    const resultPath = join(request.dir, `result-${request.id}.json`);
    await writeFile(resultPath, JSON.stringify(settled.body));
    process.send?.({ type: "result", id: request.id, status: 200, resultPath });
    return;
  }
  process.send?.({
    type: "result",
    id: request.id,
    status: settled.status,
    body: settled.body,
  });
}

if (process.env.CONVERT_ROLE === "worker" && typeof process.send === "function") {
  startWorker();
} else {
  startCoordinator();
}
