import { useId, useState } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { CopyBlock } from "../shell/CopyBlock.js";
import type { VaultSummary } from "../vaults.js";
import { askedAQuestion, gettingStartedSteps, readRemembered, remember, type Remembered, type Step, type StepGroup, type StepId } from "./getting-started.js";

export type VaultView = "sources" | "notes" | "chat" | "graph" | "search";

const TEXT: Record<StepId, { title: string; line: string }> = {
  model: { title: "Choose an AI model", line: "It reads your sources and writes the notes." },
  vault: { title: "Create a vault", line: "A vault holds the sources and notes on one subject." },
  source: { title: "Add a source", line: "A PDF, a web page, a document or pasted text." },
  notes: { title: "Read your first notes", line: "One idea each, with its links and the source it came from." },
  chat: { title: "Ask your vault a question", line: "The chat answers from your notes and names the ones it used." },
  graph: { title: "See how ideas connect", line: "The graph shows the links; maps of your topics gather the notes on one theme." },
  search: { title: "Search by meaning", line: "Find a note even when your words differ from its words." },
  processing: { title: "Watch the processing", line: "Each source going through its four steps, live, in Workflows." },
  tools: { title: "Use your vault from Claude Code, Codex or Gemini CLI", line: "One command connects the tool to this vault's search and notes." },
};
const GROUPS: ReadonlyArray<{ group: StepGroup; label: string }> = [
  { group: "setup", label: "Set up" },
  { group: "explore", label: "Explore your vault" },
  { group: "optional", label: "Optional" },
];

type Props = {
  info: SidecarInfo;
  /** Local vaults, most recently opened first. */
  vaults: readonly VaultSummary[];
  modelReady: boolean;
  storage?: Storage;
  onModels?: () => void;
  onNewVault: () => void;
  onOpenView?: (vault: VaultSummary, view: VaultView) => void;
  onWorkflows?: () => void;
  onGuide?: () => void;
  /** Settings › Getting started, where a closed list can be seen and brought back. */
  onOpenSettings?: () => void;
  /** "panel": the front page's, until the person closes it. "settings": always shown, with "Show on the front page". */
  variant?: "panel" | "settings";
};

/**
 * Getting started (design §5): the setup guide's map, kept on the front page until the person closes it. Each step
 * is ticked from what was actually done; the next one's action is the one highlighted. Settings always shows it.
 */
