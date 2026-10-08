import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GiB = 1024 ** 3;

/** How much memory a local model can run in (spec decision 2): the graphics card's, Apple silicon's shared memory, or none. */
export type GraphicsMemory = { kind: "dedicated" | "unified" | "none"; bytes: number; name: string | null };

const VENDORS: Record<string, string> = { "0x1002": "AMD", "0x10de": "NVIDIA", "0x8086": "Intel" };

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: "NVIDIA GeForce RTX 4090, 24564" (MiB). */
export function parseNvidiaSmi(text: string): GraphicsMemory | null {
  let best: GraphicsMemory | null = null;
  for (const line of text.split("\n")) {
    const m = /^(.+?),\s*(\d+)\s*$/.exec(line.trim());
    if (!m) continue;
    const bytes = Number(m[2]) * 1024 ** 2;
    if (!best || bytes > best.bytes) best = { kind: "dedicated", bytes, name: m[1]!.trim() };
  }
  return best;
}

/** Windows: the display adapters' 64-bit memory size from the registry (WMI's AdapterRAM stops at 4 GB). */
export function parseRegistryMemory(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(/HardwareInformation\.qwMemorySize\s+REG_QWORD\s+0x([0-9a-f]+)/gi)) {
    const bytes = Number.parseInt(m[1]!, 16);
    if (Number.isFinite(bytes) && (best === null || bytes > best)) best = bytes;
  }
  return best;
}

/** Linux: /sys/class/drm/card<n>/device/mem_info_vram_total (AMD, Intel discrete). */
function linuxVram(root = "/sys/class/drm"): GraphicsMemory | null {
  let best: GraphicsMemory | null = null;
  try {
    for (const card of readdirSync(root)) {
      if (!/^card\d+$/.test(card)) continue;
      const file = join(root, card, "device", "mem_info_vram_total");
      if (!existsSync(file)) continue;
      const bytes = Number(readFileSync(file, "utf8").trim());
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      let vendor: string | null = null;
      try {
        vendor = VENDORS[readFileSync(join(root, card, "device", "vendor"), "utf8").trim()] ?? null;
      } catch {
        vendor = null;
      }
      if (!best || bytes > best.bytes) best = { kind: "dedicated", bytes, name: vendor ? `${vendor} graphics` : null };
    }
  } catch {
    return null;
  }
  return best;
}

export async function detectGraphicsMemory(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Promise<GraphicsMemory> {
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 4000, windowsHide: true });
    const nvidia = parseNvidiaSmi(stdout);
    if (nvidia) return nvidia;
  } catch {
    // no NVIDIA driver
  }
  if (platform === "linux") {
    const vram = linuxVram();
    if (vram) return vram;
  }
  if (platform === "darwin" && arch === "arm64") return { kind: "unified", bytes: Math.round(totalmem() * 0.75), name: "Apple silicon" };
  if (platform === "win32") {
    try {
      const { stdout } = await run(
        "reg",
        ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}", "/s", "/v", "HardwareInformation.qwMemorySize"],
        { timeout: 6000, windowsHide: true },
      );
      const bytes = parseRegistryMemory(stdout);
      if (bytes) return { kind: "dedicated", bytes, name: null };
    } catch {
      // no readable adapter key
    }
  }
  return { kind: "none", bytes: totalmem(), name: null };
}

/** One plain sentence: what this machine runs well (a small table, updated with releases). */
export function modelSizeHint(mem: GraphicsMemory): string {
  const gb = Math.round(mem.bytes / GiB);
  if (mem.kind === "none") return `No graphics card found: a small model (about 3B) runs on the processor, slowly. A hosted model will answer much faster.`;
  const lead = mem.kind === "unified" ? `${gb} GB of memory the graphics can use` : `${gb} GB of graphics memory`;
  if (gb >= 40) return `${lead}: models up to about 70B run well.`;
  if (gb >= 22) return `${lead}: models up to about 32B run well, such as Qwen3 32B.`;
  if (gb >= 15) return `${lead}: models up to about 20B run well, such as gpt-oss-20b or Qwen3 14B.`;
  if (gb >= 11) return `${lead}: models up to about 14B run well, such as Qwen3 14B.`;
  if (gb >= 7) return `${lead}: models up to about 8B run well, such as Qwen3 8B.`;
  return `${lead}: small models of about 3–4B, such as Qwen3 4B, run well.`;
}
