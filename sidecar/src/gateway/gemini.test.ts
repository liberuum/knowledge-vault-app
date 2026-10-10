import { describe, expect, it } from "vitest";
import { createSignatureMemory, PLACEHOLDER_SIGNATURE, signatureTap, withThoughtSignatures } from "./gemini.js";

const call = (id: string, signature?: string) => ({ id, type: "function", function: { name: "search_vault", arguments: "{}" }, ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}) });
const turn = (...calls: object[]) => ({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "q" }, { role: "assistant", content: null, tool_calls: calls }, { role: "tool", tool_call_id: "c1", content: "r" }] });
const callsOf = (p: Record<string, unknown>) => (p.messages as Array<{ tool_calls?: Array<{ extra_content?: { google: { thought_signature: string } } }> }>)[1]!.tool_calls!;

describe("Gemini's thought signatures", () => {
  it("remembers each signature from a streamed answer, and puts it back on the replayed call", () => {
    const memory = createSignatureMemory();
    const tap = signatureTap(memory, "text/event-stream");
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "search_vault", arguments: "{}" }, extra_content: { google: { thought_signature: "sig-1" } } }] } }] })}\n\ndata: [DONE]\n\n`;
    tap.push(new TextEncoder().encode(sse.slice(0, 40)));
    tap.push(new TextEncoder().encode(sse.slice(40)));
    tap.end();
    expect(callsOf(withThoughtSignatures(turn(call("c1")), memory))[0]!.extra_content!.google.thought_signature).toBe("sig-1");
  });
  it("remembers from a whole answer too, and gives a call it never saw Google's placeholder, on the first call only", () => {
    const memory = createSignatureMemory();
    const tap = signatureTap(memory, "application/json");
    tap.push(new TextEncoder().encode(JSON.stringify({ choices: [{ message: { tool_calls: [call("c9", "sig-9")] } }] })));
    tap.end();
    expect(memory.recall("c9")).toEqual({ google: { thought_signature: "sig-9" } });
    const unknown = callsOf(withThoughtSignatures(turn(call("x1"), call("x2")), memory));
    expect(unknown[0]!.extra_content!.google.thought_signature).toBe(PLACEHOLDER_SIGNATURE);
    expect(unknown[1]!.extra_content).toBeUndefined();
    const already = turn(call("c1", "own"));
    expect(withThoughtSignatures(already, memory)).toBe(already);
    const plain = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect(withThoughtSignatures(plain, memory)).toBe(plain);
  });
});
