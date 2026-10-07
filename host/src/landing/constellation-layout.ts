/**
 * A small deterministic force layout for the landing's constellation tiles.
 * Deterministic so a tile never jitters between renders; tiny (≤ 60 nodes) so
 * it runs in a few milliseconds on the main thread.
 */
export type Pt = { id: string; x: number; y: number };

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scale uniformly to fit the box (minus padding) and centre the cloud. */
export function fitToBox(points: readonly Pt[], width: number, height: number, pad = 12): Pt[] {
  if (points.length === 0) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const ew = maxX - minX; // true extents; a flat cloud has 0 here and must still centre
  const eh = maxY - minY;
  const scale = Math.min((width - 2 * pad) / (ew || 1), (height - 2 * pad) / (eh || 1));
  const offX = (width - ew * scale) / 2 - minX * scale;
  const offY = (height - eh * scale) / 2 - minY * scale;
  return points.map((p) => ({ id: p.id, x: round(p.x * scale + offX), y: round(p.y * scale + offY) }));
}

const round = (v: number) => Math.round(v * 100) / 100;

export function layoutConstellation(
  ids: readonly string[],
  edges: readonly (readonly [string, string])[],
  seed: string,
  width: number,
  height: number,
): Pt[] {
  const n = ids.length;
  if (n === 0) return [];
  if (n === 1) return [{ id: ids[0]!, x: width / 2, y: height / 2 }];
  const rnd = mulberry32(hash32(seed));
  const index = new Map(ids.map((id, i) => [id, i] as const));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const angle = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd());
    x[i] = Math.cos(angle) * r;
    y[i] = Math.sin(angle) * r;
  }
  const links: [number, number][] = [];
  for (const [a, b] of edges) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined && ia !== ib) links.push([ia, ib]);
  }
  const k = 1.4 / Math.sqrt(n); // ideal spacing in unit space
  const ITER = 160;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let iter = 0; iter < ITER; iter++) {
    const cool = 1 - iter / ITER;
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ex = x[i]! - x[j]!;
        const ey = y[i]! - y[j]!;
        const d2 = ex * ex + ey * ey + 1e-3;
        const f = (k * k) / d2;
        dx[i] = dx[i]! + ex * f; dy[i] = dy[i]! + ey * f;
        dx[j] = dx[j]! - ex * f; dy[j] = dy[j]! - ey * f;
      }
    }
    for (const [a, b] of links) {
      const ex = x[a]! - x[b]!;
      const ey = y[a]! - y[b]!;
      const d = Math.hypot(ex, ey) + 1e-6;
      const f = ((d - k) / d) * 0.6;
      dx[a] = dx[a]! - ex * f; dy[a] = dy[a]! - ey * f;
      dx[b] = dx[b]! + ex * f; dy[b] = dy[b]! + ey * f;
    }
    const step = 0.06 * cool + 0.004;
    for (let i = 0; i < n; i++) {
      // gentle pull to the centre keeps disconnected pieces in frame
      const gx = dx[i]! - x[i]! * 0.03;
      const gy = dy[i]! - y[i]! * 0.03;
      const len = Math.hypot(gx, gy) || 1;
      const clamp = Math.min(len, 0.35) / len;
      x[i] = x[i]! + gx * clamp * step * 8;
      y[i] = y[i]! + gy * clamp * step * 8;
    }
  }
  return fitToBox(ids.map((id, i) => ({ id, x: x[i]!, y: y[i]! })), width, height);
}

/** A quiet placeholder for a vault without notes: a small tree with a few cross links, seeded by the vault. */
export function generativeConstellation(seed: string, count: number): { ids: string[]; edges: [string, string][] } {
  const rnd = mulberry32(hash32(`generative:${seed}`));
  const ids = Array.from({ length: count }, (_, i) => `g${i}`);
  const edges: [string, string][] = [];
  const seen = new Set<string>();
  const push = (a: number, b: number): void => {
    // Ordered by index, so a cross link never duplicates a tree edge (React keys edges by their pair).
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}-${hi}`;
    if (lo === hi || seen.has(key)) return;
    seen.add(key);
    edges.push([ids[lo]!, ids[hi]!]);
  };
  for (let i = 1; i < count; i++) push(Math.floor(rnd() * i), i);
  const extra = Math.floor(count / 5);
  for (let e = 0; e < extra; e++) push(Math.floor(rnd() * count), Math.floor(rnd() * count));
  return { ids, edges };
}
