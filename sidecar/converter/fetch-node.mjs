/**
 * The docling.rs model download, in Node — what `download_dependencies.sh` (v2.13.0, run with
 * `--no-asr`) does, without `sh`, `curl` or `tar`. Windows has no Unix shell, and the upstream
 * script has no Windows branch at all.
 *
 * Same files, same places (`.models/…` under DOCLING_RS_HOME), same idempotence (a file already
 * present is kept), the same progress lines the app parses (`  > dest`, `  = dest (already
 * present)`), and the same failure rules: a required file that cannot be fetched fails the run; an
 * optional one is skipped; mirrors are tried in order.
 *
 * No pdfium: docling.rs 2.x renders PDF pages itself (1.81 retired pdfium), and the 2.13 script
 * no longer fetches it. A `.pdfium/` left by an older install is unused.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MODELS_BASE_URL = "https://github.com/docling-project/docling.rs/releases/download/models-v1";

const RAPIDOCR = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2";

/** The files, in the script's order: required, mirrored (first URL that lands wins), optional. */
export function modelPlan(base = MODELS_BASE_URL) {
  return [
    { dest: ".models/layout_heron.onnx", urls: [`${base}/layout_heron.onnx`] },
    { dest: ".models/ocr_rec.onnx", urls: [`${base}/ocr_rec.onnx`] },
    { dest: ".models/ppocr_keys_v1.txt", urls: [`${base}/ppocr_keys_v1.txt`] },
    { dest: ".models/ocr_rec_en.onnx", urls: [`${base}/ocr_rec_en.onnx`, "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv3/en_PP-OCRv3_rec_infer.onnx"] },
    { dest: ".models/en_dict.txt", urls: [`${base}/en_dict.txt`, "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/en_dict.txt"] },
    { dest: ".models/ocr_det.onnx", urls: [`${base}/ocr_det.onnx`, `${RAPIDOCR}/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx`] },
    // 2.13's preferred recognizer. The script requires it; here it is optional: the Node wrapper
    // pins `ocr_rec.onnx` today, so a blocked mirror must not fail a whole install over it.
    { dest: ".models/ocr_rec_v6.onnx", urls: [`${base}/ocr_rec_v6.onnx`, `${RAPIDOCR}/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`], optional: true },
    { dest: ".models/ocr_rec_v6_dict.txt", urls: [`${base}/ocr_rec_v6_dict.txt`, `${RAPIDOCR}/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt`], optional: true },
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

/** Fetch everything into `home`. `only: <dest>` fetches just that file (the Windows CI check). */
export async function fetchModelsInNode({ home, fetchImpl = fetch, log = console.log, only, wait } = {}) {
  const at = (p) => join(home, p);
  log(`fetching docling.rs ML dependencies (Node) into ${home}`);
  const plan = only ? modelPlan().filter((item) => item.dest === only) : modelPlan();
  if (only && plan.length === 0) throw new Error(`${only} is not one of the model files`);
  for (const item of plan) {
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
  log(`done — .models/ populated in ${home}`);
}
