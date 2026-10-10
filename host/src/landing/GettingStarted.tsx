import { useId, useState, type CSSProperties } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { CopyBlock } from "../shell/CopyBlock.js";
import type { VaultSummary } from "../vaults.js";
import { askedAQuestion, gettingStartedSteps, NEEDS_NOTES, nextStep, readRemembered, remember, type Remembered, type Step, type StepGroup, type StepId } from "./getting-started.js";
import "./getting-started.css";

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
/** The track's stages: the required steps only. */
const STAGES: ReadonlyArray<{ group: Exclude<StepGroup, "optional">; label: string }> = [
  { group: "setup", label: "Set up" },
  { group: "explore", label: "Explore" },
];

type Props = {
  info: SidecarInfo;
  /** Local vaults, most recently opened first. */
  vaults: readonly VaultSummary[];
  modelReady: boolean;
  storage?: Storage;
  onModels?: () => void;
  onNewVault: () => void;
  /** The front page shows its vault form already (a first run, or New vault): the step points there, no second button. */
  vaultFormOpen?: boolean;
  onOpenView?: (vault: VaultSummary, view: VaultView) => void;
  onWorkflows?: () => void;
  onGuide?: () => void;
  /** Settings › Getting started, where a hidden list can be seen and brought back. */
  onOpenSettings?: () => void;
  /** "panel": the front page's, until the person hides it. "settings": always shown, with "Show on the front page". */
  variant?: "panel" | "settings";
};

/**
 * Getting started (design §5): the steps that make the app useful, each ticked from what was actually done.
 *
 * On the front page it stays out of the vaults' way: where you are (a track of the steps, by stage), the one
 * thing to do next with the only highlighted button, and the whole list a click away — until it is hidden or,
 * every step done, folds to a line. Settings shows the whole list, always, and the front-page switch.
 */
