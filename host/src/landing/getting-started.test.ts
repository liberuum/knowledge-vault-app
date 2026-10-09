import { describe, expect, it } from "vitest";
import { askedAQuestion, gettingStartedSteps, readRemembered, remember } from "./getting-started.js";

function storage(entries: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(entries));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

describe("getting started", () => {
  it("ticks each step from what was done, optional ones apart", () => {
    const none = gettingStartedSteps({ modelReady: false, vaults: [], remotes: 0, asked: false, readNotes: false, toolsCopied: false });
    expect(none.filter((s) => s.done)).toEqual([]);
    expect(none.filter((s) => s.optional).map((s) => s.id)).toEqual(["remote", "tools"]);
    const vault = { id: "v", slug: "v", name: "V", noteCount: 0, sourceCount: 2 };
    const some = gettingStartedSteps({ modelReady: true, vaults: [vault], remotes: 1, asked: false, readNotes: false, toolsCopied: false });
    expect(some.filter((s) => s.done).map((s) => s.id)).toEqual(["model", "vault", "source", "remote"]);
  });
  it("reads a question asked in the chat, and remembers what only this window knows", () => {
    expect(askedAQuestion(storage({ "bai-chat:v1:v": JSON.stringify([{ messages: [{ role: "assistant", content: "Hi" }] }]) }))).toBe(false);
    expect(askedAQuestion(storage({ "bai-chat:v1:v": JSON.stringify([{ messages: [{ role: "user", content: "What is X?" }] }]) }))).toBe(true);
    expect(askedAQuestion(storage({ "bai-chat:v1:v": "{broken" }))).toBe(false);
    const s = storage();
    remember(s, { readNotes: true });
    remember(s, { collapsed: true });
    expect(readRemembered(s)).toEqual({ readNotes: true, collapsed: true });
  });
});
