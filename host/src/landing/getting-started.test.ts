import { describe, expect, it } from "vitest";
import { askedAQuestion, gettingStartedSteps, guideCardDone, guideCardVisit, nextStep, readRemembered, remember } from "./getting-started.js";

function storage(entries: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(entries));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
const facts = { modelReady: false, vaults: [], asked: false, readNotes: false, explored: {}, toolsCopied: false };

describe("getting started", () => {
  it("sets up, then explores, each step ticked from what was done", () => {
    const none = gettingStartedSteps(facts);
    expect(none.filter((s) => s.done)).toEqual([]);
    expect(none.map((s) => `${s.group}:${s.id}`)).toEqual(["setup:model", "setup:vault", "setup:source", "explore:notes", "explore:chat", "explore:graph", "explore:search", "explore:processing", "optional:tools"]);
    const some = gettingStartedSteps({ ...facts, modelReady: true, vaults: [{ id: "o", slug: "o", name: "O", noteCount: 4 }], explored: { graph: true } });
    expect(some.filter((s) => s.done).map((s) => s.id)).toEqual(["model", "vault", "source", "graph"]); // notes imply a source
  });
  it("picks one next step: set up in order, then exploring — and while the first notes are written, watching them", () => {
    const vault = { id: "o", slug: "o", name: "O", noteCount: 0 };
    expect(nextStep(gettingStartedSteps(facts), false)).toBe("model");
    expect(nextStep(gettingStartedSteps({ ...facts, modelReady: true }), false)).toBe("vault");
    expect(nextStep(gettingStartedSteps({ ...facts, modelReady: true, vaults: [vault] }), false)).toBe("source");
    // A source in, no notes yet: reading, asking, the graph and search wait; the processing can be watched now.
    const processing = gettingStartedSteps({ ...facts, modelReady: true, vaults: [{ ...vault, sourceCount: 1 }] });
    expect(nextStep(processing, false)).toBe("processing");
    // Watched already, still no notes: the first step left, which says why it waits.
    expect(nextStep(gettingStartedSteps({ ...facts, modelReady: true, vaults: [{ ...vault, sourceCount: 1 }], explored: { processing: true } }), false)).toBe("notes");
    const withNotes = gettingStartedSteps({ ...facts, modelReady: true, vaults: [{ ...vault, noteCount: 3 }], readNotes: true });
    expect(nextStep(withNotes, true)).toBe("chat");
    // Every required step done: none, whatever the optional one.
    const all = gettingStartedSteps({ ...facts, modelReady: true, vaults: [{ ...vault, noteCount: 3 }], readNotes: true, asked: true, explored: { graph: true, search: true, processing: true } });
    expect(nextStep(all, true)).toBeUndefined();
  });
  it("reads a question asked in the chat, and remembers what only this window knows", () => {
    expect(askedAQuestion(storage({ "bai-chat:v1:v": JSON.stringify([{ messages: [{ role: "assistant", content: "Hi" }] }]) }))).toBe(false);
    expect(askedAQuestion(storage({ "bai-chat:v1:v": JSON.stringify([{ messages: [{ role: "user", content: "What is X?" }] }]) }))).toBe(true);
    const s = storage();
    remember(s, { explored: { graph: true } });
    remember(s, { explored: { search: true }, hidden: true });
    expect(readRemembered(s)).toEqual({ explored: { graph: true, search: true }, hidden: true });
  });
});

describe("the setup guide's overview cards", () => {
  it("record what the front page's buttons record, so a view explored from the guide is ticked on both", () => {
    const s = storage();
    for (const card of ["notes", "graph", "search", "runs", "sources"] as const) remember(s, guideCardVisit(card));
    const saved = readRemembered(s);
    expect(saved).toEqual({ readNotes: true, explored: { graph: true, search: true, processing: true, sources: true } });
    const steps = gettingStartedSteps({ ...facts, readNotes: saved.readNotes === true, explored: saved.explored ?? {} });
    expect(steps.filter((x) => x.done).map((x) => x.id)).toEqual(["notes", "graph", "search", "processing"]);
  });

  it("tick from that record; the chat card once a question was asked, not when the chat was only opened", () => {
    expect(guideCardVisit("chat")).toEqual({});
    expect(guideCardDone("chat", {}, false)).toBe(false);
    expect(guideCardDone("chat", {}, true)).toBe(true);
    expect(guideCardDone("notes", { readNotes: true }, false)).toBe(true);
    expect(guideCardDone("runs", { explored: { processing: true } }, false)).toBe(true);
    expect(guideCardDone("graph", { explored: { search: true } }, false)).toBe(false);
    expect(guideCardDone("sources", { explored: { sources: true } }, false)).toBe(true);
  });
});