export function GettingStarted({ info, vaults, modelReady, storage, onModels, onNewVault, vaultFormOpen = false, onOpenView, onWorkflows, onGuide, onOpenSettings, variant = "panel" }: Props) {
  const [saved, setSaved] = useState<Remembered>(() => readRemembered(storage));
  const [showTools, setShowTools] = useState(false);
  const [justHidden, setJustHidden] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState<Partial<Record<StepGroup, boolean>>>({});
  const headingId = useId();
  const listId = useId();
  const switchId = useId();
  const keep = (patch: Remembered) => setSaved(remember(storage, patch));
  const hide = () => {
    keep({ hidden: true });
    setJustHidden(true);
  };

  if (variant === "panel" && saved.hidden) {
    return justHidden ? (
      <p className="kv-gs-hidden" role="status">
        <span>Getting started is hidden.</span>
        <button
          type="button"
          className="kv-link"
          onClick={() => {
            keep({ hidden: false });
            setJustHidden(false);
          }}
        >
          Undo
        </button>
        <span aria-hidden="true">·</span>
        <span>
          {onOpenSettings ? (
            <button type="button" className="kv-link" onClick={onOpenSettings}>Settings › Getting started</button>
          ) : (
            "Settings › Getting started"
          )}{" "}
          keeps it.
        </span>
      </p>
    ) : null;
  }

  const steps = gettingStartedSteps({ modelReady, vaults, asked: askedAQuestion(storage), readNotes: saved.readNotes === true, explored: saved.explored ?? {}, toolsCopied: saved.tools === true });
  const required = steps.filter((s) => s.group !== "optional");
  const doneCount = required.filter((s) => s.done).length;
  const allDone = doneCount === required.length;
  // Reading notes, the chat, the graph and search all work on notes: until a source is processed they wait.
  const hasNotes = vaults.some((v) => v.noteCount > 0);
  const next = nextStep(steps, hasNotes);
  /** The steps that read notes are waiting on the first source's processing, and watching it comes first. */
  const waitingOnNotes = next === "processing" && !hasNotes && required.some((s) => !s.done && NEEDS_NOTES.has(s.id));
  const locked = (id: StepId) => NEEDS_NOTES.has(id) && !hasNotes;
  const latest = vaults[0];
  const withNotes = vaults.find((v) => v.noteCount > 0) ?? latest;
  const mcp = `${info.origin}/mcp`;
  const count = allDone ? "Every step done" : `${doneCount} of ${required.length} steps done`;

  const button = (id: StepId, label: string, onClick: () => void) => (
    <button type="button" className={id === next ? "kv-button kv-button-primary" : "kv-button kv-gs-do"} onClick={onClick}>
      {label}
    </button>
  );
  const needsVault = <span className="kv-hint">Create a vault first.</span>;
  const afterProcessing = <span className="kv-hint">Available once a source is processed.</span>;
  const visit = (vault: VaultSummary, open: NonNullable<Props["onOpenView"]>, view: VaultView, explored?: keyof NonNullable<Remembered["explored"]>) => () => {
    if (explored) keep({ explored: { [explored]: true } });
    if (view === "notes") keep({ readNotes: true });
    open(vault, view);
  };
  const toggleTools = () => setShowTools((s) => !s);

  function action(id: StepId) {
    switch (id) {
      case "model":
        return onModels ? button(id, "Choose a model", onModels) : null;
      case "vault":
        return vaultFormOpen ? <span className="kv-hint">Name it in the form above.</span> : button(id, "Create a vault", onNewVault);
      case "source":
        if (!latest) return needsVault;
        return onOpenView ? button(id, "Add sources", () => onOpenView(latest, "sources")) : null;
      case "notes":
      case "chat":
      case "graph":
      case "search": {
        if (!hasNotes || !withNotes) return afterProcessing;
        if (!onOpenView) return null;
        const label = id === "notes" ? "Open notes" : id === "chat" ? "Ask a question" : id === "graph" ? "Open the graph" : "Search";
        return button(id, label, visit(withNotes, onOpenView, id, id === "graph" || id === "search" ? id : undefined));
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
          <button type="button" className="kv-link" aria-expanded={showTools} onClick={toggleTools}>
            {showTools ? "Hide the commands" : "Show the commands"}
          </button>
        );
    }
  }

  const tools = (
    <div className="kv-gs-tools">
      <CopyBlock label="Claude Code" value={`claude mcp add --transport http knowledge-vault ${mcp}`} onCopied={() => keep({ tools: true })} />
      <CopyBlock label="Codex" value={`codex mcp add knowledge-vault --url ${mcp}`} onCopied={() => keep({ tools: true })} />
      <CopyBlock label="Gemini CLI" value={`gemini mcp add --transport http knowledge-vault ${mcp}`} onCopied={() => keep({ tools: true })} />
      <p className="kv-hint">Run one in a terminal. The tool reaches your vault while this app is running.</p>
    </div>
  );

  function row(s: Step) {
    const state = s.done ? "done" : s.id === next ? "next" : locked(s.id) ? "waiting" : "todo";
    // The commands' toggle sits under the step's line, and the commands take the row's whole width below it.
    // They stay at hand after one was copied: a second tool needs its own.
    const inline = s.id === "tools";
    return (
      <li key={s.id} className="kv-gs-step" data-state={state} data-inline={inline || undefined}>
        <span className="kv-gs-mark" aria-hidden="true">{s.done && <CheckIcon />}</span>
        <span className="kv-gs-text">
          <strong>
            <span className="kv-visually-hidden">{s.done ? "Done: " : "To do: "}</span>
            {TEXT[s.id].title}
          </strong>
          <span>{TEXT[s.id].line}</span>
          {inline && <span className="kv-gs-inline-action">{action(s.id)}</span>}
        </span>
        {!inline && !s.done && <span className="kv-gs-action">{action(s.id)}</span>}
        {inline && showTools && tools}
      </li>
    );
  }

  const list = (
    <div id={listId} className="kv-gs-list">
      {GROUPS.map(({ group, label }) => {
        const items = steps.filter((s) => s.group === group);
        const doneIn = items.filter((s) => s.done).length;
        const complete = doneIn === items.length;
        // A finished stage folds to its line; the person can open it again.
        const open = groupOpen[group] ?? (!complete || (group === "optional" && showTools));
        const id = `${listId}-${group}`;
        return (
          <div key={group} className="kv-gs-group" data-complete={complete}>
            <button type="button" className="kv-gs-group-head" aria-expanded={open} aria-controls={id} onClick={() => setGroupOpen((g) => ({ ...g, [group]: !open }))}>
              <span className="kv-gs-group-label">{label}</span>
              <span className="kv-gs-group-count">
                {complete && <CheckIcon />}
                {complete ? "Done" : `${doneIn} of ${items.length}`}
              </span>
              <ChevronIcon />
            </button>
            {open && (
              <ol id={id} className="kv-gs-steps">
                {items.map(row)}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );

  const nextCard = next && (
    <div className="kv-gs-next" data-waiting={waitingOnNotes}>
      <span className="kv-gs-next-eyebrow">{waitingOnNotes ? "While your first notes are written" : "Next step"}</span>
      <span className="kv-gs-next-body">
        <span className="kv-gs-next-title">{TEXT[next].title}</span>
        <span className="kv-gs-next-line">{waitingOnNotes ? "Your source is being read right now. Follow it through its four steps, live." : TEXT[next].line}</span>
      </span>
      <span className="kv-gs-next-action">{action(next)}</span>
    </div>
  );

  const toolsLeft = !steps.find((s) => s.id === "tools")?.done;
  const doneCard = (
    <div className="kv-gs-done">
      <span className="kv-gs-done-mark" aria-hidden="true">
        <CheckIcon />
      </span>
      <span className="kv-gs-done-text">
        <strong>You've set it up and seen what it does.</strong>
        <span>{toolsLeft ? "One optional step is left: using your vault from Claude Code, Codex or Gemini CLI." : "The optional step too — nothing is left on this list."}</span>
      </span>
      <span className="kv-gs-done-actions">
        {toolsLeft && (
          <button
            type="button"
            className="kv-button kv-gs-do"
            onClick={() => {
              setListOpen(true);
              setShowTools(true);
            }}
          >
            Show the commands
          </button>
        )}
        <button type="button" className="kv-button kv-button-primary" onClick={hide}>
          Hide this list
        </button>
      </span>
    </div>
  );

  return (
    <section className="kv-gs" aria-labelledby={headingId} data-variant={variant} data-all-done={allDone}>
      <div className="kv-gs-head">
        <div className="kv-gs-headline">
          <h3 id={headingId} className={variant === "panel" ? "kv-gs-title" : "kv-visually-hidden"}>
            {variant === "panel" && allDone ? "You're all set" : "Getting started"}
          </h3>
          <span className="kv-gs-count">{count}</span>
        </div>
        <Track steps={steps} next={next} />
        <span className="kv-gs-head-actions">
          {onGuide && (
            <button type="button" className="kv-link" onClick={onGuide}>
              Setup guide
            </button>
          )}
          {variant === "panel" && (
            <>
              <button type="button" className="kv-button kv-button-quiet kv-gs-more" aria-expanded={listOpen} aria-controls={listId} onClick={() => setListOpen((o) => !o)}>
                {listOpen ? "Show less" : "Show all steps"}
                <ChevronIcon />
              </button>
              <button type="button" className="kv-gs-icon" aria-label="Hide Getting started" title="Hide from the front page" onClick={hide}>
                <CloseIcon />
              </button>
            </>
          )}
        </span>
      </div>

      {variant === "settings" && (
        <div className="kv-gs-pref">
          <span className="kv-gs-pref-text">
            <span id={switchId} className="kv-gs-pref-title">Show on the front page</span>
            <span className="kv-gs-pref-line">Above your vaults, with the next step first, until you hide it.</span>
          </span>
          <button type="button" role="switch" className="kv-gs-switch" aria-checked={!saved.hidden} aria-labelledby={switchId} onClick={() => keep({ hidden: !saved.hidden })} />
        </div>
      )}

      {variant === "panel" ? (
        <>
          {!listOpen && (allDone ? doneCard : nextCard)}
          {listOpen && list}
        </>
      ) : (
        list
      )}
    </section>
  );
}

/** Where you are: each required step a node in its stage — nodes and links, like a vault's graph. */
function Track({ steps, next }: { steps: readonly Step[]; next: StepId | undefined }) {
  const required = steps.filter((s) => s.group !== "optional");
  const done = required.filter((s) => s.done).length;
  let i = 0;
  return (
    <div
      className="kv-gs-track"
      role="progressbar"
      aria-label="Getting started"
      aria-valuemin={0}
      aria-valuemax={required.length}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${required.length} steps done`}
    >
      {STAGES.map(({ group, label }) => {
        const inStage = required.filter((s) => s.group === group);
        return (
          <span key={group} className="kv-gs-stage" data-done={inStage.every((s) => s.done)} data-current={inStage.some((s) => s.id === next)}>
            <span className="kv-gs-nodes">
              {inStage.map((s) => (
                <span key={s.id} className="kv-gs-node" data-state={s.done ? "done" : s.id === next ? "next" : "todo"} title={TEXT[s.id].title} style={{ "--kv-gs-i": i++ } as CSSProperties} />
              ))}
            </span>
            <span className="kv-gs-stage-label">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

const icon = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
function CheckIcon() {
  return (
    <svg {...icon} width={12} height={12} strokeWidth={3}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
function ChevronIcon() {
  return (
    <svg {...icon} width={14} height={14} strokeWidth={2} className="kv-gs-chevron">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg {...icon} width={14} height={14} strokeWidth={2}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
