import { describe, expect, it } from "vitest";
import { detectGraphicsMemory } from "./gpu.js";

const GiB = 1024 ** 3;
const noNvidia = (file: string) => (file === "nvidia-smi" ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) : undefined);

describe("detectGraphicsMemory", () => {
  it("Windows: keeps what reg.exe printed when it exits 1 on a SYSTEM-only key; integrated graphics counts as none", async () => {
    const out = "HKEY_LOCAL_MACHINE\\...\\0000\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x400000000\r\nERROR: Access is denied.\r\n";
    const exitOne = (file: string) => noNvidia(file) ?? Promise.reject(Object.assign(new Error("Command failed"), { code: 1, stdout: out }));
    expect(await detectGraphicsMemory("win32", "x64", exitOne, 32 * GiB)).toEqual({ kind: "dedicated", bytes: 16 * GiB, name: null });
    const igpu = "    HardwareInformation.qwMemorySize    REG_QWORD    0x8000000\r\n"; // 128 MB
    const small = (file: string) => noNvidia(file) ?? Promise.resolve({ stdout: igpu });
    expect(await detectGraphicsMemory("win32", "x64", small, 16 * GiB)).toMatchObject({ kind: "none" });
  });
  it("Apple silicon: the share macOS gives the GPU, in whole GB", async () => {
    const none = (file: string) => noNvidia(file)!;
    expect((await detectGraphicsMemory("darwin", "arm64", none, 16 * GiB)).bytes).toBe(10 * GiB);
    expect((await detectGraphicsMemory("darwin", "arm64", none, 36 * GiB)).bytes).toBe(27 * GiB);
  });
});
