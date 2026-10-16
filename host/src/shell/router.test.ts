import { describe, expect, it } from "vitest";
import { parseRoute, routeHash } from "./router.js";

describe("routes", () => {
  it("parses every screen and round-trips through the hash", () => {
    const routes = [
      { name: "vaults" }, { name: "vaults", newVault: true }, { name: "vault", id: "a b/c" }, { name: "remote", id: "c589" }, { name: "workflows" }, { name: "settings", section: "models" },
    ] as const;
    for (const r of routes) expect(parseRoute(routeHash(r))).toEqual(r);
  });
  it("opens Workflow Studio on one workflow with Studio's own fragment (#<id>), and reloads there", () => {
    expect(routeHash({ name: "workflows", workflow: "ZDdFZkX_Bs-1" })).toBe("#ZDdFZkX_Bs-1");
    expect(parseRoute("#ZDdFZkX_Bs-1")).toEqual({ name: "workflows", workflow: "ZDdFZkX_Bs-1" });
    expect(parseRoute("#/workflows")).toEqual({ name: "workflows" });
  });

  it("opens the setup guide's Workflow Studio side trip in its vault", () => {
    expect(routeHash({ name: "welcome", step: "workflows", vault: "v1" })).toBe("#/welcome/workflows/v1");
    expect(parseRoute("#/welcome/workflows/v1")).toEqual({ name: "welcome", step: "workflows", vault: "v1" });
  });

  it("lands on the vaults for an empty, unknown or malformed hash, and on the Vaults section for an unknown settings section", () => {
    expect(parseRoute("")).toEqual({ name: "vaults" });
    expect(parseRoute("#/nowhere/at/all")).toEqual({ name: "vaults" });
    expect(parseRoute("#/vault/")).toEqual({ name: "vaults" });
    expect(parseRoute("#/settings")).toEqual({ name: "settings", section: "vaults" });
    expect(parseRoute("#/settings/bogus")).toEqual({ name: "settings", section: "vaults" });
  });
});
