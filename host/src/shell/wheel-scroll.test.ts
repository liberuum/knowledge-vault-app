import { describe, expect, it } from "vitest";
import { easeStep, WHEEL_SCALE, wheelAt, type ScrollMetrics } from "./wheel-scroll.js";

const list = (pos: number, over: Partial<ScrollMetrics> = {}): ScrollMetrics => ({
  overflow: "auto", overscroll: "auto", pos, size: 1000, client: 400, ...over,
});

describe("wheel scrolling on the Linux desktop", () => {
  it("moves the innermost list that can still go that way, chains outward at its ends, and stops where it is told to", () => {
    expect(wheelAt(list(100), 90)).toBe("scroll");
    expect(wheelAt(list(600), 90)).toBe("pass"); // at the bottom: the wheel goes to what holds it
    expect(wheelAt(list(0), -90)).toBe("pass"); // at the top, going up
    expect(wheelAt(list(600, { overscroll: "contain" }), 90)).toBe("stop"); // keeps the wheel to itself
    expect(wheelAt(list(0, { overflow: "hidden" }), 90)).toBe("pass"); // does not scroll
    expect(wheelAt(list(0, { size: 400 }), 90)).toBe("pass"); // nothing to scroll
  });

  it("moves half of WebKit's reported notch, eased in over a few frames that land exactly", () => {
    expect(180 * WHEEL_SCALE).toBe(90);
    let left = 90;
    let moved = 0;
    let frames = 0;
    while (left !== 0 && frames < 60) {
      const { step, left: rest } = easeStep(left);
      moved += step;
      left = rest;
      frames += 1;
    }
    expect(moved).toBeCloseTo(90, 6);
    expect(frames).toBeGreaterThan(3);
    expect(frames).toBeLessThan(15);
    expect(easeStep(-0.5)).toEqual({ step: -0.5, left: 0 });
  });
});
