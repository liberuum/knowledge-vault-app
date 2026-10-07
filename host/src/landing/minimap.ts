import type { FullGraph, GraphNodeLite } from "../api/graph.js";
import { fitToBox } from "./constellation-layout.js";
import type { XY } from "./saved-layout.js";

/** The whole graph as the vault app laid it out, fitted to a tile — the real shape, no simulation. */
export type MinimapPoint = { id: string; x: number; y: number; kind: GraphNodeLite["kind"]; status: string | null };
export type MinimapScene = {
  points: MinimapPoint[];
  segments: { x1: number; y1: number; x2: number; y2: number }[];
  /** Nodes with a saved position / all nodes; a tile falls back below a threshold. */
  coverage: number;
  placed: number;
  total: number;
};

export function buildMinimapScene(graph: FullGraph, positions: Map<string, XY>, width: number, height: number, pad = 10): MinimapScene {
  const placedNodes = graph.nodes.filter((n) => positions.has(n.id));
  const fitted = fitToBox(placedNodes.map((n) => ({ id: n.id, ...positions.get(n.id)! })), width, height, pad);
  const byId = new Map(fitted.map((p) => [p.id, p]));
  const points: MinimapPoint[] = placedNodes.map((n) => ({ ...byId.get(n.id)!, kind: n.kind, status: n.status }));
  const segments = graph.edges.flatMap(([a, b]) => {
    const pa = byId.get(a);
    const pb = byId.get(b);
    return pa && pb ? [{ x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }] : [];
  });
  const total = graph.nodes.length;
  return { points, segments, coverage: total === 0 ? 0 : placedNodes.length / total, placed: placedNodes.length, total };
}

export const MIN_COVERAGE = 0.6;

/** A saved layout covers enough of the graph to draw it as it was seen; below that the tile shows a sample. */
export function hasUsableLayout(graph: FullGraph, positions: Map<string, XY> | null, min = MIN_COVERAGE): boolean {
  if (!positions || graph.nodes.length === 0) return false;
  let placed = 0;
  for (const n of graph.nodes) if (positions.has(n.id)) placed++;
  return placed / graph.nodes.length >= min;
}
