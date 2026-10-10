import { describe, expect, it } from "vitest";
import { newSince, readSeen, rememberSeen, SEEN_KEY } from "./seen.js";

function store(entries: Record<string, string> = {}) {
  const m = new Map(Object.entries(entries));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("notes seen on the front page", () => {
  it("calls new only what grew since a vault was last shown", () => {
    expect(newSince({}, { a: 12 })).toEqual({}); // never shown: nothing is new
    expect(newSince({ a: 10, b: 5, c: 9 }, { a: 22, b: 5, c: 4 })).toEqual({ a: 12 }); // same, or fewer (notes archived): not new
  });
  it("remembers what each visit showed, keeping vaults not listed this time", () => {
    const s = store({ [SEEN_KEY]: JSON.stringify({ remote: 40, a: 1 }) });
    rememberSeen(s, { a: 22, b: 3 });
    expect(readSeen(s)).toEqual({ remote: 40, a: 22, b: 3 });
  });
  it("reads a damaged or foreign value as nothing seen", () => {
    expect(readSeen(store({ [SEEN_KEY]: "not json" }))).toEqual({});
    expect(readSeen(store({ [SEEN_KEY]: JSON.stringify([1, 2]) }))).toEqual({});
    expect(readSeen(store({ [SEEN_KEY]: JSON.stringify({ a: "3", b: -1, c: 4 }) }))).toEqual({ c: 4 });
    expect(readSeen(undefined)).toEqual({});
  });
});
