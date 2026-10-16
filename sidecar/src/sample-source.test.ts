import { describe, expect, it } from "vitest";
import { SAMPLE_SOURCE } from "./sample-source.js";

const text = SAMPLE_SOURCE.content;
const paragraphs = text.split("\n\n");

describe("the built-in guide source", () => {
  it("does not say the chat only reads the vault", () => {
    expect(text).not.toContain("A chat that only reads the vault");
    expect(text).not.toContain("it cannot damage a note");
  });
  it("keeps one claim per paragraph about the chat", () => {
    const first = "An answer that cites the notes it used can be checked by opening them; an answer from a model's general knowledge cannot be. That is why the vault's chat answers from your notes and names them.";
    const second = "A chat that cannot change anything on its own can be trusted with the vault. It can offer to save an answer as a note or to change the work in your projects, but it shows each change first, and nothing is written until you apply it.";
    expect(paragraphs).toContain(first);
    expect(paragraphs.indexOf(second)).toBe(paragraphs.indexOf(first) + 1);
  });
  it("says a new note waits in review, not that it is a draft", () => {
    expect(text).not.toContain("A new note is a draft");
    expect(paragraphs).toContain("A new note waits in review until you approve it. The verify step reports which notes are ready to approve and which need a closer look, and approving a note makes it the vault's settled view.");
  });
  it("says how many sources run at once, by model", () => {
    expect(text).not.toContain("one source after another");
    expect(text).toContain("so processing runs in the background while you keep working: one source at a time with a model on this computer, a few at once with a hosted one.");
  });
  it("keeps what was already true", () => {
    for (const s of ["a map is only made once a theme has three or more notes".toLowerCase(), "the archived note leaves search", "nothing you add is sent anywhere by default"]) {
      expect(text.toLowerCase()).toContain(s);
    }
  });
});
