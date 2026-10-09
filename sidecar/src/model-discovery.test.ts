import { describe, expect, it } from "vitest";
import { modelSizeHint, parseNvidiaSmi, parseRegistryMemory } from "./gpu.js";
import { parseLsof, parseNetstat, parseProcNetTcp } from "./model-discovery.js";

describe("finding local model servers and graphics memory", () => {
  it("reads listening loopback ports on Linux, macOS and Windows", () => {
    const proc = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1F94 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1", // 127.0.0.1:8084 LISTEN
      "   1: 00000000:2CAA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2", // 0.0.0.0:11434 LISTEN
      "   2: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 3", // established, not listening
      "   3: 0A00020F:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4", // 15.2.0.10:22 — not loopback
    ].join("\n");
    expect(parseProcNetTcp(proc).sort((a, b) => a - b)).toEqual([8084, 11434]);
    expect(parseLsof("p123\nn127.0.0.1:1234\nn*:11434\nn192.168.1.4:22\nn[::1]:8080\n").sort((a, b) => a - b)).toEqual([11434, 1234, 8080].sort((a, b) => a - b));
    expect(parseNetstat("  TCP    127.0.0.1:1234     0.0.0.0:0   LISTENING   42\n  TCP    10.0.0.4:445   0.0.0.0:0   LISTENING   4\n  TCP    [::]:11434   [::]:0   LISTENING   7\n").sort((a, b) => a - b)).toEqual([11434, 1234].sort((a, b) => a - b));
  });

  it("reads graphics memory from nvidia-smi and the Windows registry, and says what runs well", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4070, 12282\nNVIDIA GeForce RTX 4090, 24564\n")).toEqual({ kind: "dedicated", bytes: 24564 * 1024 ** 2, name: "NVIDIA GeForce RTX 4090" });
    expect(parseRegistryMemory("    HardwareInformation.qwMemorySize    REG_QWORD    0x400000000\n")).toBe(16 * 1024 ** 3);
    expect(modelSizeHint({ kind: "dedicated", bytes: 16 * 1024 ** 3, name: null })).toBe("16 GB of graphics memory: models up to about 20B run well, such as gpt-oss-20b or Qwen3 14B.");
    expect(modelSizeHint({ kind: "none", bytes: 32 * 1024 ** 3, name: null })).toMatch(/^No graphics card found/);
  });
  it("reads listening ports from a translated netstat (the State column is localized, the foreign address is not)", () => {
    const german = "\r\nAktive Verbindungen\r\n\r\n  Proto  Lokale Adresse         Remoteadresse          Status           PID\r\n  TCP    0.0.0.0:11434          0.0.0.0:0              ABH\u00d6REN        4242\r\n  TCP    [::1]:1234             [::]:0                 ABH\u00d6REN        77\r\n  TCP    127.0.0.1:50000        127.0.0.1:50001        HERGESTELLT      9\r\n";
    expect(parseNetstat(german).sort((a, b) => a - b)).toEqual([1234, 11434]);
  });
});
