import { describe, expect, it } from "vitest";
import { askedAQuestion, gettingStartedSteps, readRemembered, remember } from "./getting-started.js";

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
  it("reads a question asked in the chat, and remembers what only this window knows", () => {
    expect(askedAQuestion(storage({ "bai-chat:v1:v": JSON.stringify([{ messages: [{ role: "assistant", content: "Hi" }] }]) }))).toBe(false);
    expect(askedAQuestion(storage({ "bai-chat:v1:v": JSON.stringify([{ messages: [{ role: "user", content: "What is X?" }] }]) }))).toBe(true);
    const s = storage();
    remember(s, { explored: { graph: true } });
    remember(s, { explored: { search: true }, hidden: true });
    expect(readRemembered(s)).toEqual({ explored: { graph: true, search: true }, hidden: true });
  });
});
