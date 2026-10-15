import { isTauri } from "./tauri.js";

/**
 * Linux desktop: the mouse wheel moves the page its full distance, however fast it turns.
 *
 * WebKitGTK loses most of a fast wheel on Wayland. Measured in this app on Hyprland (WebKitGTK 2.52):
 * a single notch moves a list its full 180 px, but in a quick spin — 40 to 80 events a second, each
 * reporting its 180 px — the list moved a pixel or two per event. The events are right; WebKit's own
 * scrolling drops them when they come fast, and turning its smooth scrolling off did not change that.
 * Browsers on the same machine move the full distance, as does WebKit on macOS and Windows.
 *
 * So on Linux the shell moves the page itself, to what is under the pointer and can still scroll that
 * way: the innermost first, then outward, as a browser chains them, stopping where `overscroll-behavior`
 * says so. Each notch moves about a browser's distance — WebKitGTK reports 180 px for one; the page
 * moves 90 — and eases there over a few frames; a fast spin adds to the
 * distance still to go, so nothing is dropped and the page keeps up. Whatever handles the wheel itself —
 * the graph's zoom, the workflow canvas — cancels the event before this listener (on the window, so
 * last) sees it, and is left alone; so is Ctrl+wheel (zoom).
 */

/** A WebKit "line" (deltaMode 1), in pixels. */
const LINE_PX = 40;
/** How much of WebKit's reported distance the page moves: 180 px a notch becomes 90 (tuned by hand on Hyprland). */
export const WHEEL_SCALE = 1 / 2;
/** The share of the distance still to go that each frame covers: a notch eases in over ~120 ms. */
const EASE = 0.35;

type Axis = "x" | "y";

export type ScrollMetrics = {
  /** The computed `overflow-x` / `overflow-y`. */
  overflow: string;
  /** `overscroll-behavior` on that axis. */
  overscroll: string;
  /** scrollTop / scrollLeft */
  pos: number;
  /** scrollHeight / scrollWidth */
  size: number;
  /** clientHeight / clientWidth */
  client: number;
};

/**
 * What the wheel does at one element, for a delta on one axis: move it, stop here without moving
 * anything (a scroll container at its end that keeps the wheel to itself), or pass on outward.
 */
export function wheelAt(m: ScrollMetrics, delta: number): "scroll" | "stop" | "pass" {
  const scrolls = /^(auto|scroll|overlay)$/.test(m.overflow) && m.size - m.client >= 1;
  if (!scrolls) return "pass";
  const canMove = delta > 0 ? m.pos + m.client < m.size - 0.5 : m.pos > 0.5;
  if (canMove) return "scroll";
  return m.overscroll === "contain" || m.overscroll === "none" ? "stop" : "pass";
}

function metrics(el: Element, axis: Axis): ScrollMetrics {
  const style = getComputedStyle(el);
  return axis === "y"
    ? { overflow: style.overflowY, overscroll: style.overscrollBehaviorY, pos: el.scrollTop, size: el.scrollHeight, client: el.clientHeight }
    : { overflow: style.overflowX, overscroll: style.overscrollBehaviorX, pos: el.scrollLeft, size: el.scrollWidth, client: el.clientWidth };
}

/** The element the wheel should move; `null` when nothing should, `undefined` when it is left to WebKit. */
function scrollerFor(target: EventTarget | null, axis: Axis, delta: number): Element | null | undefined {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el === document.scrollingElement) break;
    const at = wheelAt(metrics(el, axis), delta);
    if (at === "scroll") return el;
    if (at === "stop") return null;
  }
  const root = document.scrollingElement;
  if (!root) return undefined;
  // The document scrolls with any overflow but hidden.
  const m = metrics(root, axis);
  const at = wheelAt({ ...m, overflow: m.overflow === "hidden" ? "hidden" : "auto" }, delta);
  return at === "scroll" ? root : undefined;
}

/**
 * One frame of an eased scroll: the step to take now, and what is left after it. The last pixel is
 * taken whole, so the page lands exactly.
 */
export function easeStep(remaining: number): { step: number; left: number } {
  if (Math.abs(remaining) <= 1) return { step: remaining, left: 0 };
  const step = remaining * EASE;
  const sure = Math.abs(step) < 1 ? Math.sign(remaining) : step;
  return { step: sure, left: remaining - sure };
}

/** Install once, before anything renders; a no-op everywhere but the Linux desktop app. */
export function installWheelScroll(): () => void {
  if (typeof window === "undefined" || !isTauri()) return () => {};
  if (!/Linux/.test(navigator.userAgent) || /Android/.test(navigator.userAgent)) return () => {};
  const instant = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  /** The distance still to go, per element. */
  const pending = new Map<Element, { x: number; y: number }>();
  let frame = 0;
  const tick = () => {
    frame = 0;
    for (const [el, d] of pending) {
      for (const axis of ["y", "x"] as const) {
        if (!d[axis]) continue;
        const { step, left } = instant ? { step: d[axis], left: 0 } : easeStep(d[axis]);
        const before = axis === "y" ? el.scrollTop : el.scrollLeft;
        if (axis === "y") el.scrollTop = before + step;
        else el.scrollLeft = before + step;
        const moved = (axis === "y" ? el.scrollTop : el.scrollLeft) !== before;
        // At an end the rest has nowhere to go.
        d[axis] = moved ? left : 0;
      }
      if (!d.x && !d.y) pending.delete(el);
    }
    if (pending.size > 0) frame = requestAnimationFrame(tick);
  };
  const onWheel = (e: WheelEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey) return;
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? window.innerHeight : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    // Shift+wheel scrolls sideways.
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    const axis: Axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
    const delta = (axis === "y" ? dy : dx) * WHEEL_SCALE;
    if (delta === 0) return;
    const el = scrollerFor(e.target, axis, delta);
    if (el === undefined) return;
    e.preventDefault();
    if (el === null) return;
    const d = pending.get(el) ?? { x: 0, y: 0 };
    if (axis === "y") d.y += delta;
    else d.x += delta;
    pending.set(el, d);
    if (!frame) frame = requestAnimationFrame(tick);
  };
  window.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    window.removeEventListener("wheel", onWheel);
    if (frame) cancelAnimationFrame(frame);
  };
}
