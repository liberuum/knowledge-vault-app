import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OPENROUTER_DASHBOARD, ProviderChoice } from "./ProviderChoice.js";

type ChoiceProps = Parameters<typeof ProviderChoice>[0];

const render = (overrides: Partial<ChoiceProps>) =>
  renderToStaticMarkup(
    <ProviderChoice
      {...({
        choice: "openrouter",
        onChoice: () => {},
        apiKey: "",
        onApiKey: () => {},
        hasKey: false,
        onOpenRouterSignIn: () => {},
        signingIn: false,
        service: "openai",
        onService: () => {},
        customEndpoint: "",
        localBlock: null,
        onCustomEndpoint: () => {},
        ...overrides,
      } as ChoiceProps)}
    />,
  );

describe("the OpenRouter card", () => {
  it("offers to sign in while no key is saved", () => {
    const html = render({ hasKey: false });
    expect(html).toContain("Sign in with OpenRouter");
    expect(html).not.toContain(OPENROUTER_DASHBOARD);
  });

  it("links to the OpenRouter dashboard once signed in, instead of signing in again", () => {
    const html = render({ hasKey: true });
    expect(html).not.toContain("Sign in with OpenRouter");
    expect(html).toContain(`href="${OPENROUTER_DASHBOARD}"`);
    expect(html).toContain("OpenRouter dashboard");
  });

  it("shows no key field until the person chooses to paste a key", () => {
    const html = render({ hasKey: false });
    expect(html).not.toContain('id="models-key"');
    expect(html).toContain("or paste a key");
  });

  it("shows the field while a pasted key is being typed", () => {
    expect(render({ hasKey: false, apiKey: "sk-or-1" })).toContain('id="models-key"');
  });

  it("shows a saved key as saved, with Remove key and no field", () => {
    const html = render({ hasKey: true, onRemoveKey: () => {} });
    expect(html).not.toContain('id="models-key"');
    expect(html).toContain("Saved on this computer");
    expect(html).toContain("Remove key");
  });
});
