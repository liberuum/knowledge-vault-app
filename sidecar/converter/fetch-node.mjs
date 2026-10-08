/**
 * The docling.rs model download, in Node — what `download_dependencies.sh` (v1.58.0, run with
 * `--no-asr`) does, without `sh`, `curl` or `tar`. Windows has no Unix shell, and the upstream
 * script has no Windows branch at all: it treats every non-macOS system as Linux and extracts
 * `lib/<pdfium>` from bblanchon's prebuilt, where the Windows archive keeps `bin/pdfium.dll`.
 *
 * Same files, same places (`.models/…`, `.pdfium/lib/…` under DOCLING_RS_HOME), same idempotence
 * (a file already present is kept), the same progress lines the app parses (`  > dest`,
 * `  = dest (already present)`), and the same failure rules: a required file that cannot be
 * fetched fails the run; an optional one is skipped; mirrors are tried in order.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";

export const MODELS_BASE_URL = "https://github.com/docling-project/docling.rs/releases/download/models-v1";
/** bblanchon's pdfium build, pinned — the script's `latest` drifts; this is the one tested. */
export const PDFIUM_RELEASE = "chromium/8086";

/** pdfium for this platform: where to fetch it, and how to place it where the binding looks. */
export function pdfiumPlan(platform, arch, base = MODELS_BASE_URL) {
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!cpu) return null;
  if (platform === "linux" && cpu === "x64") return { kind: "file", url: `${base}/libpdfium.so`, dest: ".pdfium/lib/libpdfium.so" };
  const os = platform === "win32" ? "win" : platform === "darwin" ? "mac" : platform === "linux" ? "linux" : null;
  if (!os) return null;
  const member = platform === "win32" ? "bin/pdfium.dll" : platform === "darwin" ? "lib/libpdfium.dylib" : "lib/libpdfium.so";
  const lib = member.split("/").pop();
  return { kind: "tgz", url: `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_RELEASE}/pdfium-${os}-${cpu}.tgz`, member, dest: `.pdfium/lib/${lib}` };
}

/** The files, in the script's order: required, mirrored (first URL that lands wins), optional. */
export function modelPlan(base = MODELS_BASE_URL) {
  return [
    { dest: ".models/layout_heron.onnx", urls: [`${base}/layout_heron.onnx`] },
    { dest: ".models/ocr_rec.onnx", urls: [`${base}/ocr_rec.onnx`] },
    { dest: ".models/ppocr_keys_v1.txt", urls: [`${base}/ppocr_keys_v1.txt`] },
    { dest: ".models/ocr_rec_en.onnx", urls: [`${base}/ocr_rec_en.onnx`, "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv3/en_PP-OCRv3_rec_infer.onnx"] },
    { dest: ".models/en_dict.txt", urls: [`${base}/en_dict.txt`, "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/en_dict.txt"] },
    { dest: ".models/ocr_det.onnx", urls: [`${base}/ocr_det.onnx`, "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx"] },
    { dest: ".models/tableformer/encoder.onnx", urls: [`${base}/encoder.onnx`] },
    { dest: ".models/tableformer/encoder.onnx.data", urls: [`${base}/encoder.onnx.data`], optional: true },
    { dest: ".models/tableformer/decoder.onnx", urls: [`${base}/decoder.onnx`] },
    { dest: ".models/tableformer/decoder.onnx.data", urls: [`${base}/decoder.onnx.data`], optional: true },
    { dest: ".models/tableformer/decoder_kv.onnx", urls: [`${base}/decoder_kv.onnx`], optional: true },
    { dest: ".models/tableformer/decoder_kv.onnx.data", urls: [`${base}/decoder_kv.onnx.data`], optional: true },
    { dest: ".models/tableformer/bbox.onnx", urls: [`${base}/bbox.onnx`] },
    { dest: ".models/tableformer/bbox.onnx.data", urls: [`${base}/bbox.onnx.data`], optional: true },
    { dest: ".models/chunk/tokenizer.json", urls: [`${base}/chunk_tokenizer.json`, "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json"] },
    { dest: ".models/picture_classifier.onnx", urls: [`${base}/picture_classifier.onnx`, "https://huggingface.co/docling-project/DocumentFigureClassifier-v2.5/resolve/main/model.onnx"] },
    { dest: ".models/layout_heron_int8.onnx", urls: [`${base}/layout_heron_int8.onnx`], optional: true },
    { dest: ".models/tableformer/decoder_int8.onnx", urls: [`${base}/decoder_int8.onnx`], optional: true },
    { dest: ".models/tableformer/decoder_kv_int8.onnx", urls: [`${base}/decoder_kv_int8.onnx`], optional: true },
    { dest: ".models/tableformer/decoder_kv_int8.onnx.data", urls: [`${base}/decoder_kv_int8.onnx.data`], optional: true },
    { dest: ".models/tableformer/encoder_fp16.onnx", urls: [`${base}/encoder_fp16.onnx`], optional: true },
  ];
}

