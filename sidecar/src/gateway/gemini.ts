/**
 * Gemini 3 models sign each tool call (a "thought signature", in the OpenAI-compatible API's `extra_content`) and
 * refuse a later turn that replays the call without it: "Function call is missing a thought_signature". The chat
 * and the pipeline replay tool calls as OpenAI defines them, without that field, so the gateway remembers each
 * signature as it passes and puts it back; one it never saw (after a restart) gets the placeholder Google documents
 * for that case.
 */
export const PLACEHOLDER_SIGNATURE = "skip_thought_signature_validator";

type Extra = { google?: { thought_signature?: unknown } } & Record<string, unknown>;
type ToolCall = { id?: unknown; extra_content?: Extra } & Record<string, unknown>;

const signed = (extra: unknown): boolean => {
  const google = (extra as Extra | undefined)?.google;
  return typeof google?.thought_signature === "string" && google.thought_signature !== "";
};

export function createSignatureMemory(limit = 2000) {
  const seen = new Map<string, Extra>();
  return {
    remember(id: unknown, extra: unknown) {
      if (typeof id !== "string" || !signed(extra)) return;
      seen.delete(id);
      seen.set(id, extra as Extra);
      if (seen.size > limit) seen.delete(seen.keys().next().value as string);
    },
    recall: (id: unknown): Extra | undefined => (typeof id === "string" ? seen.get(id) : undefined),
  };
}
export type SignatureMemory = ReturnType<typeof createSignatureMemory>;

/** Every replayed tool call with its signature again: the one seen, else the placeholder on the first call of a turn. */
export function withThoughtSignatures(payload: Record<string, unknown>, memory: SignatureMemory): Record<string, unknown> {
  if (!Array.isArray(payload.messages)) return payload;
  let changed = false;
  const messages = (payload.messages as Array<Record<string, unknown>>).map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return m;
    const calls = (m.tool_calls as ToolCall[]).map((c) => {
      if (signed(c.extra_content)) return c;
      const known = memory.recall(c.id);
      return known ? { ...c, extra_content: known } : c;
    });
    if (!calls.some((c) => signed(c.extra_content))) calls[0] = { ...calls[0]!, extra_content: { google: { thought_signature: PLACEHOLDER_SIGNATURE } } };
    if (calls.every((c, i) => c === (m.tool_calls as ToolCall[])[i])) return m;
    changed = true;
    return { ...m, tool_calls: calls };
  });
  return changed ? { ...payload, messages } : payload;
}

/** Reads an answer as it passes to the client, remembering each tool call's signature; streamed or whole. */
export function signatureTap(memory: SignatureMemory, contentType: string) {
  const streamed = contentType.includes("text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "";
  const idByIndex = new Map<number, string>();
  const take = (calls: unknown) => {
    if (!Array.isArray(calls)) return;
    for (const c of calls as Array<ToolCall & { index?: unknown }>) {
      const id = typeof c.id === "string" ? c.id : typeof c.index === "number" ? idByIndex.get(c.index) : undefined;
      if (typeof c.id === "string" && typeof c.index === "number") idByIndex.set(c.index, c.id);
      memory.remember(id, c.extra_content);
    }
  };
  const read = (json: string) => {
    try {
      const body = JSON.parse(json) as { choices?: Array<{ delta?: { tool_calls?: unknown }; message?: { tool_calls?: unknown } }> };
      for (const choice of body.choices ?? []) take(choice.delta?.tool_calls ?? choice.message?.tool_calls);
    } catch {
      // not JSON: nothing to remember
    }
  };
  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      if (!streamed) return;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:") && line !== "data: [DONE]") read(line.slice(5).trim());
      }
    },
    end() {
      if (!streamed) read(buffer);
      else if (buffer.trim().startsWith("data:")) read(buffer.trim().slice(5).trim());
      buffer = "";
    },
  };
}
