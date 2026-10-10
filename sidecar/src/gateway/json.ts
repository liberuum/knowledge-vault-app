/**
 * A request that asks for JSON gets JSON, whatever the model. `response_format` is a request some models ignore and
 * some refuse (the gateway then asks again without it), so the request also says it in words; and an answer that
 * still wraps its JSON in a code fence or prose is handed back as the JSON alone.
 */
export const JSON_INSTRUCTION = "Reply with a single valid JSON object and nothing else: no text before or after it, and no Markdown code fences.";

type Message = { role?: unknown; content?: unknown };

/** The instruction, once, in the request's system message (a system message of its own when there is none). */
export function withJsonInstruction(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.response_format === undefined || payload.response_format === null) return payload;
  const messages = (Array.isArray(payload.messages) ? payload.messages : []) as Message[];
  if (JSON.stringify(messages).includes(JSON_INSTRUCTION)) return payload;
  const next = messages.map((m) => ({ ...m }));
  const system = next.find((m) => m.role === "system" || m.role === "developer");
  if (system && typeof system.content === "string") system.content = `${system.content}\n\n${JSON_INSTRUCTION}`;
  else if (system && Array.isArray(system.content)) system.content = [...(system.content as unknown[]), { type: "text", text: JSON_INSTRUCTION }];
  else next.unshift({ role: "system", content: JSON_INSTRUCTION });
  return { ...payload, messages: next };
}

/** The JSON inside an answer: as it is, from a code fence, or the outermost object or array in prose; null when there is none. */
export function extractJson(text: string): string | null {
  const t = text.trim();
  const parses = (s: string) => {
    try {
      JSON.parse(s);
      return true;
    } catch {
      return false;
    }
  };
  if (parses(t)) return t;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence && parses(fence[1]!.trim())) return fence[1]!.trim();
  const start = t.search(/[{[]/);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (start >= 0 && end > start && parses(t.slice(start, end + 1))) return t.slice(start, end + 1);
  return null;
}

/** A chat completion whose answers are the JSON alone; unchanged when it is already, or holds none. */
export function cleanJsonReply(bodyText: string): string {
  let body: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    body = JSON.parse(bodyText) as typeof body;
  } catch {
    return bodyText;
  }
  if (!Array.isArray(body.choices)) return bodyText;
  let changed = false;
  for (const choice of body.choices) {
    const message = choice?.message;
    if (!message || typeof message.content !== "string") continue;
    const json = extractJson(message.content);
    if (json !== null && json !== message.content) {
      message.content = json;
      changed = true;
    }
  }
  return changed ? JSON.stringify(body) : bodyText;
}
