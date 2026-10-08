import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Rule: the engine never opens a browser. It builds the Renown sign-in link, reports it to the
 * window and polls for the result; the window opens the link. The SDK's browserLogin and
 * openBrowser spawn the browser from the engine — on Windows through `cmd /c start`, which cuts
 * the link at the first `&`, so Renown receives it without the app's identity.
 */
describe("sign-in rule: the engine does not open a browser", () => {
  const sources = ["sidecar/src/identity.ts", "sidecar/src/renown-login.ts", "sidecar/src/main.ts", "sidecar/src/control.ts"];
  for (const file of sources) {
    it(`${file} does not call the SDK's browser-opening flow or spawn a browser`, () => {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/sdk\.browserLogin|\bopenBrowser\s*\(/);
      expect(code).not.toMatch(/xdg-open|"start"|'start'/);
    });
  }
});
