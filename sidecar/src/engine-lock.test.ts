import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireEngineLock, StoreInUseError } from "./engine-lock.js";

const engine = { alive: () => true, command: () => "node /app/sidecar/dist/main.js", bootTime: () => 1_000_000 };
describe("engine lock", () => {
  it("takes the lock, refuses a live engine holding it, replaces a dead one, and releases", () => {
    const d = mkdtempSync(join(tmpdir(), "kv-lock-"));
    const release = acquireEngineLock(d, process.pid, engine);
    expect(JSON.parse(readFileSync(join(d, "engine.lock"), "utf8"))).toMatchObject({ pid: process.pid, bootTime: 1_000_000 });
    expect(() => acquireEngineLock(d, 424242, engine)).toThrow(StoreInUseError);
    release();
    writeFileSync(join(d, "engine.lock"), JSON.stringify({ pid: 999999, bootTime: 1_000_000 }));
    acquireEngineLock(d, process.pid, { ...engine, alive: () => false })();
  });
  it("does not trust a pid from another boot, or one that is now another program (I2)", () => {
    const d = mkdtempSync(join(tmpdir(), "kv-lock-"));
    writeFileSync(join(d, "engine.lock"), JSON.stringify({ pid: 4242, bootTime: 500_000 })); // before a reboot
    acquireEngineLock(d, process.pid, engine)();
    writeFileSync(join(d, "engine.lock"), JSON.stringify({ pid: 4242, bootTime: 1_000_000 }));
    acquireEngineLock(d, process.pid, { ...engine, command: () => "/usr/bin/firefox" })(); // the pid was reused
    writeFileSync(join(d, "engine.lock"), JSON.stringify({ pid: 4242, bootTime: 1_000_000 }));
    expect(() => acquireEngineLock(d, process.pid, { ...engine, command: () => undefined })).toThrow(StoreInUseError); // cannot tell: refuse
  });
});

describe("taking the lock while a previous engine stops", () => {
  it("waits for a holder that exits, and refuses one that stays", async () => {
    const { acquireEngineLockWaiting, StoreInUseError } = await import("./engine-lock.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "kv-lock-wait-"));
    writeFileSync(join(dir, "engine.lock"), JSON.stringify({ pid: 777, bootTime: 1000 }));
    let alive = true;
    let clock = 0;
    const probe = { alive: (p: number) => p === 777 && alive, command: () => "node sidecar/dist/main.js", bootTime: () => 1000 };
    const waited: number[] = [];
    // the holder exits after three polls
    let polls = 0;
    const release = await acquireEngineLockWaiting(dir, 42, { probe, waitMs: 30_000, pollMs: 1000, now: () => clock, sleep: async (ms) => { clock += ms; if (++polls === 3) alive = false; }, onWait: (h) => waited.push(h) });
    expect(waited).toEqual([777]);
    expect(polls).toBe(3);
    release();
    // a holder that never exits: refused after the wait
    writeFileSync(join(dir, "engine.lock"), JSON.stringify({ pid: 777, bootTime: 1000 }));
    alive = true;
    clock = 0;
    await expect(acquireEngineLockWaiting(dir, 42, { probe, waitMs: 5_000, pollMs: 1000, now: () => clock, sleep: async (ms) => { clock += ms; } })).rejects.toBeInstanceOf(StoreInUseError);
  });
});