export function GettingStarted({ info, vaults, modelReady, storage, onModels, onNewVault, onOpenView, onWorkflows, onGuide, onOpenSettings, variant = "panel" }: Props) {
  const [saved, setSaved] = useState<Remembered>(() => readRemembered(storage));
  const [showTools, setShowTools] = useState(false);
  const [justClosed, setJustClosed] = useState(false);
  const headingId = useId();
  const keep = (patch: Remembered) => setSaved(remember(storage, patch));

  if (variant === "panel" && saved.hidden) {
    return justClosed ? (
      <p className="kv-hint kv-gs-closed" role="status">
        Getting started is closed.{" "}
        {onOpenSettings ? (
          <button type="button" className="kv-link" onClick={onOpenSettings}>Settings › Getting started</button>
        ) : (
          "Settings › Getting started"
        )}{" "}
        shows it again.
      </p>
    ) : null;
  }
  const steps = gettingStartedSteps({ modelReady, vaults, asked: askedAQuestion(storage), readNotes: saved.readNotes === true, explored: saved.explored ?? {}, toolsCopied: saved.tools === true });
  const required = steps.filter((s) => s.group !== "optional");
  const doneCount = required.filter((s) => s.done).length;
  const allDone = doneCount === required.length;
  const next = required.find((s) => !s.done)?.id;
  const latest = vaults[0];
  const withNotes = vaults.find((v) => v.noteCount > 0) ?? latest;
  const mcp = `${info.origin}/mcp`;

  const button = (id: StepId, label: string, onClick: () => void) => (
    <button type="button" className={id === next ? "kv-button kv-button-primary" : "kv-button"} onClick={onClick}>{label}</button>
  );
  const needsVault = <span className="kv-hint">Create a vault first.</span>;
  const visit = (view: VaultView, explored?: keyof NonNullable<Remembered["explored"]>) =>
    withNotes && onOpenView
      ? () => {
          if (explored) keep({ explored: { [explored]: true } });
          if (view === "notes") keep({ readNotes: true });
          onOpenView(withNotes, view);
        }
      : null;

  function action(id: StepId) {
    switch (id) {
      case "model":
        return onModels ? button(id, "Choose a model", onModels) : null;
      case "vault":
        return button(id, "Create a vault", onNewVault);
      case "source":
        return latest && onOpenView ? button(id, "Add sources", () => onOpenView(latest, "sources")) : needsVault;
      case "notes": {
        if (!vaults.some((v) => v.noteCount > 0)) return <span className="kv-hint">They appear once a source is processed.</span>;
        const go = visit("notes");
        return go ? button(id, "Open notes", go) : needsVault;
      }
      case "chat": {
        const go = visit("chat");
        return go ? button(id, "Ask a question", go) : needsVault;
      }
      case "graph": {
        const go = visit("graph", "graph");
        return go ? button(id, "Open the graph", go) : needsVault;
      }
      case "search": {
        const go = visit("search", "search");
        return go ? button(id, "Search", go) : needsVault;
      }
      case "processing":
        return onWorkflows
          ? button(id, "Watch it work", () => {
              keep({ explored: { processing: true } });
              onWorkflows();
            })
          : null;
      case "tools":
        return (
          <button type="button" className="kv-link" aria-expanded={showTools} onClick={() => setShowTools((s) => !s)}>
            {showTools ? "Hide the commands" : "Show the commands"}
          </button>
        );
    }
  }

  function row(s: Step) {
    return (
      <li key={s.id} className="kv-gs-step" data-done={s.done} data-next={s.id === next}>
        <span className="kv-gs-mark" aria-hidden="true">
          {s.done && (
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className="kv-gs-text">
          <strong>
            <span className="kv-visually-hidden">{s.done ? "Done: " : "To do: "}</span>
            {TEXT[s.id].title}
          </strong>
          <span>{TEXT[s.id].line}</span>
        </span>
        {!s.done && <span className="kv-gs-action">{action(s.id)}</span>}
      </li>
    );
  }

  return (
    <section className="kv-gs" aria-labelledby={headingId} data-variant={variant}>
      <div className="kv-gs-head">
        {variant === "panel" && <h3 id={headingId} className="kv-gs-title">{allDone ? "You're all set" : "Getting started"}</h3>}
        {variant === "settings" && <h3 id={headingId} className="kv-visually-hidden">Getting started</h3>}
        <span className="kv-gs-count">{allDone ? "Every step done" : `${doneCount} of ${required.length} done`}</span>
        <span className="kv-gs-head-actions">
          {onGuide && <button type="button" className="kv-link" onClick={onGuide}>Setup guide</button>}
          {variant === "panel" ? (
            <button
              type="button"
              className="kv-button"
              onClick={() => {
                keep({ hidden: true });
                setJustClosed(true);
              }}
            >
              Close
            </button>
          ) : saved.hidden ? (
            <button type="button" className="kv-button" onClick={() => keep({ hidden: false })}>Show on the front page</button>
          ) : (
            <span className="kv-hint">Shown on the front page</span>
          )}
        </span>
      </div>
      <div className="kv-gs-bar" role="progressbar" aria-label="Getting started" aria-valuemin={0} aria-valuemax={required.length} aria-valuenow={doneCount}>
        <span style={{ width: `${(doneCount / required.length) * 100}%` }} />
      </div>
      {GROUPS.map(({ group, label }) => (
        <div key={group} className="kv-gs-group">
          <p className="kv-gs-group-label">{label}</p>
          <ol className="kv-gs-steps">{steps.filter((s) => s.group === group).map(row)}</ol>
        </div>
      ))}
      {showTools && (
        <div className="kv-gs-tools">
          <CopyBlock label="Claude Code" value={`claude mcp add --transport http knowledge-vault ${mcp}`} onCopied={() => keep({ tools: true })} />
          <CopyBlock label="Codex" value={`codex mcp add knowledge-vault --url ${mcp}`} onCopied={() => keep({ tools: true })} />
          <CopyBlock label="Gemini CLI" value={`gemini mcp add --transport http knowledge-vault ${mcp}`} onCopied={() => keep({ tools: true })} />
          <p className="kv-hint">Run one in a terminal. The tool reaches your vault while this app is running.</p>
        </div>
      )}
    </section>
  );
}
