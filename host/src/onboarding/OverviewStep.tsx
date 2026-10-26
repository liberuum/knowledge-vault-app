import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { askedAQuestion, guideCardDone, guideCardVisit, readRemembered, remember } from "../landing/getting-started.js";
import { fetchPipeline, fetchVaults, type PipelineStatus } from "../vaults.js";
import { ensureAutoPublish, vaultIntake, type IntakeFileView, type IntakeView } from "./vault-intake.js";
import { CardIcon } from "./CardIcon.js";
import { isWriting, processingLine } from "./processing-line.js";

export type VaultView = "chat" | "notes" | "graph" | "search" | "sources";

const NO_INTAKE: IntakeView = { files: [], publishing: false };
/** Getting started's record (landing/getting-started.ts): the cards tick from it, and opening one writes it. */
const storage = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);
const noSubscribe = () => () => undefined;

/** One file's progress in words (Language): no phases or job names. */
function fileLine(f: IntakeFileView): { text: string; done: boolean; failed: boolean } {
  if (f.publishedIds) return { text: `Added as ${f.publishedIds.length} source${f.publishedIds.length === 1 ? "" : "s"}`, done: true, failed: false };
  if (f.state === "failed") return { text: `Could not be read: ${f.error ?? "the converter refused it"}`, done: true, failed: true };
  if (f.state === "converted") return { text: "Read; adding it to the vault…", done: false, failed: false };
  if (f.state === "converting") {
    const p = f.progress;
    return { text: p && p.pages ? `Reading page ${Math.min(p.pagesDone + 1, p.pages)} of ${p.pages}…` : "Reading…", done: false, failed: false };
  }
  return { text: "Waiting its turn", done: false, failed: false };
}

/** `afterNotes`: the view shows nothing until processing has written the first notes. */
const CARDS: ReadonlyArray<{ view: VaultView | "runs"; title: string; line: string; afterNotes?: true }> = [
  { view: "chat", title: "Chat with your vault", line: "Ask a question; the answer names the notes it used.", afterNotes: true },
  { view: "notes", title: "Read your notes", line: "One idea each, with its links and the source it came from. Approve the ones that hold.", afterNotes: true },
  { view: "graph", title: "See how ideas connect", line: "The graph shows the links; maps of your topics gather the notes on one theme.", afterNotes: true },
  { view: "search", title: "Search by meaning", line: "Find a note even when your words differ from its words.", afterNotes: true },
  { view: "sources", title: "Add more sources", line: "Drop files in Sources any time; each one is read on its own." },
  { view: "runs", title: "Watch the processing", line: "Each source going through its four steps, live, in Workflows." },
];

/**
 * The guide's last screen (spec §5, step 5, as the person asked): the vault fills while they learn what it does.
 * Files convert here — the vault's own intake, driven from the guide — and each card opens the vault on that view.
 */
/**
 * The cards are excursions: they open the vault on that view and the guide stays open, reachable from the vault's
 * top bar ("Setup guide"). Only the main button finishes it (Wayfinding: always a way back).
 */
