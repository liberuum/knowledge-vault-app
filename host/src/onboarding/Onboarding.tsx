import { useCallback, useEffect, useRef, useState } from "react";
import "./onboarding.css";
import type { SidecarInfo } from "../sidecar.js";
import { finishOnboarding } from "./api.js";
import { AiStep } from "./AiStep.js";
import { RAIL, railState, type OnboardingStep } from "./onboarding-state.js";
import { OverviewStep, type VaultView } from "./OverviewStep.js";
import { forgetGuide } from "./progress.js";
import { SourcesStep } from "./SourcesStep.js";
import { VaultStep } from "./VaultStep.js";
import { WelcomeStep } from "./WelcomeStep.js";

const ORDER: readonly OnboardingStep[] = ["welcome", "ai", "vault", "sources", "notes"];

type Props = {
  info: SidecarInfo;
  step: OnboardingStep;
  /** The vault the guide made or chose, once it has. */
  vaultId?: string;
  onStep: (step: OnboardingStep, vaultId?: string) => void;
  /** The guide is done: open this vault, on this view. */
  onFinish: (vaultId: string, view?: VaultView) => void;
  /** Open the vault's processing, live, in Workflow Studio. */
  onRuns: (workflowId: string) => void;
  /** Skipped: back to the landing. */
  onLeave: () => void;
};

/**
 * The setup guide (spec §5, Six Minds): one decision per screen in dependency order — which AI, a vault, what to
 * add — then an overview of what the vault can do while the first sources are read. A fixed rail says where you
 * are; Skip never loses anything, and the guide does not open on its own again.
 */
export function Onboarding({ info, step, vaultId, onStep, onFinish, onRuns, onLeave }: Props) {
  // Once skipped, an answer still in flight must not pull the person back into the guide.
  const left = useRef(false);
  const go = useCallback((next: OnboardingStep, vault?: string) => !left.current && onStep(next, vault), [onStep]);
  const finish = useCallback(
    (vault: string, view?: VaultView) => {
      if (left.current) return;
      left.current = true;
      forgetGuide();
      void finishOnboarding(info, "done").catch(() => undefined);
      onFinish(vault, view);
    },
    [info, onFinish],
  );
  const skip = useCallback(() => {
    left.current = true;
    forgetGuide();
    void finishOnboarding(info, "skipped")
      .catch(() => undefined)
      .finally(onLeave);
  }, [info, onLeave]);

  // Wayfinding: a step slides in from the side it lies on — forward from the right, back from the left.
  const [shown, setShown] = useState<{ step: OnboardingStep; direction: "forward" | "back" }>({ step, direction: "forward" });
  if (shown.step !== step) setShown({ step, direction: ORDER.indexOf(step) >= ORDER.indexOf(shown.step) ? "forward" : "back" });
  const direction = shown.step === step ? shown.direction : "forward";

  // Each step announces itself: focus its heading, unless the step put focus on its own field.
  const stepRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stepRef.current?.contains(document.activeElement)) return;
    document.getElementById("onb-title")?.focus();
  }, [step]);

  return (
    <div className="kv-landing kv-onb">
      <header className="kv-header">
        <img src="/vault-icon.png" alt="" width={44} height={44} />
        <h1>Knowledge Vault</h1>
        <div className="kv-header-actions">
          {step !== "notes" && (
            <button type="button" className="kv-button kv-button-quiet" onClick={skip}>Skip for now</button>
          )}
        </div>
      </header>
      <main className="kv-onb-main">
        {step !== "welcome" && <Rail current={step} />}
        <div key={step} ref={stepRef} className="kv-onb-step" data-direction={direction}>
          {step === "welcome" && <WelcomeStep onStart={() => go("ai", vaultId)} />}
          {step === "ai" && <AiStep info={info} onBack={() => go("welcome", vaultId)} onContinue={() => go("vault", vaultId)} />}
          {step === "vault" && <VaultStep info={info} vaultId={vaultId} onBack={() => go("ai", vaultId)} onReady={(id) => go("sources", id)} />}
          {step === "sources" && <SourcesStep info={info} vaultId={vaultId} onBack={() => go("vault", vaultId)} onStarted={(id) => go("notes", id)} />}
          {step === "notes" && vaultId && <OverviewStep info={info} vaultId={vaultId} onOpen={(view) => finish(vaultId, view)} onRuns={(workflowId) => { finish(vaultId); onRuns(workflowId); }} />}
          {step === "notes" && !vaultId && <p className="kv-error">This step needs the vault the guide made. <button type="button" className="kv-link" onClick={() => go("vault")}>Back to the vault step</button></p>}
        </div>
      </main>
      <p className="kv-onb-foot">You can change all of this later in Settings.</p>
    </div>
  );
}

function Rail({ current }: { current: OnboardingStep }) {
  return (
    <ol className="kv-onb-rail" aria-label="Setup steps">
      {RAIL.map((r, i) => {
        const state = railState(current, r.step);
        return (
          <li key={r.step} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="kv-onb-dot" aria-hidden="true">{state === "done" ? "✓" : i + 1}</span>
            <span>{r.label}</span>
            {state === "done" && <span className="kv-visually-hidden"> (done)</span>}
          </li>
        );
      })}
    </ol>
  );
}
