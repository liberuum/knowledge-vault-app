import { describe, expect, it } from "vitest";
import { converterThreads, converterTuning, lowPriorityLaunch } from "./tuning.js";

describe("converter tuning", () => {
  it("gives a PDF half the cores — never all of them, at least one, at most eight", () => {
    expect([1, 2, 4, 8, 12, 16, 64].map(converterThreads)).toEqual([1, 1, 2, 4, 6, 8, 8]);
  });

  it("caps TableFormer at two threads, and never above the budget", () => {
    const env = converterTuning({ cores: 2, modelsDir: "/m", cacheDir: "/c", exists: () => false });
    expect(env).toEqual({ DOCLING_RS_PDF_THREADS: "1", DOCLING_RS_TF_INTRA: "1", DOCLING_RS_NO_ARENA: "1", DOCLING_RS_GRAPH_CACHE_DIR: "/c", CONVERT_OCR_JOBS: "1" });
  });

  it("uses the KV-cache decoder only when both of its files are there", () => {
    const kv = "/m/.models/tableformer/decoder_kv.onnx";
    expect(converterTuning({ cores: 8, modelsDir: "/m", cacheDir: "/c", exists: (p) => p === kv || p === `${kv}.data` }).DOCLING_TABLEFORMER_DECODER).toBe(kv);
    expect(converterTuning({ cores: 8, modelsDir: "/m", cacheDir: "/c", exists: (p) => p === kv }).DOCLING_TABLEFORMER_DECODER).toBeUndefined();
  });

  it("starts through nice on macOS and Linux, and renices afterwards where there is none", () => {
    const has = (p: string) => p === "/usr/bin/nice";
    expect(lowPriorityLaunch("darwin", "/n/node", ["a"], has)).toEqual({ cmd: "/usr/bin/nice", args: ["-n", "10", "/n/node", "a"], reniceAfterSpawn: false });
    expect(lowPriorityLaunch("linux", "/n/node", ["a"], (p) => p === "/bin/nice")).toEqual({ cmd: "/bin/nice", args: ["-n", "10", "/n/node", "a"], reniceAfterSpawn: false });
    expect(lowPriorityLaunch("linux", "/n/node", ["a"], () => false)).toEqual({ cmd: "/n/node", args: ["a"], reniceAfterSpawn: true });
    expect(lowPriorityLaunch("win32", "C:\\node.exe", ["a"], () => true)).toEqual({ cmd: "C:\\node.exe", args: ["a"], reniceAfterSpawn: true });
  });
});