class NotFound extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (status) => status === 408 || status === 429 || status >= 500;

/**
 * One URL into `dest`, through `dest.download` (renamed when complete). Transient answers and network
 * errors are retried with a doubling backoff; a 404 fails at once (the mirrors and the optional files
 * rely on it). A transfer that stalls for a minute is aborted and retried.
 */
export async function download(url, dest, { fetchImpl = fetch, attempts = 6, backoffMs = 1000, stallMs = 60_000, wait = sleep } = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.download`;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new Error(`stalled for ${stallMs / 1000} s`)), stallMs);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`stalled for ${stallMs / 1000} s`)), stallMs);
    };
    try {
      const res = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
      if (res.status === 404 || res.status === 403) throw new NotFound(`HTTP ${res.status} for ${url}`);
      if (!res.ok || !res.body) {
        last = new Error(`HTTP ${res.status} for ${url}`);
        if (!transient(res.status)) throw last;
      } else {
        const body = Readable.fromWeb(res.body);
        body.on("data", touch);
        await pipeline(body, createWriteStream(part));
        clearTimeout(timer);
        renameSync(part, dest);
        return;
      }
    } catch (error) {
      clearTimeout(timer);
      rmSync(part, { force: true });
      if (error instanceof NotFound) throw error;
      last = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await wait(backoffMs * 2 ** (attempt - 1));
  }
  throw last ?? new Error(`could not fetch ${url}`);
}

/** One member of a gzipped tar, as bytes (ustar: 512-byte headers, size in octal at 124). */
export function tgzMember(tgz, name) {
  const tar = gunzipSync(tgz);
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const entry = (prefix ? `${prefix}/` : "") + field(0, 100);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const body = off + 512;
    if (entry.replace(/^\.\//, "") === name) return Buffer.from(tar.subarray(body, body + size));
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Fetch everything into `home`. `only: "pdfium"` fetches just pdfium (the Windows CI check). */
export async function fetchModelsInNode({ home, platform = process.platform, arch = process.arch, fetchImpl = fetch, log = console.log, only, wait } = {}) {
  const at = (p) => join(home, p);
  log(`fetching docling.rs ML dependencies (Node) into ${home}`);
  const plan = pdfiumPlan(platform, arch);
  if (!plan) {
    log(`  (skipping pdfium: unsupported platform ${platform}/${arch})`);
  } else if (existsSync(at(plan.dest))) {
    log(`  = ${plan.dest} (already present)`);
  } else if (plan.kind === "file") {
    log(`  > ${plan.dest}`);
    await download(plan.url, at(plan.dest), { fetchImpl, wait });
  } else {
    const tgz = at(".pdfium/pdfium.tgz");
    try {
      await download(plan.url, tgz, { fetchImpl, wait });
      const { readFileSync } = await import("node:fs");
      const bytes = tgzMember(readFileSync(tgz), plan.member);
      if (!bytes) throw new Error(`${plan.member} not found in ${plan.url}`);
      mkdirSync(dirname(at(plan.dest)), { recursive: true });
      writeFileSync(`${at(plan.dest)}.download`, bytes);
      renameSync(`${at(plan.dest)}.download`, at(plan.dest));
      log(`  > ${plan.dest}`);
    } catch (error) {
      log(`  ! pdfium not fetched (${error instanceof Error ? error.message : String(error)}) — PDF rasterization stays unavailable`);
    } finally {
      rmSync(tgz, { force: true });
    }
  }
  if (only === "pdfium") return;
  for (const item of modelPlan()) {
    if (existsSync(at(item.dest))) {
      if (!item.optional) log(`  = ${item.dest} (already present)`);
      continue;
    }
    let done = false;
    for (const url of item.urls) {
      try {
        await download(url, at(item.dest), { fetchImpl, wait });
        log(`  > ${item.dest}`);
        done = true;
        break;
      } catch (error) {
        if (item.urls.length > 1) log(`  ! ${url} unavailable (${error instanceof Error ? error.message : String(error)}) — trying the next mirror`);
      }
    }
    if (!done && !item.optional) throw new Error(`could not fetch ${item.dest} from any mirror`);
  }
  log(`done — .models/ and .pdfium/lib populated in ${home}`);
}
