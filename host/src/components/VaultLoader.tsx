import { useEffect, useRef, useState, type ReactNode } from "react";
import "./loader.css";

/**
 * The app's loading state: a small vault graph whose hub reaches out to its notes one at a
 * time, a light running along each link and the note lighting as it arrives, while the whole
 * constellation drifts. It says what is opening, and after a while why it is still waiting.
 *
 * One clock for every loader, so a wait that passes from one screen to the next (the remote
 * vault looked up, then its drive followed, then the app loaded) reads as one continuous load:
 * the graph carries on where it was and does not fade in twice. The vault package draws the
 * same loader once it has loaded (bai-knowledge-note `editors/shared/vault-loader.tsx`, its
 * access check comes next) and reads the same clock from `globalThis`, so the hand-over from
 * this app to the vault is seamless too. Keep the geometry and timing of the two in step.
 */

type Node = { x: number; y: number; r: number; kind: "hub" | "note" | "leaf"; parent?: number };

// Hand-placed in a 160×120 box: a MoC hub, seven notes around it, three leaves further out.
const NODES: readonly Node[] = [
  { x: 80, y: 60, r: 6.5, kind: "hub" },
  { x: 82, y: 19, r: 3.0, kind: "note" },
  { x: 121, y: 33, r: 4.0, kind: "note" },
  { x: 133, y: 71, r: 3.1, kind: "note" },
  { x: 105, y: 98, r: 3.6, kind: "note" },
  { x: 59, y: 96, r: 3.0, kind: "note" },
  { x: 27, y: 73, r: 3.2, kind: "note" },
  { x: 44, y: 36, r: 3.6, kind: "note" },
  { x: 146, y: 21, r: 2.4, kind: "leaf", parent: 2 },
  { x: 17, y: 27, r: 2.4, kind: "leaf", parent: 7 },
  { x: 127, y: 110, r: 2.2, kind: "leaf", parent: 4 },
];
/** The notes in the order the hub reaches them: clockwise from the top. */
const ORDER = [1, 2, 3, 4, 5, 6, 7] as const;
const SPOKES = ORDER.map((n) => [0, n] as const);
const CROSS = [[1, 2], [3, 4], [4, 5], [6, 7]] as const;
const LEAVES = NODES.flatMap((n, i) => (n.parent === undefined ? [] : [[n.parent, i] as const]));
const EDGES = [...SPOKES, ...CROSS, ...LEAVES];

const STEP = 0.6; // s between reaches
const TRAVEL = 0.42; // s for the light to run hub → note
const LEAF_TRAVEL = 0.3; // s note → leaf
const RISE = 0.1;
const DECAY = 0.55;
const STEP_STILL = 1.0; // reduced motion: a slower glow, nothing moves

const mod = (a: number, n: number) => ((a % n) + n) % n;
const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
/** A light's brightness s seconds after it arrived: a quick rise, a slow fade. */
const glow = (s: number) => (s < RISE ? s / RISE : Math.exp(-(s - RISE) / DECAY));

/** `onScreen` is optional: an older copy of the other side may have made the clock without it. */
type Clock = { epoch: number | null; lastShownAt: number; onScreen?: number };
/** Shared with the vault package's copy, so the two read as one load. */
function clock(): Clock {
  const g = globalThis as unknown as { __vaultLoaderClock?: Clock };
  g.__vaultLoaderClock ??= { epoch: null, lastShownAt: -Infinity, onScreen: 0 };
  return g.__vaultLoaderClock;
}
const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());

