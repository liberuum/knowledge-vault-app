import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { descendantsOf, parsePs, reapChildren } from "./child-reaper.js";

describe("child reaper", () => {
  it("finds the engine's children and grandchildren, not its siblings", () => {
    const table: Array<[number, number]> = [[100, 1], [101, 100], [102, 100], [103, 102], [200, 1]];
    expect(descendantsOf(100, table).sort()).toEqual([101, 102, 103]);
  });
  it("parses ps output and skips headers and blanks", () => {
    expect(parsePs("  100     1\n  101   100\nPID PPID\n\n")).toEqual([[100, 1], [101, 100]]);
  });
  it("kills only the descendants of itself, and does nothing on Windows", () => {
    const kill = vi.fn();
    const ps = () => "100 1\n101 100\n102 101\n300 1\n";
    expect(reapChildren({ platform: "linux", ps, kill, self: 100 })).toEqual([101, 102]);
    expect(kill.mock.calls.map((c) => c[0])).toEqual([101, 102]);
    expect(reapChildren({ platform: "win32", ps, kill, self: 100 })).toEqual([]);
  });
  it("survives ps failing", () => {
    expect(reapChildren({ platform: "linux", ps: () => { throw new Error("no ps"); }, kill: vi.fn(), self: 1 })).toEqual([]);
  });

  // A real process tree on this machine — the same `ps` and signals the engine uses (Linux and macOS).
  it.skipIf(process.platform === "win32")("ends a real grandchild with the real ps", async () => {
    const parent = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    const victims = reapChildren({ self: parent.pid! });
    expect(victims.length).toBe(2);
    await new Promise((r) => setTimeout(r, 300));
    const alive = victims.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    expect(alive).toEqual([]);
    parent.kill("SIGKILL");
  });
});
