import { useEffect, useId, useState, type FormEvent } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { fetchPipeline, fetchVaults, type PipelineStatus } from "../vaults.js";
import { plainError } from "../problem.js";
import { addStarter, listStarters, type AddedStarter, type StarterSummary } from "./api.js";
import { CardIcon } from "./CardIcon.js";
import { addedLine, CATALOGUE_URL, STARTERS, WORKS_WITH, type StarterCard } from "./starters.js";

type Props = {
  info: SidecarInfo;
  vaultId: string;
  /** Back to the overview this side trip left from. */
  onBack: () => void;
  /** Open Workflow Studio, on one workflow when given; the guide stays one click away in Studio's top bar. */
  onStudio: (workflowId?: string) => void;
};

/** The vault's pipeline, as Studio draws it: what starts it, then its four steps (Memory: the person's own workflow). */
const PIPELINE: ReadonlyArray<{ label: string; kind: "trigger" | "step" }> = [
  { label: "Source queued", kind: "trigger" },
  { label: "Extract claims", kind: "step" },
  { label: "Connect notes", kind: "step" },
  { label: "Place in maps", kind: "step" },
  { label: "Check notes", kind: "step" },
];

/**
 * The setup guide's side trip into Workflow Studio (spec 2026-10-15, Six Minds): what Studio is — drawn from the
 * workflow the vault already runs —, how one is started, then three templates that are made, checked and switched
 * on from here. Every way out is named: back to the overview, or on into Studio.
 */
