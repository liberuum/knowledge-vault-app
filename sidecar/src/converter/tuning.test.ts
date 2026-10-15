import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { converterThreads, converterTuning, lowPriorityLaunch, physicalCores } from "./tuning.js";

describe("converter tuning", () => {
  it("gives a PDF one thread per physical core: at least one, at most sixteen, six under 12 GB", () => {
    // No physical count (Windows): half the logical cores.
    expect([1, 2, 4, 8, 12, 16, 64].map((n) => converterThreads(n))).toEqual([1, 1, 2, 4, 6, 8, 16]);
    // A Ryzen 7 5800X (16 threads, 8 cores): eight, its measured best. An M1 (8 cores, no hyper-threads).
    expect(converterThreads(16, 8, 32)).toBe(8);
    expect(converterThreads(8, 8, 16)).toBe(8);
    expect(converterThreads(8, 8, 8)).toBe(6);
    expect(converterThreads(64, 32, 128)).toBe(16);
  });

  it("counts physical cores from Linux's CPU topology, a hyper-thread once", () => {
    const sys = mkdtempSync(join(tmpdir(), "cpu-"));
    // Two cores, each with two hyper-threads, and an offline CPU with no topology.
    [["cpu0", "0"], ["cpu1", "1"], ["cpu2", "0"], ["cpu3", "1"]].forEach(([cpu, core]) => {
      mkdirSync(join(sys, cpu, "topology"), { recursive: true });
      writeFileSync(join(sys, cpu, "topology", "core_id"), `${core}\n`);
      writeFileSync(join(sys, cpu, "topology", "physical_package_id"), "0\n");
    });
    mkdirSync(join(sys, "cpu4"));
    expect(physicalCores("linux", sys)).toBe(2);
    expect(physicalCores("win32", sys)).toBeNull();
  });

  it("caps TableFormer at two threads, and never above the budget", () => {
    const env = converterTuning({ cores: 2, modelsDir: "/m", cacheDir: "/c", exists: () => false });
    expect(env).toEqual({
      DOCLING_RS_PDF_THREADS: "1",
      DOCLING_RS_TF_INTRA: "1",
      DOCLING_RS_NO_ARENA: "1",
      DOCLING_RS_GRAPH_CACHE_DIR: "/c",
      CONVERT_OCR_JOBS: "1",
      CONVERT_MODEL_SLOTS: "1",
      CONVERT_OTHER_SLOTS: "2",
      CONVERT_IDLE_RELEASE_MS: "300000",
    });
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
