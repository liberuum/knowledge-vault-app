import { useMemo } from "react";
import type { VaultGraphSample } from "../api/graph.js";
import { fitToBox, generativeConstellation, layoutConstellation, type Pt } from "./constellation-layout.js";
import { positionsFor, type XY } from "./saved-layout.js";

type Props = {
  /** The vault's sample; null while loading or when it failed — the tile then shows a quiet placeholder. */
  sample: VaultGraphSample | null;
  /** Positions the vault app saved for this drive, when the person has laid the graph out. */
  saved: Map<string, XY> | null;
  seed: string;
  width: number;
  height: number;
  /** Flips to true once, when the data is in: the one orchestrated motion on this screen. */
  settled: boolean;
};

/**
 * A vault's own graph as a small constellation. Real nodes and edges when the
 * vault has notes (coloured as the graph view colours them), the saved layout
 * when there is one, a seeded placeholder otherwise.
 */
export function Constellation({ sample, saved, seed, width, height, settled }: Props) {
  const scene = useMemo(() => {
    const real = sample !== null && sample.nodes.length > 0;
    // A placeholder dense enough to read as a constellation, not a lonely tree.
    const placeholder = real ? null : generativeConstellation(seed, width > 420 ? 34 : 18);
    const ids = real ? sample.nodes.map((n) => n.id) : placeholder!.ids;
    const edges = real ? sample.edges : placeholder!.edges;
    const savedPos = real ? positionsFor(ids, saved) : null;
    const points: Pt[] = savedPos
      ? fitToBox(ids.filter((id) => savedPos.has(id)).map((id) => ({ id, ...savedPos.get(id)! })), width, height, 22)
      : fitToBox(layoutConstellation(ids, edges, seed, width, height), width, height, 22);
    const at = new Map(points.map((p) => [p.id, p]));
    const kinds = new Map(real ? sample.nodes.map((n) => [n.id, n]) : []);
    return { real, points, edges: edges.filter(([a, b]) => at.has(a) && at.has(b)), at, kinds };
  }, [sample, saved, seed, width, height]);

  const lead = width > 420;
  const r = lead ? 3.4 : 2.6;
  return (
    <svg
      className="kv-constellation"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      data-settled={settled}
      data-real={scene.real}
      aria-hidden="true"
      focusable="false"
    >
      <g className="kv-constellation-scene">
        <g className="kv-constellation-edges">
          {scene.edges.map(([a, b]) => {
            const pa = scene.at.get(a)!;
            const pb = scene.at.get(b)!;
            return <line key={`${a}-${b}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} />;
          })}
        </g>
        <g className="kv-constellation-nodes">
          {scene.points.map((p) => {
            const node = scene.kinds.get(p.id);
            const isMoc = node?.kind === "moc";
            return (
              <circle
                key={p.id}
                cx={p.x}
                cy={p.y}
                r={isMoc ? r * 1.45 : r}
                className={isMoc ? "kv-node kv-node-moc" : "kv-node"}
                data-status={node?.status ?? undefined}
              />
            );
          })}
        </g>
      </g>
    </svg>
  );
}
