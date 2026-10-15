import { describe, expect, it } from "vitest";
import { chatGptFailureFromBody, pageName, providerMessage } from "./errors.js";

/** Cloudflare's page for ChatGPT's 504, as it began in the failure the chat showed: cut off before its title. */
const CUT_OFF =
  '<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->';
const TITLED = "<!DOCTYPE html><html><head><title>chatgpt.com | 502: Bad gateway</title></head><body>…</body></html>";

describe("error pages are named, never pasted", () => {
  it("takes the page's title, or the status's name when the page is cut short", () => {
    expect(pageName(TITLED, 502)).toBe("Bad gateway");
    expect(pageName(CUT_OFF, 504)).toBe("Gateway time-out");
    expect(pageName(CUT_OFF)).toBe("an error page");
  });

  it("leaves anything that is not a page alone", () => {
    expect(pageName('{"error":{"message":"x"}}', 400)).toBeUndefined();
    expect(pageName("upstream connect error", 503)).toBeUndefined();
  });

  it("says a ChatGPT timeout is ChatGPT's, and what to do", () => {
    const f = chatGptFailureFromBody(504, CUT_OFF, "req-1");
    expect(f).toMatchObject({ status: 504, code: "provider_error", requestId: "req-1" });
    expect(f.message).toBe("ChatGPT did not answer in time (HTTP 504: Gateway time-out). This is on ChatGPT's side; try again in a minute.");
    expect(f.message).not.toContain("<");
    expect(chatGptFailureFromBody(502, TITLED).message).toBe(
      "ChatGPT did not answer in time (HTTP 502: Bad gateway). This is on ChatGPT's side; try again in a minute.",
    );
  });

  it("does the same for every other provider", () => {
    expect(providerMessage("openrouter", 504, CUT_OFF).message).toBe(
      "OpenRouter did not answer in time (HTTP 504: Gateway time-out). This is on its side; try again in a minute.",
    );
    expect(providerMessage("anthropic", 529, '{"error":{"message":"Overloaded"}}').message).toBe(
      "Anthropic did not answer in time (HTTP 529: Overloaded). This is on its side; try again in a minute.",
    );
  });

  it("keeps a refusal that is not momentary in the provider's own words", () => {
    expect(
      providerMessage("local", 400, '{"error":{"message":"the request exceeds the available context size, try increasing it"}}').message,
    ).toBe("The model server on this computer answered 400: the request exceeds the available context size, try increasing it");
  });
});
