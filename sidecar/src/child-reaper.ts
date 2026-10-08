import { execFileSync } from "node:child_process";

/**
 * The engine's workers (the workflow runtime's piece workers, the conversion helper) must not
 * outlive it: an orphan keeps running the old code, and under an AppImage it crashes (SIGBUS) once
 * the image is unmounted. On exit the engine ends whatever it started that is still alive. The shell
 * does the same from outside (proc_tree.rs); this covers an engine stopped any other way.
 */
export function descendantsOf(root: number, table: ReadonlyArray<readonly [number, number]>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.pop()!;
    for (const k of children.get(p) ?? []) {
      if (k !== root && !out.includes(k)) {
        out.push(k);
        queue.push(k);
      }
    }
  }
  return out;
}

export function parsePs(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const line of text.split("\n")) {
    const [a, b] = line.trim().split(/\s+/);
    const pid = Number(a);
    const ppid = Number(b);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && a && b) out.push([pid, ppid]);
  }
  return out;
}

/** Synchronous, for the `exit` event: SIGKILL every descendant still alive. Unix only. */
export function reapChildren(opts: { platform?: NodeJS.Platform; ps?: () => string; kill?: (pid: number) => void; self?: number } = {}): number[] {
  if ((opts.platform ?? process.platform) === "win32") return [];
  const ps = opts.ps ?? (() => execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" }));
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  let table: Array<[number, number]>;
  try {
    table = parsePs(ps());
  } catch {
    return [];
  }
  const victims = descendantsOf(opts.self ?? process.pid, table);
  for (const pid of victims) {
    try {
      kill(pid);
    } catch {
      // already gone
    }
  }
  return victims;
}
