import { describe, expect, it } from "vitest";
import { fitToBox, generativeConstellation, layoutConstellation } from "./constellation-layout.js";

const ids = ["a", "b", "c", "d", "e", "f"];
const edges: [string, string][] = [["a", "b"], ["b", "c"], ["c", "d"], ["a", "e"], ["e", "f"]];

describe("layoutConstellation", () => {
  it("is deterministic for the same input and seed, and differs by seed", () => {
    const one = layoutConstellation(ids, edges, "vault-1", 320, 160);
    expect(layoutConstellation(ids, edges, "vault-1", 320, 160)).toEqual(one);
    expect(layoutConstellation(ids, edges, "vault-2", 320, 160)).not.toEqual(one);
  });
  it("keeps every point inside the box and returns one point per id", () => {
    const pts = layoutConstellation(ids, edges, "s", 320, 160);
    expect(pts.map((p) => p.id)).toEqual(ids);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(320);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(160);
    }
  });
  it("places linked nodes closer than unlinked ones, on average", () => {
    const pts = new Map(layoutConstellation(ids, edges, "s", 320, 320).map((p) => [p.id, p]));
    const d = (a: string, b: string) => Math.hypot(pts.get(a)!.x - pts.get(b)!.x, pts.get(a)!.y - pts.get(b)!.y);
    const linked = edges.map(([a, b]) => d(a, b)).reduce((s, v) => s + v, 0) / edges.length;
    const unlinked = (d("a", "d") + d("b", "f") + d("c", "e") + d("d", "f")) / 4;
    expect(linked).toBeLessThan(unlinked);
  });
  it("handles an empty graph and a single node", () => {
    expect(layoutConstellation([], [], "s", 100, 100)).toEqual([]);
    expect(layoutConstellation(["only"], [], "s", 100, 100)).toEqual([{ id: "only", x: 50, y: 50 }]);
  });
});

describe("fitToBox", () => {
  it("scales uniformly and centres the cloud", () => {
    const out = fitToBox([{ id: "a", x: 0, y: 0 }, { id: "b", x: 10, y: 0 }], 200, 100, 10);
    expect(out[0]).toEqual({ id: "a", x: 10, y: 50 });
    expect(out[1]).toEqual({ id: "b", x: 190, y: 50 });
  });
});

describe("generativeConstellation", () => {
  it("builds a small connected graph deterministically", () => {
    const g = generativeConstellation("empty-vault", 14);
    expect(g.ids).toHaveLength(14);
    expect(g.edges.length).toBeGreaterThanOrEqual(13);
    expect(generativeConstellation("empty-vault", 14)).toEqual(g);
  });
});

describe("generativeConstellation", () => {
  it("never repeats an edge — React keys the lines by their pair", () => {
    for (const seed of ["a", "research-notes", "c5893e1b", "E2E vault"]) {
      for (const count of [18, 34]) {
        const { edges } = generativeConstellation(seed, count);
        const keys = edges.map(([a, b]) => `${a}-${b}`);
        expect(new Set(keys).size, `${seed}/${count}`).toBe(keys.length);
        expect(edges.every(([a, b]) => a !== b)).toBe(true);
      }
    }
  });
});