export function WorkflowsStep({ info, vaultId, onBack, onStudio }: Props) {
  const [vaultName, setVaultName] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [running, setRunning] = useState<StarterSummary[]>([]);
  const [open, setOpen] = useState<StarterCard["id"] | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchVaults(info)
      .then((list) => alive && setVaultName(list.find((v) => v.id === vaultId)?.name ?? null))
      .catch(() => undefined);
    void fetchPipeline(info, vaultId)
      .then((p) => alive && setPipeline(p))
      .catch(() => undefined);
    void listStarters(info, vaultId)
      .then((list) => alive && setRunning(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [info, vaultId]);

  const pipelineId = pipeline && (pipeline.state === "ready" || pipeline.state === "stale") ? pipeline.workflowId : undefined;
  // Templates add to the vault through its processing's connection: without one there is nothing to add with.
  const canAdd = pipeline === null || pipeline.state === "ready" || pipeline.state === "stale" || pipeline.state === "starting";
  const live = pipeline?.state === "ready";

  return (
    <section aria-labelledby="onb-title" className="kv-wf">
      <nav className="kv-wf-crumbs" aria-label="Where you are">
        <button type="button" className="kv-link kv-wf-crumb-back" onClick={onBack}>
          <span aria-hidden="true">←</span> Your vault is filling up
        </button>
        <span className="kv-wf-trip">Side trip</span>
      </nav>
      <h2 id="onb-title" className="kv-onb-title" tabIndex={-1}>Let your vault fill itself</h2>
      <p className="kv-onb-lead">
        Workflow Studio runs small automations for your vaults. Each one waits for something to happen, then does a few steps on its own — and{" "}
        {vaultName ? <strong>{vaultName}</strong> : "your vault"} already runs one.
      </p>

      <ol className="kv-wf-sections">
        <li className="kv-wf-section" aria-labelledby="wf-what">
          <h3 id="wf-what" className="kv-wf-heading">What Workflow Studio is</h3>
          <div className="kv-wf-flow-card">
            <div className="kv-wf-flow-head">
              <span className="kv-wf-live" data-live={live}>{live ? "Running in your vault" : "Your vault's processing"}</span>
              {pipelineId && (
                <button type="button" className="kv-link" onClick={() => onStudio(pipelineId)}>
                  See it in Studio
                </button>
              )}
            </div>
            <ol className="kv-wf-flow" aria-label="Your vault's processing, as a workflow">
              {PIPELINE.map((p, i) => (
                <li key={p.label} data-kind={p.kind}>
                  <span className="kv-wf-chip">{p.label}</span>
                  <span className="kv-wf-chip-kind">{p.kind === "trigger" ? "trigger" : `step ${i}`}</span>
                </li>
              ))}
            </ol>
            <p className="kv-wf-flow-note kv-hint">
              In Studio this is a <em>trigger</em> and four <em>steps</em>. Every <em>run</em> is kept: what each step did, how long it took and what it cost.
            </p>
          </div>
        </li>

        <li className="kv-wf-section" aria-labelledby="wf-how">
          <h3 id="wf-how" className="kv-wf-heading">How you start one</h3>
          <ol className="kv-wf-how">
            <li>
              <strong>Choose what starts it</strong>
              <span>A schedule, a new post in a feed, a new email, a message sent to an address on this computer.</span>
            </li>
            <li>
              <strong>Add its steps</strong>
              <span>From 700+ connectors by Activepieces, and the vault's own: add a source, extract, search.</span>
            </li>
            <li>
              <strong>Switch it on</strong>
              <span>It runs by itself from then on. Switch it off, change it or delete it any time.</span>
            </li>
          </ol>
          <div className="kv-wf-works" aria-label="Works with">
            <span className="kv-wf-works-label">Works with</span>
            {WORKS_WITH.map((w) => (
              <span key={w.name} className="kv-wf-works-item">
                <img src={w.src} alt="" width={18} height={18} />
                {w.name}
              </span>
            ))}
            <a className="kv-wf-works-more" href={CATALOGUE_URL} target="_blank" rel="noreferrer">
              700+ more
            </a>
          </div>
          <p className="kv-hint kv-wf-works-note">
            A connector is downloaded from Activepieces the first time you use one. Some ask for a key from your account with that service; a few need an app you register with it first.
          </p>
        </li>

        <li className="kv-wf-section" aria-labelledby="wf-templates">
          <h3 id="wf-templates" className="kv-wf-heading">Start from a template</h3>
          <p className="kv-hint kv-wf-templates-lead">Each is an ordinary workflow: added here in a minute, then yours to change in Studio.</p>
          {!canAdd && (
            <p className="kv-onb-callout kv-wf-blocked" role="status">
              <span className="kv-onb-callout-body">
                <strong>Templates need this vault's processing</strong>
                <span>Choose an AI model in Settings › Models, then come back: the templates add their sources through it.</span>
              </span>
            </p>
          )}
          <ul className="kv-wf-templates">
            {STARTERS.map((card) => (
              <TemplateCard
                key={card.id}
                card={card}
                info={info}
                vaultId={vaultId}
                vaultName={vaultName}
                disabled={!canAdd}
                open={open === card.id}
                onToggle={() => setOpen((current) => (current === card.id ? null : card.id))}
                running={running.filter((r) => r.starter === card.id)}
                onAdded={(added) => setRunning((list) => [...list, added])}
                onStudio={onStudio}
              />
            ))}
          </ul>
        </li>
      </ol>

      <div className="kv-onb-actions">
        <button type="button" className="kv-button" onClick={() => onStudio()}>
          Open Workflow Studio
        </button>
        <button type="button" className="kv-button kv-button-primary" onClick={onBack}>
          Back to setup
        </button>
      </div>
    </section>
  );
}

function TemplateCard(props: {
  card: StarterCard;
  info: SidecarInfo;
  vaultId: string;
  vaultName: string | null;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  running: StarterSummary[];
  onAdded: (added: AddedStarter) => void;
  onStudio: (workflowId?: string) => void;
}) {
  const { card, open } = props;
  const formId = useId();
  const fieldId = useId();
  const hintId = useId();
  const processHintId = useId();
  const [value, setValue] = useState("");
  const [process, setProcess] = useState(true);
  const [backfill, setBackfill] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ added: AddedStarter; line: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const added = await addStarter(props.info, props.vaultId, { starter: card.id, [card.field.name]: value.trim(), process, backfill });
      setDone({ added, line: addedLine(card, added, backfill) });
      setValue("");
      props.onAdded(added);
    } catch (err) {
      setError(plainError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="kv-wf-template" data-open={open} data-done={done !== null}>
      <button type="button" className="kv-wf-template-head" aria-expanded={open} aria-controls={formId} onClick={props.onToggle} disabled={props.disabled}>
        <span className="kv-wf-pair" aria-hidden="true">
          {card.logo === "paper" ? (
            <span className="kv-wf-logo kv-wf-logo-mark">
              <CardIcon view="notes" />
            </span>
          ) : (
            <img className="kv-wf-logo" src={card.logo.src} alt="" width={32} height={32} />
          )}
          <span className="kv-wf-arrow">→</span>
          <img className="kv-wf-logo kv-wf-logo-vault" src="/vault-icon.png" alt="" width={32} height={32} />
        </span>
        <span className="kv-wf-template-text">
          <strong>{card.title}</strong>
          <span>{card.line}</span>
        </span>
        <span className="kv-wf-tag" data-key={card.id === "granola"}>{card.needs}</span>
        <span className="kv-wf-chevron" aria-hidden="true" />
      </button>

      {props.running.length > 0 && !open && (
        <ul className="kv-wf-running" aria-label={`${card.title}: on in this vault`}>
          {props.running.map((r) => (
            <li key={r.workflowId}>
              <span className="kv-wf-on" data-on={r.status === "ENABLED"}>{r.status === "ENABLED" ? "On" : "Off"}</span>
              <span className="kv-wf-running-label">{r.label}</span>
              <button type="button" className="kv-link" onClick={() => props.onStudio(r.workflowId)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div id={formId} className="kv-wf-template-body">
          {done ? (
            <div className="kv-wf-done" role="status">
              <p className="kv-onb-ok">{done.line}</p>
              {done.added.addError && <p className="kv-hint">One could not be added: {plainError(done.added.addError)}. Studio shows that run.</p>}
              <div className="kv-wf-done-actions">
                <button type="button" className="kv-button" onClick={() => props.onStudio(done.added.workflowId)}>
                  Open it in Studio
                </button>
                {card.id !== "granola" && (
                  <button type="button" className="kv-link" onClick={() => setDone(null)}>
                    Add another
                  </button>
                )}
              </div>
            </div>
          ) : (
            <form onSubmit={(e) => void submit(e)} noValidate>
              <label htmlFor={fieldId} className="kv-onb-label">{card.field.label}</label>
              <input
                id={fieldId}
                className="kv-onb-input"
                type={card.field.secret ? "password" : "text"}
                inputMode={card.field.inputMode}
                autoComplete="off"
                spellCheck={false}
                placeholder={card.field.placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-describedby={hintId}
                aria-invalid={error ? true : undefined}
                disabled={busy}
                autoFocus
              />
              <p id={hintId} className="kv-hint kv-wf-field-hint">{card.field.hint}</p>
              <div className="kv-wf-options">
                <label className="kv-onb-check">
                  <input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} disabled={busy} />
                  <span>{card.backfillLabel}</span>
                </label>
                <div>
                  <label className="kv-onb-check">
                    <input type="checkbox" checked={process} onChange={(e) => setProcess(e.target.checked)} disabled={busy} aria-describedby={processHintId} />
                    <span>Turn what arrives into notes</span>
                  </label>
                  <p id={processHintId} className="kv-hint kv-wf-option-hint">
                    Each one is read by your AI model, like a source you add. Off: they wait in Sources until you queue them.
                  </p>
                </div>
              </div>
              <p className="kv-onb-assure">
                <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden="true">
                  <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                {card.assurance}
              </p>
              {error && (
                <p role="alert" className="kv-error kv-wf-error">
                  {error}
                </p>
              )}
              <div className="kv-wf-form-actions">
                <p className="kv-hint kv-wf-chain">
                  <span>In Studio: </span>
                  {card.chain}
                </p>
                <button type="submit" className="kv-button kv-button-primary" disabled={busy || !value.trim()}>
                  {busy ? (card.id === "granola" ? "Checking the key…" : "Checking and adding…") : `Add to ${props.vaultName ?? "my vault"}`}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </li>
  );
}
