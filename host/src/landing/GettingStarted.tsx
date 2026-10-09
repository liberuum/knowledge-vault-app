import { useId, useState } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { CopyBlock } from "../shell/CopyBlock.js";
import type { VaultSummary } from "../vaults.js";
import { askedAQuestion, gettingStartedSteps, readRemembered, remember, type Remembered, type StepId } from "./getting-started.js";

export type VaultView = "sources" | "notes" | "chat";

const TEXT: Record<StepId, { title: string; line: string }> = {
  model: { title: "Choose an AI model", line: "It reads your sources and writes the notes." },
  vault: { title: "Create a vault", line: "A vault holds the sources and notes on one subject." },
  source: { title: "Add a source", line: "A PDF, a web page, a document or pasted text." },
  notes: { title: "Read your first notes", line: "One idea each, linked to the notes it relates to." },
  chat: { title: "Ask your vault a question", line: "The chat answers from your notes and names the ones it used." },
  tools: { title: "Use your vault from Claude Code, Codex or Gemini CLI", line: "One command connects the tool to this vault's search and notes." },
};

type Props = {
  info: SidecarInfo;
  /** Local vaults, most recently opened first. */
  vaults: readonly VaultSummary[];
  modelReady: boolean;
  storage?: Storage;
  onModels?: () => void;
  onNewVault: () => void;
  onOpenView?: (vault: VaultSummary, view: VaultView) => void;
  onGuide?: () => void;
};

/**
 * The getting-started checklist on the landing (design §5): the steps that make the app useful, ticked from what
 * was actually done, the next one's action highlighted. It folds away, and once every step is done it can go.
 */
export function GettingStarted({ info, vaults, modelReady, storage, onModels, onNewVault, onOpenView, onGuide }: Props) {
  const [saved, setSaved] = useState<Remembered>(() => readRemembered(storage));
  const [showTools, setShowTools] = useState(false);
  const headingId = useId();
  const keep = (patch: Remembered) => setSaved(remember(storage, patch));

  if (saved.hidden) return null;
  const steps = gettingStartedSteps({ modelReady, vaults, asked: askedAQuestion(storage), readNotes: saved.readNotes === true, toolsCopied: saved.tools === true });
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  const allDone = doneCount === required.length;
  const next = required.find((s) => !s.done)?.id;
  const latest = vaults[0];
  const withNotes = vaults.find((v) => v.noteCount > 0);
  const mcp = `${info.origin}/mcp`;

  const button = (id: StepId, label: string, onClick: () => void) => (
    <button type="button" className={id === next ? "kv-button kv-button-primary" : "kv-button"} onClick={onClick}>{label}</button>
  );
  function action(id: StepId) {
    switch (id) {
      case "model":
        return onModels ? button(id, "Choose a model", onModels) : null;
      case "vault":
        return button(id, "Create a vault", onNewVault);
      case "source":
        return latest && onOpenView ? button(id, "Add sources", () => onOpenView(latest, "sources")) : <span className="kv-hint">Create a vault first.</span>;
      case "notes":
        return withNotes && onOpenView ? (
          button(id, "Open notes", () => {
            keep({ readNotes: true });
            onOpenView(withNotes, "notes");
          })
        ) : (
          <span className="kv-hint">They appear once a source is processed.</span>
        );
      case "chat": {
        const target = withNotes ?? latest;
        return target && onOpenView ? button(id, "Ask a question", () => onOpenView(target, "chat")) : <span className="kv-hint">Create a vault first.</span>;
      }
      case "tools":
        return (
          <button type="button" className="kv-link" aria-expanded={showTools} onClick={() => setShowTools((s) => !s)}>
            {showTools ? "Hide the commands" : "Show the commands"}
          </button>
        );
    }
  }

  function row(id: StepId, done: boolean) {
    return (
      <li key={id} className="kv-gs-step" data-done={done} data-next={id === next}>
        <span className="kv-gs-mark" aria-hidden="true">
          {done && (
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className="kv-gs-text">
          <strong>
            <span className="kv-visually-hidden">{done ? "Done: " : "To do: "}</span>
            {TEXT[id].title}
          </strong>
          <span>{TEXT[id].line}</span>
        </span>
        {!done && <span className="kv-gs-action">{action(id)}</span>}
      </li>
    );
  }

  return (
    <section className="kv-gs" aria-labelledby={headingId} data-collapsed={saved.collapsed === true}>
      <div className="kv-gs-head">
        <h3 id={headingId} className="kv-gs-title">{allDone ? "You're all set" : "Getting started"}</h3>
        <span className="kv-gs-count">{allDone ? "Every step done" : `${doneCount} of ${required.length} done`}</span>
        <span className="kv-gs-head-actions">
          {onGuide && !allDone && <button type="button" className="kv-link" onClick={onGuide}>Setup guide</button>}
          {allDone ? (
            <button type="button" className="kv-button" onClick={() => keep({ hidden: true })}>Hide this list</button>
          ) : (
            <button type="button" className="kv-link" aria-expanded={saved.collapsed !== true} onClick={() => keep({ collapsed: saved.collapsed !== true })}>
              {saved.collapsed === true ? "Show" : "Fold away"}
            </button>
          )}
        </span>
      </div>
      {saved.collapsed !== true && (
        <>
          <div className="kv-gs-bar" role="progressbar" aria-label="Getting started" aria-valuemin={0} aria-valuemax={required.length} aria-valuenow={doneCount}>
            <span style={{ width: `${(doneCount / required.length) * 100}%` }} />
          </div>
          <ol className="kv-gs-steps">{required.map((s) => row(s.id, s.done))}</ol>
          <p className="kv-gs-optional-label">Optional</p>
          <ul className="kv-gs-steps">{steps.filter((s) => s.optional).map((s) => row(s.id, s.done))}</ul>
          {showTools && (
            <div className="kv-gs-tools">
              <CopyBlock label="Claude Code" value={`claude mcp add --transport http knowledge-vault ${mcp}`} onCopied={() => keep({ tools: true })} />
              <CopyBlock label="Codex" value={`codex mcp add knowledge-vault --url ${mcp}`} onCopied={() => keep({ tools: true })} />
              <CopyBlock label="Gemini CLI" value={`gemini mcp add --transport http knowledge-vault ${mcp}`} onCopied={() => keep({ tools: true })} />
              <p className="kv-hint">Run one in a terminal. The tool reaches your vault while this app is running.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
