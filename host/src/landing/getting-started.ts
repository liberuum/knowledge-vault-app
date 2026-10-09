import type { VaultSummary } from "../vaults.js";

export type StepId = "model" | "vault" | "source" | "notes" | "chat" | "graph" | "search" | "processing" | "tools";
export type StepGroup = "setup" | "explore" | "optional";
export type Step = { id: StepId; done: boolean; group: StepGroup };
export type Explored = Partial<Record<"graph" | "search" | "processing", true>>;
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
