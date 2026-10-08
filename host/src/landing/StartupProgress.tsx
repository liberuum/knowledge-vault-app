import { redact } from "../redact.js";
import { currentStageIndex, STAGES, type Progress } from "./startup-stages.js";

/**
 * The landing while the engine starts: a checklist of what is being brought up, with the
 * engine's latest line underneath so a long start (Windows' first launch unpacks the engine;
 * a large store takes seconds to open) is visibly moving. Reduced motion keeps the ticks and
 * drops the spinner.
 */
export function StartupProgress({ progress, preparing }: { progress: Progress; preparing: boolean }) {
  // The unpack row only exists on the launches that unpack (Windows, first start of a version).
  const unpackSeen = preparing;
  const rows = unpackSeen ? STAGES : STAGES.slice(1);
  const offset = unpackSeen ? 0 : 1;
  const current = currentStageIndex(progress, preparing);
  return (
    <section className="kv-startup" aria-labelledby="kv-startup-title" aria-live="polite" aria-busy="true">
      <div className="kv-startup-head">
        <span className="kv-spinner" aria-hidden="true" />
        <h3 id="kv-startup-title" className="kv-startup-title">Starting the vault engine</h3>
      </div>
      <ol className="kv-startup-stages">
        {rows.map((stage, i) => {
          const index = i + offset;
          const state = index < current ? "done" : index === current ? "current" : "pending";
          return (
            <li key={stage.id} className="kv-startup-stage" data-state={state}>
              <span className="kv-startup-mark" aria-hidden="true">{state === "done" ? "✓" : state === "current" ? "•" : "○"}</span>
              <span>{stage.label}</span>
            </li>
          );
        })}
      </ol>
      {progress.latest && (
        <p className="kv-startup-latest" title="The engine's latest line">
          {redact(progress.latest)}
        </p>
      )}
    </section>
  );
}
