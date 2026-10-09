import { describe, expect, it } from "vitest";
import { answerChatKeyOffer, chatKeyOffer } from "./chat-key-offer.js";

const store = (entries: Record<string, string>) => {
  const m = new Map(Object.entries(entries));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const unset = { endpoint: "https://openrouter.ai/api/v1", model: "", hasKey: false, local: false, provider: "openrouter" as const };

describe("chatKeyOffer", () => {
  it("offers a key the chat saved, once, and never over a key or a model on this computer", () => {
    expect(chatKeyOffer(store({ "bai-chat-credentials:v1": "sk-or-1" }), unset)).toBe("sk-or-1");
    expect(chatKeyOffer(store({ "bai-chat-providers:v1": JSON.stringify({ openrouter: { key: "sk-or-2" } }) }), unset)).toBe("sk-or-2");
    expect(chatKeyOffer(store({ "bai-chat-providers:v1": "{not json" }), unset)).toBeNull();
    expect(chatKeyOffer(store({ "bai-chat-credentials:v1": "sk-or-1" }), { ...unset, hasKey: true })).toBeNull();
    expect(chatKeyOffer(store({ "bai-chat-credentials:v1": "sk-or-1" }), { ...unset, local: true })).toBeNull();
    const answered = store({ "bai-chat-credentials:v1": "sk-or-1" });
    answerChatKeyOffer(answered, "declined");
    expect(chatKeyOffer(answered, unset)).toBeNull();
  });
});