function prefersStill(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The graph alone, for places that want it without words. */
export function VaultLoaderGraph({ className }: { className?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const root = svg.current;
    if (!root || typeof requestAnimationFrame !== "function") return;
    const q = (sel: string) => Array.from(root.querySelectorAll<SVGElement>(sel));
    const base = q(".kv-l-node");
    const lit = q(".kv-l-lit");
    const edges = q(".kv-l-edge");
    const glows = q(".kv-l-edge-lit");
    const heads = q(".kv-l-head");
    const headHalos = q(".kv-l-head-halo");
    const halos = q(".kv-l-halo");
    const hubHalo = root.querySelector<SVGElement>(".kv-l-hub-halo") ?? undefined;
    const c = clock();
    c.epoch ??= now();
    const epoch = c.epoch;
    let still = prefersStill();
    const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    const onMedia = () => (still = prefersStill());
    media?.addEventListener("change", onMedia);
    const x = new Float64Array(NODES.length);
    const y = new Float64Array(NODES.length);
    const light = new Float64Array(NODES.length);
    let frame = 0;
    const set = (el: SVGElement | undefined, attrs: Record<string, number>) => {
      if (!el) return;
      for (const k in attrs) el.setAttribute(k, attrs[k]!.toFixed(2));
    };
    const tick = () => {
      const t = (now() - epoch) / 1000;
      const step = still ? STEP_STILL : STEP;
      const cycle = ORDER.length * step;
      const travel = still ? 0 : TRAVEL;
      const leafTravel = still ? 0 : LEAF_TRAVEL;
      // Where each node is: a slow drift, each on its own period.
      NODES.forEach((n, i) => {
        const a = still ? 0 : n.kind === "hub" ? 1.6 : n.kind === "leaf" ? 5 : 4.2;
        const px = 5.5 + ((i * 1.37) % 3.5);
        const py = 6.2 + ((i * 2.11) % 3.1);
        x[i] = n.x + a * Math.sin((2 * Math.PI * t) / px + i * 1.9);
        y[i] = n.y + a * Math.sin((2 * Math.PI * t) / py + i * 2.5);
        light[i] = 0;
      });
      let head = -1;
      let leafHead = -1;
      // Spokes: the light runs out from the hub, then the note glows.
      ORDER.forEach((n, k) => {
        const u = mod(t - k * step, cycle);
        const e = k; // spoke k is edge k
        const g = glows[e];
        if (u < travel) {
          const f = ease(u / travel);
          const hx = x[0]! + (x[n]! - x[0]!) * f;
          const hy = y[0]! + (y[n]! - y[0]!) * f;
          set(g, { x1: x[0]!, y1: y[0]!, x2: hx, y2: hy, "stroke-opacity": 1 });
          set(heads[0], { cx: hx, cy: hy, opacity: 1 });
          set(headHalos[0], { cx: hx, cy: hy, opacity: 1 });
          head = n;
        } else {
          set(g, { x1: x[0]!, y1: y[0]!, x2: x[n]!, y2: y[n]!, "stroke-opacity": glow(u - travel) * (still ? 0.8 : 0.9) });
        }
        light[n] = glow(mod(t - k * step - travel, cycle));
        // The note's leaf, if it has one: the light carries on, a beat later.
        const leaf = NODES.findIndex((m) => m.parent === n);
        if (leaf >= 0) {
          const v = mod(t - k * step - travel, cycle);
          const le = SPOKES.length + CROSS.length + LEAVES.findIndex(([, b]) => b === leaf);
          if (v < leafTravel) {
            const f = ease(v / leafTravel);
            const hx = x[n]! + (x[leaf]! - x[n]!) * f;
            const hy = y[n]! + (y[leaf]! - y[n]!) * f;
            set(glows[le], { x1: x[n]!, y1: y[n]!, x2: hx, y2: hy, "stroke-opacity": 1 });
            set(heads[1], { cx: hx, cy: hy, opacity: 1 });
            set(headHalos[1], { cx: hx, cy: hy, opacity: 1 });
            leafHead = leaf;
          } else {
            set(glows[le], { x1: x[n]!, y1: y[n]!, x2: x[leaf]!, y2: y[leaf]!, "stroke-opacity": glow(v - leafTravel) * 0.85 });
          }
          light[leaf] = glow(mod(t - k * step - travel - leafTravel, cycle));
        }
      });
      for (const [i, on] of [head >= 0, leafHead >= 0].entries()) {
        if (on) continue;
        heads[i]?.setAttribute("opacity", "0");
        headHalos[i]?.setAttribute("opacity", "0");
      }
      // Links between neighbours glow while both ends are lit: the light passes round the ring.
      CROSS.forEach(([a, b], c) => {
        set(glows[SPOKES.length + c], { x1: x[a]!, y1: y[a]!, x2: x[b]!, y2: y[b]!, "stroke-opacity": 0.8 * Math.sqrt(light[a]! * light[b]!) });
      });
      EDGES.forEach(([a, b], e) => set(edges[e], { x1: x[a]!, y1: y[a]!, x2: x[b]!, y2: y[b]! }));
      // The hub swells a little each time it reaches out.
      const since = mod(t, step);
      const swell = still ? 0 : since < 0.08 ? since / 0.08 : Math.exp(-(since - 0.08) / 0.18);
      NODES.forEach((n, i) => {
        const r = n.kind === "hub" ? n.r * (1 + 0.14 * swell) : n.r;
        set(base[i], { cx: x[i]!, cy: y[i]!, r });
        if (i > 0) {
          set(lit[i - 1], { cx: x[i]!, cy: y[i]!, r: n.r * (1 + 0.3 * light[i]!), "fill-opacity": light[i]! });
          set(halos[i - 1], { cx: x[i]!, cy: y[i]!, r: n.r * (2 + 0.8 * light[i]!), "fill-opacity": 0.22 * light[i]! });
        }
      });
      set(hubHalo, { cx: x[0]!, cy: y[0]!, r: NODES[0]!.r * (1.9 + 0.35 * swell), "fill-opacity": 0.14 + 0.1 * swell });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      media?.removeEventListener("change", onMedia);
    };
  }, []);

  return (
    <svg ref={svg} className={className ? `kv-loader-graph ${className}` : "kv-loader-graph"} viewBox="0 0 160 120" aria-hidden="true" focusable="false">
      <g>
        {EDGES.map(([a, b], e) => (
          <line key={`e${e}`} className="kv-l-edge" x1={NODES[a]!.x} y1={NODES[a]!.y} x2={NODES[b]!.x} y2={NODES[b]!.y} />
        ))}
      </g>
      <g>
        {EDGES.map(([a, b], e) => (
          <line key={`g${e}`} className="kv-l-edge-lit" x1={NODES[a]!.x} y1={NODES[a]!.y} x2={NODES[b]!.x} y2={NODES[b]!.y} strokeOpacity={0} />
        ))}
      </g>
      <g>
        <circle className="kv-l-hub-halo" cx={NODES[0]!.x} cy={NODES[0]!.y} r={NODES[0]!.r * 1.9} fillOpacity={0.14} />
        {NODES.slice(1).map((n, i) => (
          <circle key={`h${i}`} className="kv-l-halo" cx={n.x} cy={n.y} r={n.r * 2} fillOpacity={0} />
        ))}
        {NODES.map((n, i) => (
          <circle key={`n${i}`} className={n.kind === "hub" ? "kv-l-node kv-l-hub" : "kv-l-node"} cx={n.x} cy={n.y} r={n.r} />
        ))}
        {NODES.slice(1).map((n, i) => (
          <circle key={`l${i}`} className="kv-l-lit" cx={n.x} cy={n.y} r={n.r} fillOpacity={0} />
        ))}
      </g>
      <circle className="kv-l-head-halo" r={5.5} cx={NODES[0]!.x} cy={NODES[0]!.y} opacity={0} />
      <circle className="kv-l-head-halo" r={4.5} cx={NODES[0]!.x} cy={NODES[0]!.y} opacity={0} />
      <circle className="kv-l-head" r={2.1} cx={NODES[0]!.x} cy={NODES[0]!.y} opacity={0} />
      <circle className="kv-l-head" r={1.7} cx={NODES[0]!.x} cy={NODES[0]!.y} opacity={0} />
    </svg>
  );
}

