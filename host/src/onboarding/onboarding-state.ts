import type { ModelSettings } from "../vaults.js";

/**
 * The setup guide's screens (spec §5): a welcome, the three prerequisites, then the overview while the vault fills —
 * and side trips off that line (spec 2026-10-15): Workflow Studio and its templates, left from and back to the
 * overview.
 */
export const ONBOARDING_STEPS = ["welcome", "ai", "vault", "sources", "notes", "workflows"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
/** Each side trip and the step it leaves from and returns to; the rail keeps that step lit meanwhile. */
export const SIDE_TRIPS = { workflows: "notes" } as const satisfies Partial<Record<OnboardingStep, OnboardingStep>>;
export type SideTrip = keyof typeof SIDE_TRIPS;
export const isSideTrip = (step: OnboardingStep): step is SideTrip => Object.hasOwn(SIDE_TRIPS, step);
/** The step on the guide's line: a side trip's own step, or the step itself. */
export const lineStep = (step: OnboardingStep): Exclude<OnboardingStep, SideTrip> => (isSideTrip(step) ? SIDE_TRIPS[step] : step);
/** Stored in config.json's ui section once the guide was finished or skipped. */
export type OnboardingState = "skipped" | "done";

/** The four-step rail: the guide's three choices, then the first notes arriving. */
export const RAIL: ReadonlyArray<{ step: Exclude<OnboardingStep, "welcome" | SideTrip>; label: string }> = [
  { step: "ai", label: "AI model" },
  { step: "vault", label: "First vault" },
  { step: "sources", label: "Add sources" },
  { step: "notes", label: "First notes" },
];

export function railState(current: OnboardingStep, item: (typeof RAIL)[number]["step"]): "done" | "current" | "todo" {
  const order = RAIL.map((r) => r.step);
  const on = lineStep(current);
  const at = on === "welcome" ? -1 : order.indexOf(on);
  const i = order.indexOf(item);
  return i < at ? "done" : i === at ? "current" : "todo";
}

/** A model processing can use: one is named, and it runs here (or on the local network) or has its key. */
export const modelReady = (m: ModelSettings): boolean => m.model.trim() !== "" && (m.local === true || m.hasKey);

/** Where the guide got to (kept on this computer): the vault it made, and the screen it was on. */
export type GuideProgress = { vault: string; step: "sources" | "notes" };

export type GateDecision =
  | { open: OnboardingStep; vault?: string }
  /** An install from before the guide: remember it is set up, so the guide never opens for it. */
  | { record: "done" }
  | null;

/**
 * Whether the app opens the setup guide when it starts, and where (spec §5, "Shown when"): only until the guide was
 * finished or skipped; from the welcome on a new install, from the first vault when a model is already set, and
 * back where it was when the guide's own vault exists. An install that had vaults before the guide never sees it.
 */
export function onboardingStart(input: {
  onboarding?: OnboardingState;
  models: ModelSettings;
  vaults: ReadonlyArray<{ id: string }>;
  remoteVaults: number;
  progress: GuideProgress | null;
}): GateDecision {
  if (input.onboarding) return null;
  if (input.vaults.length === 0 && input.remoteVaults === 0) return { open: modelReady(input.models) ? "vault" : "welcome" };
  const own = input.progress && input.vaults.some((v) => v.id === input.progress!.vault) ? input.progress : null;
  if (own) return { open: own.step, vault: own.vault };
  return { record: "done" };
}
