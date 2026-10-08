import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realProbe, sameBoot, type ProcessProbe } from "./process-identity.js";

/** Another engine holds this store (spec §9: one engine per data dir — two would corrupt PGlite). */
export class StoreInUseError extends Error {
  constructor(public readonly pid: number) {
    super(`Another Knowledge Vault engine (pid ${pid}) is using this data folder. Close it first.`);
  }
}

const lockPath = (dataDir: string) => join(dataDir, "engine.lock");

/** A recorded holder still holds the lock: same boot, alive, and — when it can be told — still an engine. */
function holds(record: { pid?: unknown; bootTime?: unknown }, self: number, probe: ProcessProbe): boolean {
  const pid = record.pid;
  if (typeof pid !== "number" || pid === self) return false;
  if (!sameBoot(record.bootTime, probe)) return false; // left by a previous boot: the pid means nothing now
  if (!probe.alive(pid)) return false;
  const cmd = probe.command(pid);
  // A command line we can read that is not an engine: the pid was reused. One we cannot read: refuse (safe side).
  return cmd === undefined || cmd.includes("main.js");
}

/**
 * Takes `engine.lock` for `pid`. A lock naming a live engine refuses; a lock left by a dead one,
 * a previous boot, or a pid now used by another program is replaced. Returns the release.
 */
export function acquireEngineLock(dataDir: string, pid: number, probe: ProcessProbe = realProbe): () => void {
  mkdirSync(dataDir, { recursive: true });
  const record = JSON.stringify({ pid, bootTime: probe.bootTime(), startedAt: new Date().toISOString() }) + "\n";
  try {
    writeFileSync(lockPath(dataDir), record, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let existing: { pid?: unknown; bootTime?: unknown } = {};
    try {
      existing = JSON.parse(readFileSync(lockPath(dataDir), "utf8")) as typeof existing;
    } catch {
      existing = {};
    }
    if (holds(existing, pid, probe)) throw new StoreInUseError(existing.pid as number);
    writeFileSync(lockPath(dataDir), record);
  }
  return () => {
    try {
      const held = (JSON.parse(readFileSync(lockPath(dataDir), "utf8")) as { pid?: number }).pid;
      if (held === pid) rmSync(lockPath(dataDir), { force: true });
    } catch {
      // already gone
    }
  };
}

/**
 * Takes the lock, waiting for a holder that is on its way out: the previous engine of an app that was
 * just closed (or restarted) can need a few seconds to flush and exit — on Windows a quit did not
 * always wait for it. A holder still alive after `waitMs` is a real second engine: refused.
 */
export async function acquireEngineLockWaiting(
  dataDir: string,
  pid: number,
  opts: { waitMs?: number; pollMs?: number; probe?: ProcessProbe; sleep?: (ms: number) => Promise<void>; now?: () => number; onWait?: (holder: number) => void } = {},
): Promise<() => void> {
  const waitMs = opts.waitMs ?? 30_000;
  const pollMs = opts.pollMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const until = now() + waitMs;
  let told = false;
  for (;;) {
    try {
      return acquireEngineLock(dataDir, pid, opts.probe);
    } catch (error) {
      if (!(error instanceof StoreInUseError) || now() >= until) throw error;
      if (!told) {
        opts.onWait?.(error.pid);
        told = true;
      }
      await sleep(pollMs);
    }
  }
}
