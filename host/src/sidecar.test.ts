import { describe, expect, it } from "vitest";
import { sidecarOrigins, statusFromShell } from "./sidecar.js";

describe("sidecarOrigins", () => {
  it("derives every URL from the ports the sidecar reported, not from defaults", () => {
    expect(sidecarOrigins(4307, 4308)).toEqual({
      origin: "http://127.0.0.1:4307",
      graphqlUrl: "http://127.0.0.1:4307/graphql",
      controlOrigin: "http://127.0.0.1:4308",
    });
  });
});

describe("statusFromShell", () => {
  it("maps the shell's three states, deriving the URLs from the reported ports", () => {
    expect(statusFromShell({ state: "starting", ready: null, code: null })).toEqual({ state: "starting" });
    expect(statusFromShell({ state: "starting", ready: null, code: null, preparing: true })).toEqual({ state: "starting", preparing: true });
    expect(statusFromShell({ state: "ready", ready: { port: 4307, controlPort: 4308, controlToken: "tok" }, code: null })).toEqual({
      state: "ready",
      info: { origin: "http://127.0.0.1:4307", graphqlUrl: "http://127.0.0.1:4307/graphql", controlOrigin: "http://127.0.0.1:4308", controlToken: "tok" },
    });
    expect(statusFromShell({ state: "exited", ready: null, code: 1 })).toEqual({ state: "exited", code: 1 });
    expect(statusFromShell({ state: "exited", ready: null, code: null })).toEqual({ state: "exited", code: null });
  });
  it("maps the supervisor's richer states: restarting with its attempt and delay, gave_up with the tail, a refusal's reason, stopping", () => {
    const base = { ready: null, code: null, attempt: 0, delayMs: null, fatal: null, logTail: [] as string[] };
    expect(statusFromShell({ ...base, state: "restarting", attempt: 2, delayMs: 4000, code: 1 })).toEqual({ state: "restarting", attempt: 2, delayMs: 4000 });
    expect(statusFromShell({ ...base, state: "gave_up", attempt: 4, code: 1, logTail: ["a", "b"] })).toEqual({ state: "gave_up", code: 1, logTail: ["a", "b"], fatal: null });
    expect(statusFromShell({ ...base, state: "gave_up", attempt: 4, code: 78, fatal: { reason: "store-too-new", message: "m" } })).toEqual({ state: "gave_up", code: 78, logTail: [], fatal: { reason: "store-too-new", message: "m" } });
    expect(statusFromShell({ ...base, state: "exited", code: 78, fatal: { reason: "store-in-use", message: "busy" } })).toEqual({ state: "exited", code: 78, fatal: { reason: "store-in-use", message: "busy" } });
    expect(statusFromShell({ ...base, state: "stopping" })).toEqual({ state: "stopping" });
  });
});
