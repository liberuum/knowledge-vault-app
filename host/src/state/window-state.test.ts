import { describe, expect, it } from "vitest";
import { adoptStore } from "./window-state.js";

function storage(entries: Record<string, string>): Storage {
  const m = new Map(Object.entries(entries));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

describe("adoptStore", () => {
  it("remembers the first store without clearing, and clears the old store's window state for a new one", () => {
    const s = storage({ "kv-onboarding-progress": "{}", "bai-chat:v1:old": "[]", "ph:theme": "dark" });
    expect(adoptStore(s, "store-1")).toBe(false); // an install from before store ids loses nothing
    expect(s.getItem("kv-onboarding-progress")).toBe("{}");
    expect(adoptStore(s, "store-1")).toBe(false);
    expect(adoptStore(s, "store-2")).toBe(true);
    expect(s.getItem("kv-onboarding-progress")).toBeNull();
    expect(s.getItem("bai-chat:v1:old")).toBeNull();
    expect(s.getItem("ph:theme")).toBe("dark");
    expect(s.getItem("kv-store-id")).toBe("store-2");
  });
});