export function OverviewStep({
  info,
  vaultId,
  onVisit,
  onRuns,
  onWorkflows,
  onFinish,
}: {
  info: SidecarInfo;
  vaultId: string;
  onVisit: (view: VaultView) => void;
  onRuns: (workflowId: string) => void;
  /** The side trip into Workflow Studio and its templates (spec 2026-10-15); it comes back here. */
  onWorkflows?: () => void;
  onFinish: () => void;
}) {
  const intake = useMemo(() => vaultIntake(vaultId), [vaultId]);
  const snapshot = useSyncExternalStore(intake ? intake.subscribe : noSubscribe, intake ? intake.getSnapshot : () => NO_INTAKE);
  useEffect(() => {
    if (intake) ensureAutoPublish(vaultId, intake);
  }, [intake, vaultId]);

  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [notes, setNotes] = useState(0);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const [p, list] = await Promise.all([fetchPipeline(info, vaultId).catch(() => null), fetchVaults(info).catch(() => null)]);
      if (!alive) return;
      if (p) setPipeline(p);
      const own = list?.find((v) => v.id === vaultId);
      if (own) setNotes(own.noteCount);
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [info, vaultId]);

  // What has been explored, from the front page's record: a card opened from there or here is ticked on both.
  const [saved, setSaved] = useState(() => readRemembered(storage()));

  const files = snapshot.files;
  const finished = files.filter((f) => fileLine(f).done).length;
  const share = files.length ? Math.round((finished / files.length) * 100) : 100;
  const workflowId = pipeline?.state === "ready" ? pipeline.workflowId : undefined;
  const asked = askedAQuestion(storage());
  const open = (card: (typeof CARDS)[number]["view"]) => {
    setSaved(remember(storage(), guideCardVisit(card)));
    if (card === "runs") {
      if (workflowId) onRuns(workflowId);
    } else onVisit(card);
  };

  return (
    <section aria-labelledby="onb-title">
      <h2 id="onb-title" className="kv-onb-title" tabIndex={-1}>Your vault is filling up</h2>
      <p className="kv-onb-lead">Your sources are being read and turned into notes. There is no need to wait here: look around while it runs.</p>
      <div className="kv-onb-progress" aria-live="polite">
        {files.length > 0 && (
          <>
            <div className="kv-onb-bar" role="progressbar" aria-label="Files read" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}>
              <span style={{ width: `${share}%` }} />
            </div>
            <ul className="kv-onb-filelist">
              {files.map((f) => {
                const line = fileLine(f);
                return (
                  <li key={f.id} data-done={line.done} data-failed={line.failed}>
                    <span className="kv-onb-file-name">{f.name}</span>
                    <span className="kv-hint">{line.text}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="kv-onb-processing" data-busy={isWriting(pipeline)}>{processingLine(pipeline, notes)}</p>
      </div>
      {notes === 0 && (
        <aside className="kv-onb-callout" aria-label="Before the first notes">
          <svg className="kv-onb-callout-icon" aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
            <circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10 9v5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <circle cx="10" cy="6.2" r="1.05" fill="currentColor" />
          </svg>
          <div className="kv-onb-callout-body">
            <strong>Notes appear after processing</strong>
            <span>
              Until a source has been processed, your vault shows it only under Sources: no notes, links, maps or chat answers yet. Each
              source takes a few minutes, and its notes appear as soon as it is done.
            </span>
          </div>
        </aside>
      )}
      <h3 className="kv-onb-subtitle">What you can do</h3>
      <ul className="kv-onb-cards">
        {CARDS.map((c) => {
          const done = guideCardDone(c.view, saved, asked);
          return (
          <li key={c.view}>
            <button
              type="button"
              className="kv-onb-card"
              data-done={done}
              disabled={c.view === "runs" && !workflowId}
              onClick={() => open(c.view)}
            >
              <span className="kv-onb-card-icon">
                <CardIcon view={c.view} />
              </span>
              <span className="kv-onb-card-head">
                <strong>{c.title}</strong>
                {done ? (
                  <span className="kv-onb-card-done">
                    <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                    {c.view === "chat" ? "Asked" : "Explored"}
                  </span>
                ) : (
                  c.afterNotes && notes === 0 && <span className="kv-onb-card-tag">After processing</span>
                )}
              </span>
              <span>{c.line}</span>
            </button>
          </li>
          );
        })}
      </ul>
      {onWorkflows && (
        <aside className="kv-onb-trip" aria-labelledby="onb-trip-title">
          <span className="kv-onb-trip-icon" aria-hidden="true">
            <CardIcon view="runs" />
          </span>
          <span className="kv-onb-trip-body">
            <strong id="onb-trip-title">Let your vault fill itself</strong>
            <span>Workflows bring in new posts, papers and meeting notes as they appear. Three templates, a minute each.</span>
          </span>
          <button type="button" className="kv-button" onClick={onWorkflows}>
            Explore workflows <span aria-hidden="true">→</span>
          </button>
        </aside>
      )}
      <div className="kv-onb-actions kv-onb-actions-end">
        <span className="kv-onb-actions-note kv-hint">Try any of these: the setup guide stays one click away in the vault's top bar.</span>
        <button type="button" className="kv-button kv-button-primary" onClick={onFinish}>Finish and open my vault</button>
      </div>
    </section>
  );
}
