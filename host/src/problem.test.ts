import { describe, expect, it } from "vitest";
import { describeProblem, plainError } from "./problem.js";

// The message graphql-request gave the user, verbatim in shape.
const yours =
  'GraphQL Error (Code: 401): {"response":{"status":401,"headers":{},"body":"{\\"error\\":\\"Credentials no longer valid\\"}"},"request":{"query":"query GetDocument($identifier: String!) { document(identifier: $identifier) { document { id } } }","variables":{"identifier":"c5893e1b"}}}';

describe("describeProblem", () => {
  it("turns the user's 401 into a Renown hiccup with retry first and a fresh sign-in second", () => {
    const p = describeProblem(new Error(yours), { what: "this vault", host: "switchboard.knowledge-vault.vetra.io", signedIn: true });
    expect(p.kind).toBe("credential-unconfirmed");
    expect(p.actions).toEqual(["retry", "resignin"]);
    expect(p.details).toBe("HTTP 401 · Credentials no longer valid");
    expect(`${p.title} ${p.body} ${p.steps.join(" ")}`).not.toMatch(/GraphQL|response|\{/);
  });

  it("reads a ClientError's own response, and tells signed-out from refused", () => {
    const err = Object.assign(new Error("x"), { response: { status: 401, body: '{"error":"Authentication required"}' } });
    expect(describeProblem(err, { signedIn: false }).actions).toEqual(["signin"]);
    expect(describeProblem(err, { signedIn: true }).actions[0]).toBe("resignin");
  });

  it("names a missing grant, a deleted vault and an unreachable server", () => {
    const forbidden = Object.assign(new Error("x"), { response: { status: 200, errors: [{ message: 'Forbidden: insufficient permissions to execute operation "document"' }] } });
    expect(describeProblem(forbidden, { address: "0xadbA7C2F82139031D7564D18aC22D09B12A0BcA4" }).body).toContain("0xadbA…BcA4");
    const missing = Object.assign(new Error("x"), { response: { status: 200, errors: [{ message: "Failed to fetch document: Document not found: abc" }] } });
    expect(describeProblem(missing, { host: "example.org" }).kind).toBe("not-found");
    expect(describeProblem(new TypeError("Load failed"), { host: "example.org" }).title).toBe("Can't reach example.org");
    expect(describeProblem(new TypeError("Failed to fetch")).title).toBe("The vault engine isn't answering");
  });
});

describe("plainError", () => {
  it("leaves the engine's sentences alone and rewrites raw failures", () => {
    expect(plainError("Enter the address of the service.")).toBe("Enter the address of the service.");
    expect(plainError(`Could not save: ${yours}`)).toBe("Could not save: Renown didn't confirm your sign-in. Try again in a moment.");
    expect(plainError(new SyntaxError("Unexpected token < in JSON at position 0"))).toMatch(/^The app couldn't read the answer\./);
  });
});
