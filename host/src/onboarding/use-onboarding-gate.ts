import { useEffect, useRef, useState } from "react";
import { fetchRemoteVaults } from "../api/remote.js";
import type { SidecarInfo } from "../sidecar.js";
import { fetchVaults, type AppSettings } from "../vaults.js";
import { finishOnboarding } from "./api.js";
import { onboardingStart, type OnboardingStep } from "./onboarding-state.js";
import { guideProgress } from "./progress.js";

/**
 * Once per start, from the landing: open the setup guide where an install needs it (spec §5, "Shown when").
 * `settings` are the ones App already reads (no second request). Returns whether the decision is made, so the
 * landing is not shown first and then replaced — with a short limit, so an engine that does not answer still
 * gets its landing.
 */
export function useOnboardingGate(info: SidecarInfo, onLanding: boolean, settings: AppSettings | null, open: (step: OnboardingStep, vault?: string) => void): boolean {
  const decided = useRef(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const limit = setTimeout(() => setReady(true), 3000);
    return () => clearTimeout(limit);
  }, []);
  useEffect(() => {
    if (decided.current || !onLanding || !settings) return;
    let alive = true;
    Promise.all([fetchVaults(info), fetchRemoteVaults(info).catch(() => [])])
      .then(([local, remote]) => {
        if (!alive || decided.current) return;
        decided.current = true;
        const decision = onboardingStart({ onboarding: settings.ui?.onboarding, models: settings.models, vaults: local, remoteVaults: remote.length, progress: guideProgress() });
        if (decision && "record" in decision) void finishOnboarding(info, "done").catch(() => undefined);
        else if (decision) open(decision.open, decision.vault);
        setReady(true);
      })
      .catch(() => setReady(true)); // an engine that does not answer is shown elsewhere; the landing stays
    return () => {
      alive = false;
    };
  }, [info, onLanding, settings, open]);
  return ready || decided.current;
}
