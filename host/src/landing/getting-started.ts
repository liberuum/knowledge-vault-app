import type { VaultSummary } from "../vaults.js";

export type StepId = "model" | "vault" | "source" | "notes" | "chat" | "graph" | "search" | "processing" | "tools";
export type StepGroup = "setup" | "explore" | "optional";
export type Step = { id: StepId; done: boolean; group: StepGroup };
/** Views opened from a step's button or a setup-guide card. `sources` is the guide's "Add more sources" card only:
 * the setup step "source" ticks from the sources a vault holds. */
export type Explored = Partial<Record<"graph" | "search" | "processing" | "sources", true>>;
export type Facts = {
  modelReady: boolean;
  vaults: readonly VaultSummary[];
  asked: boolean;
  readNotes: boolean;
  explored: Explored;
  toolsCopied: boolean;
};

/**
 * The getting-started steps (design §5; the setup guide's last screen, kept): set the app up, then explore what a
 * vault does, each ticked from what was actually done.
 */
export function gettingStartedSteps(f: Facts): Step[] {
  return [
    { id: "model", done: f.modelReady, group: "setup" },
    { id: "vault", done: f.vaults.length > 0, group: "setup" },
    // Any source in a vault; notes count too (they only come from sources, and older engines report no source count).
    { id: "source", done: f.vaults.some((v) => (v.sourceCount ?? 0) > 0 || v.noteCount > 0), group: "setup" },
    { id: "notes", done: f.readNotes, group: "explore" },
    { id: "chat", done: f.asked, group: "explore" },
    { id: "graph", done: f.explored.graph === true, group: "explore" },
    { id: "search", done: f.explored.search === true, group: "explore" },
    { id: "processing", done: f.explored.processing === true, group: "explore" },
    { id: "tools", done: f.toolsCopied, group: "optional" },
  ];
}

/** The steps that read notes: until a source has been processed into notes, they wait. */
export const NEEDS_NOTES: ReadonlySet<StepId> = new Set<StepId>(["notes", "chat", "graph", "search"]);

/**
 * The one step to do next: the first required step not done that can be done now. While the first notes are
 * still being written, the steps that read them wait, and watching the processing comes first; when nothing can
 * be done yet, the first step left (its reason shown). None once every required step is done.
 */
export function nextStep(steps: readonly Step[], hasNotes: boolean): StepId | undefined {
  const left = steps.filter((s) => s.group !== "optional" && !s.done);
  return (left.find((s) => hasNotes || !NEEDS_NOTES.has(s.id)) ?? left[0])?.id;
}

const KEY = "kv-getting-started:v1";
/** What only this window knows: notes opened, views explored, a command copied, the list closed. */
export type Remembered = { readNotes?: true; explored?: Explored; tools?: true; hidden?: boolean };

export function readRemembered(storage?: Pick<Storage, "getItem">): Remembered {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Remembered) : {};
  } catch {
    return {};
  }
}
export function remember(storage: Pick<Storage, "getItem" | "setItem"> | undefined, patch: Remembered): Remembered {
  const before = readRemembered(storage);
  const next = { ...before, ...patch, ...(patch.explored ? { explored: { ...before.explored, ...patch.explored } } : {}) };
  try {
    storage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage full or unavailable: the list still works for this visit
  }
  return next;
}

const hasUserMessage = (thread: unknown): boolean =>
  !!thread &&
  typeof thread === "object" &&
  Array.isArray((thread as { messages?: unknown }).messages) &&
  (thread as { messages: unknown[] }).messages.some((m) => !!m && typeof m === "object" && (m as { role?: unknown }).role === "user");

/** Whether the vault chat was asked anything in this window: its threads (`bai-chat:v1:<vault>`) hold a person's message. */
export function askedAQuestion(storage?: Storage): boolean {
  if (!storage || typeof storage.key !== "function") return false;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key?.startsWith("bai-chat:v1:")) continue;
    try {
      const threads: unknown = JSON.parse(storage.getItem(key) ?? "[]");
      if (Array.isArray(threads) && threads.some(hasUserMessage)) return true;
    } catch {
      // an unreadable entry is not a question asked
    }
  }
  return false;
}

/** The cards on the setup guide's overview (onboarding/OverviewStep.tsx). */
export type GuideCard = "chat" | "notes" | "graph" | "search" | "sources" | "runs";

/**
 * Whether a card on the guide's overview is done: the Getting started step it stands for, read from the same record
 * the front page reads, so opening a view from either counts on both. The chat card is done once a question was
 * asked (its step is "Ask your vault a question"), not when the chat was only opened.
 */
export function guideCardDone(card: GuideCard, saved: Remembered, asked: boolean): boolean {
  switch (card) {
    case "chat":
      return asked;
    case "notes":
      return saved.readNotes === true;
    case "runs":
      return saved.explored?.processing === true;
    default:
      return saved.explored?.[card] === true;
  }
}

/** What opening a card records: what the front page's button for that step records. */
export function guideCardVisit(card: GuideCard): Remembered {
  switch (card) {
    case "chat":
      return {};
    case "notes":
      return { readNotes: true };
    case "runs":
      return { explored: { processing: true } };
    case "graph":
      return { explored: { graph: true } };
    case "search":
      return { explored: { search: true } };
    case "sources":
      return { explored: { sources: true } };
  }
}
