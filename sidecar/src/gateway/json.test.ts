import { describe, expect, it } from "vitest";
import { cleanJsonReply, JSON_INSTRUCTION, withJsonInstruction } from "./json.js";

describe("JSON whatever the model", () => {
  it("says it in words once, in the system message, only when JSON is asked for", () => {
    const ask = { model: "m", response_format: { type: "json_object" }, messages: [{ role: "system", content: "Extract claims." }, { role: "user", content: "text" }] };
    const once = withJsonInstruction(ask);
    expect((once.messages as Array<{ content: string }>)[0]!.content).toBe(`Extract claims.\n\n${JSON_INSTRUCTION}`);
    expect(withJsonInstruction(once)).toBe(once); // never twice
    const noSystem = withJsonInstruction({ model: "m", response_format: { type: "json_object" }, messages: [{ role: "user", content: "hi" }] });
    expect(noSystem.messages).toEqual([{ role: "system", content: JSON_INSTRUCTION }, { role: "user", content: "hi" }]);
    const chat = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect(withJsonInstruction(chat)).toBe(chat); // the chat's free text is left alone
  });
  it("hands back the JSON alone from a fence or prose, and leaves a clean or JSON-less answer as it is", () => {
    const reply = (content: string) => JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
    const content = (body: string) => (JSON.parse(body) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
    expect(content(cleanJsonReply(reply('```json\n{"claims": []}\n```')))).toBe('{"claims": []}');
    expect(content(cleanJsonReply(reply('Here you go: {"claims": [1]} Hope that helps.')))).toBe('{"claims": [1]}');
    expect(cleanJsonReply(reply('{"claims": []}'))).toBe(reply('{"claims": []}'));
    expect(cleanJsonReply(reply("I cannot do that."))).toBe(reply("I cannot do that."));
  });
});
