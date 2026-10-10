import { useEffect, useState, type ReactNode } from "react";
import type { FullGraph, VaultGraphSample } from "../api/graph.js";
import { CardIcon } from "../onboarding/CardIcon.js";
import type { VaultSummary } from "../vaults.js";
import { Constellation } from "./Constellation.js";
import { GraphMinimap } from "./GraphMinimap.js";
import { hasUsableLayout } from "./minimap.js";
import { formatOpened } from "./recents.js";
import type { XY } from "./saved-layout.js";
import "./hero.css";

const number = new Intl.NumberFormat("en-US");
type Jump = "chat" | "notes" | "graph" | "sources";
const JUMPS: ReadonlyArray<{ view: Jump; label: string }> = [
  { view: "chat", label: "Chat" },
  { view: "notes", label: "Notes" },
  { view: "graph", label: "Graph" },
  { view: "sources", label: "Sources" },
];

type Props = {
  vault: VaultSummary;
  /** A vault on another server: named under the title. */
  remote?: { host: string };
  opened: string | undefined;
  sample: VaultGraphSample | null;
  full?: FullGraph | null;
  saved: Map<string, XY> | null;
  onOpen: () => void;
  /** A local vault opens straight on one of its views. */
  onOpenView?: (view: Jump) => void;
  /** The ⋯ menu. */
  menu?: ReactNode;
  /** Notes added since this page last showed the vault. */
  newNotes?: number;
  /** Its sources are being turned into notes right now. */
  writing?: boolean;
  /** The only vault: the card takes more of the window. */
  alone?: boolean;
};

/**
 * The front page's lead (Six Minds, Decision): the vault opened last, most likely the one wanted now — its graph,
 * what is in it, what changed, and the one highlighted button that opens it. Shortcuts open it on a view.
 */
export function HeroVault({ vault, remote, opened, sample, full = null, saved, onOpen, onOpenView, menu, newNotes = 0, writing = false, alone = false }: Props) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (sample === null && full === null) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [sample, full]);
  const wholeGraph = full && saved && hasUsableLayout(full, saved) ? full : null;
  const notes = sample?.noteCount ?? vault.noteCount;
  const when = formatOpened(opened);
  const stats: Array<{ label: string; value: number }> = [{ label: notes === 1 ? "Note" : "Notes", value: notes }];
  if (sample) stats.push({ label: sample.linkCount === 1 ? "Link" : "Links", value: sample.linkCount });
  if (vault.sourceCount !== undefined) stats.push({ label: vault.sourceCount === 1 ? "Source" : "Sources", value: vault.sourceCount });

  return (
    <article className="kv-hero" data-alone={alone} aria-labelledby={`kv-hero-${vault.id}`}>
      {/* The graph is a large target for the mouse; the button below is the control (one tab stop). */}
      <div className="kv-hero-sky" onClick={onOpen} aria-hidden="true">
        {wholeGraph && saved ? (
          <GraphMinimap graph={wholeGraph} positions={saved} settled={settled} />
        ) : (
          <Constellation sample={sample} saved={saved} seed={vault.id} width={560} height={440} settled={settled} />
        )}
      </div>
      <div className="kv-hero-body">
        <p className="kv-hero-eyebrow">{when.charAt(0).toUpperCase() + when.slice(1)}</p>
        <h3 id={`kv-hero-${vault.id}`} className="kv-hero-name">
          {vault.name}
        </h3>
        {remote && <p className="kv-tile-remote">On {remote.host}</p>}
        {notes === 0 ? (
          <p className="kv-hero-empty">No notes yet. Open it and add your first source.</p>
        ) : (
          <dl className="kv-hero-stats">
            {stats.map((s) => (
              <div key={s.label}>
                <dt>{s.label}</dt>
                <dd>{number.format(s.value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {(newNotes > 0 || writing) && (
          <p className="kv-hero-signals">
            {newNotes > 0 && (
              <span className="kv-signal" data-kind="new" title="Since you last looked at this page">
                +{number.format(newNotes)} new note{newNotes === 1 ? "" : "s"}
              </span>
            )}
            {writing && (
              <span className="kv-signal" data-kind="live">
                Writing notes…
              </span>
            )}
          </p>
        )}
        <div className="kv-hero-actions">
          <button type="button" className="kv-button kv-button-primary kv-hero-open" onClick={onOpen} aria-label={`Open vault ${vault.name}`}>
            Open vault
            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
          {onOpenView && notes > 0 && (
            <span className="kv-hero-jumps" role="group" aria-label={`Open ${vault.name} on`}>
              {JUMPS.map((j) => (
                <button key={j.view} type="button" className="kv-hero-jump" onClick={() => onOpenView(j.view)}>
                  <CardIcon view={j.view} />
                  {j.label}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
      {menu && <div className="kv-tile-menu">{menu}</div>}
    </article>
  );
}

/** The lead's shape while the vaults load. */
export function HeroSkeleton() {
  return (
    <div className="kv-hero kv-hero-skeleton" aria-hidden="true">
      <div className="kv-hero-sky" />
      <div className="kv-hero-body">
        <span className="kv-skeleton-line kv-skeleton-meta" style={{ width: "40%" }} />
        <span className="kv-skeleton-line kv-skeleton-name" />
        <span className="kv-skeleton-line kv-skeleton-meta" />
      </div>
    </div>
  );
}
