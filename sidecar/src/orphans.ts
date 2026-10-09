import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realProbe, sameBoot, type ProcessProbe } from "./process-identity.js";

/**
 * The converter helper is the engine's child; an engine that dies by SIGKILL leaves it
 * running. Its pid and boot are recorded when it starts, and the next engine stops a
 * recorded helper — only if it is provably that helper — before starting its own.
 */
const pidPath = (dataDir: string) => join(dataDir, "converter", "helper.pid");

export function writeHelperPid(dataDir: string, pid: number, bootTime: () => number = realProbe.bootTime): void {
  mkdirSync(join(dataDir, "converter"), { recursive: true });
  writeFileSync(pidPath(dataDir), JSON.stringify({ pid, bootTime: bootTime() }) + "\n");
}
export function clearHelperPid(dataDir: string): void {
  rmSync(pidPath(dataDir), { force: true });
}
function readRecord(dataDir: string): { pid: number; bootTime?: unknown } | undefined {
  if (!existsSync(pidPath(dataDir))) return undefined;
  try {
    const r = JSON.parse(readFileSync(pidPath(dataDir), "utf8")) as { pid?: unknown; bootTime?: unknown };
    return typeof r.pid === "number" && Number.isInteger(r.pid) && r.pid > 0 ? { pid: r.pid, bootTime: r.bootTime } : undefined;
  } catch {
    return undefined;
  }
}
export function readHelperPid(dataDir: string): number | undefined {
  return readRecord(dataDir)?.pid;
}

/**
 * Stops a recorded helper that is still running; forgets the record either way. A pid from
 * another boot, one now running another program, or one whose command line cannot be read
 * is never signalled. Returns the pid it stopped.
 */
export function stopOrphanedHelper(dataDir: string, deps: Partial<ProcessProbe> & { kill?: (pid: number) => void } = {}): number | undefined {
  const probe: ProcessProbe = { ...realProbe, ...deps };
  const record = readRecord(dataDir);
  clearHelperPid(dataDir);
  if (!record) return undefined;
  if (!sameBoot(record.bootTime, probe) || !probe.alive(record.pid)) return undefined;
  const cmd = probe.command(record.pid);
  if (!cmd || !cmd.replaceAll("\\", "/").includes("converter/server")) return undefined; // Windows paths use backslashes
  const kill = deps.kill ?? ((p: number) => process.kill(p, "SIGTERM"));
  try {
    kill(record.pid);
  } catch {
    return undefined;
  }
  return record.pid;
}
