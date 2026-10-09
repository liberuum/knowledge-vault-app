import type { VaultSummary } from "../vaults.js";

export type StepId = "model" | "vault" | "source" | "notes" | "chat" | "tools";
export type Step = { id: StepId; done: boolean; optional: boolean };
export type Facts = {
  modelReady: boolean;
  vaults: readonly VaultSummary[];
  asked: boolean;
  readNotes: boolean;
  toolsCopied: boolean;
};

/** The getting-started steps (design §5), in the order each needs the one before, ticked from what was done. */
export function gettingStartedSteps(f: Facts): Step[] {
  return [
    { id: "model", done: f.modelReady, optional: false },
    { id: "vault", done: f.vaults.length > 0, optional: false },
    // Any source in a vault; notes count too (they only come from sources, and older engines report no source count).
    { id: "source", done: f.vaults.some((v) => (v.sourceCount ?? 0) > 0 || v.noteCount > 0), optional: false },
    { id: "notes", done: f.readNotes, optional: false },
    { id: "chat", done: f.asked, optional: false },
    { id: "tools", done: f.toolsCopied, optional: true },
  ];
}

const KEY = "kv-getting-started:v1";
/** What only this window knows: notes read, a command copied, the list folded away, or dismissed once complete. */
export type Remembered = { readNotes?: true; tools?: true; collapsed?: boolean; hidden?: true };

export function readRemembered(storage?: Pick<Storage, "getItem">): Remembered {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Remembered) : {};
  } catch {
    return {};
  }
}
export function remember(storage: Pick<Storage, "getItem" | "setItem"> | undefined, patch: Remembered): Remembered {
  const next = { ...readRemembered(storage), ...patch };
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
  ((thread as { messages: unknown[] }).messages).some((m) => !!m && typeof m === "object" && (m as { role?: unknown }).role === "user");

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
