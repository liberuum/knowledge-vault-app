import { describe, expect, it, vi } from "vitest";
import { watchParent } from "./parent-watch.js";

describe("watchParent", () => {
  it("fires once when the parent pid changes (the engine was re-parented), never while it stays", () => {
    let ppid = 4242;
    let tick: (() => void) | undefined;
    const onGone = vi.fn();
    const setInterval = ((fn: () => void) => {
      tick = fn;
      return 1;
    }) as unknown as typeof globalThis.setInterval;
    watchParent({ getPpid: () => ppid, onGone, setInterval });
    tick!();
    tick!();
    expect(onGone).not.toHaveBeenCalled();
    ppid = 1;
    tick!();
    tick!();
    expect(onGone).toHaveBeenCalledTimes(1);
  });
});
