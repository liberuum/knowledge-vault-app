import type { GuideProgress } from "./onboarding-state.js";

/** Where the setup guide got to, kept on this computer so a restart resumes there (review I4). */
const KEY = "kv-onboarding-progress";

export function guideProgress(): GuideProgress | null {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Partial<GuideProgress>) : null;
    return p && typeof p.vault === "string" && (p.step === "sources" || p.step === "notes") ? { vault: p.vault, step: p.step } : null;
  } catch {
    return null;
  }
}

export function rememberGuide(progress: GuideProgress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // storage full or blocked: the guide simply does not resume
  }
}

export function forgetGuide(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}