/**
 * Marks a full-pane loader as on screen, for the next one to continue from. Returns whether this
 * one continues a loader that is still on screen (React renders the new one before the old one
 * unmounts) or was a moment ago — then it should not fade in again.
 */
export function useLoaderPresence(): boolean {
  const [continues] = useState(() => {
    const c = clock();
    return (c.onScreen ?? 0) > 0 || now() - c.lastShownAt < 700;
  });
  useEffect(() => {
    const c = clock();
    c.onScreen = (c.onScreen ?? 0) + 1;
    return () => {
      c.onScreen = (c.onScreen ?? 1) - 1;
      c.lastShownAt = now();
    };
  }, []);
  return continues;
}

type Props = {
  /** What is opening, in the person's words: "Opening Powerhouse Knowledge…". */
  label: string;
  /** A second, quieter line: where it is coming from. */
  detail?: string | undefined;
  /** Shown instead of the detail once the wait has gone on for `slowAfterMs`: why it is still waiting. */
  slow?: string | undefined;
  slowAfterMs?: number;
};

/** A full-pane wait: the graph, centred in the space the screen will fill, with what is opening. */
export function VaultLoader({ label, detail, slow, slowAfterMs = 8000 }: Props) {
  const continues = useLoaderPresence();
  const [isSlow, setSlow] = useState(false);
  useEffect(() => {
    if (!slow) return;
    const timer = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(timer);
  }, [slow, slowAfterMs]);
  const second = isSlow && slow ? slow : detail;
  return (
    <div className="kv-loader" role="status" aria-live="polite" aria-busy="true" data-continues={continues || undefined}>
      <VaultLoaderGraph />
      <p className="kv-loader-label">{label}</p>
      {second && <p className="kv-loader-detail">{second}</p>}
    </div>
  );
}

/** The inline mark, for a line of text or a button: a hub and three notes lighting in turn. */
export function VaultLoaderMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="kv-loader-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <line x1="8" y1="8.6" x2="8" y2="2.4" />
      <line x1="8" y1="8.6" x2="13.4" y2="12" />
      <line x1="8" y1="8.6" x2="2.6" y2="12" />
      <circle className="kv-lm-hub" cx="8" cy="8.6" r="2.4" />
      <circle className="kv-lm-node" cx="8" cy="2.4" r="1.7" />
      <circle className="kv-lm-node" cx="13.4" cy="12" r="1.7" />
      <circle className="kv-lm-node" cx="2.6" cy="12" r="1.7" />
    </svg>
  );
}

/** A short wait inside a section that is otherwise on screen: the mark, then what is being fetched. */
export function LoadingLine({ children }: { children: ReactNode }) {
  return (
    <p className="kv-quiet kv-loading-line" role="status">
      <VaultLoaderMark />
      {children}
    </p>
  );
}
