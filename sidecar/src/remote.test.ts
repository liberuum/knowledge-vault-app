import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkRemoteVault, discoverRemoteVaults, parseRemoteVaultInput, readRemoteVaults, RemoteAccessError, RemoteAuthError, RemoteInputError, RemoteNotFoundError, RemoteNotSwitchboardError, RemoteTooOldError, writeRemoteVaults } from "./remote.js";
import { writeSettings } from "./settings.js";

describe("parseRemoteVaultInput", () => {
  const origin = "https://switchboard.knowledge-vault.vetra.io";
  it("accepts every form a person pastes", () => {
    expect(parseRemoteVaultInput(`${origin}/graphql`)).toEqual({ origin });
    expect(parseRemoteVaultInput(`${origin}/graphql`, "powerhouse-knowledge")).toEqual({ origin, drive: "powerhouse-knowledge" });
    expect(parseRemoteVaultInput(`${origin}/d/powerhouse-knowledge`)).toEqual({ origin, drive: "powerhouse-knowledge" });
    expect(parseRemoteVaultInput(`${origin}/powerhouse-knowledge`)).toEqual({ origin, drive: "powerhouse-knowledge" });
    expect(parseRemoteVaultInput(`${origin}/`, " c5893e1b-854b-49b1-b8aa-6b133ab87969 ")).toEqual({ origin, drive: "c5893e1b-854b-49b1-b8aa-6b133ab87969" });
    expect(parseRemoteVaultInput("http://127.0.0.1:4001/graphql/r", "x")).toEqual({ origin: "http://127.0.0.1:4001", drive: "x" });
  });
  it("takes a bare host as https, and refuses what is not an http(s) address or a drive that cannot be decoded", () => {
    expect(parseRemoteVaultInput("switchboard.example.com")).toEqual({ origin: "https://switchboard.example.com" });
    expect(() => parseRemoteVaultInput("not a server address")).toThrow(RemoteInputError);
    expect(() => parseRemoteVaultInput("ftp://x/y")).toThrow(RemoteInputError);
    expect(() => parseRemoteVaultInput(`${origin}/graphql`, "%E0%A4%A")).toThrow(RemoteInputError);
  });
});

describe("remote vault store", () => {
  it("keeps remote vaults in config.json beside other keys and non-remote entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "kv-remote-"));
    writeSettings(dir, { models: { model: "m" } });
    const v = { kind: "remote" as const, id: "c589", slug: "pk", name: "powerhouse-knowledge", switchboardUrl: "https://s.example.com", addedAt: "2026-10-06T00:00:00Z" };
    writeRemoteVaults(dir, [v]);
    expect(readRemoteVaults(dir)).toEqual([v]);
    expect(readRemoteVaults(mkdtempSync(join(tmpdir(), "kv-remote-")))).toEqual([]);
  });
});

describe("checkRemoteVault", () => {
  const fetchFor = (driveStatus: number, canWrite: boolean) =>
    vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      if (url.includes("/d/")) {
        if (!init?.headers?.authorization?.startsWith("Bearer ")) return new Response("{}", { status: 401 });
        return driveStatus === 200 ? new Response(JSON.stringify({ id: "c589", slug: "pk", name: "powerhouse-knowledge" })) : new Response("{}", { status: driveStatus });
      }
      if (init?.body?.includes("__type")) return new Response(JSON.stringify({ data: { __type: { fields: [{ name: "document", args: [{ name: "idOrSlug" }, { name: "identifier" }] }] } } }));
      return new Response(JSON.stringify({ data: { canExecuteOperation: canWrite } }));
    }) as unknown as typeof fetch;
  it("reports the drive and whether the user may write", async () => {
    expect(await checkRemoteVault("https://s.example.com", "pk", "tok", fetchFor(200, true))).toEqual({ id: "c589", slug: "pk", name: "powerhouse-knowledge", switchboardUrl: "https://s.example.com", access: "write" });
    expect((await checkRemoteVault("https://s.example.com", "pk", "tok", fetchFor(200, false))).access).toBe("read");
  });
  it("tells apart a rejected sign-in, a missing grant and an unknown drive", async () => {
    await expect(checkRemoteVault("https://s.example.com", "pk", "tok", fetchFor(401, false))).rejects.toBeInstanceOf(RemoteAuthError);
    await expect(checkRemoteVault("https://s.example.com", "pk", "tok", fetchFor(403, false))).rejects.toBeInstanceOf(RemoteAccessError);
    await expect(checkRemoteVault("https://s.example.com", "pk", "tok", fetchFor(404, false))).rejects.toBeInstanceOf(RemoteNotFoundError);
  });
});

describe("checkRemoteVault — server version", () => {
  const server = (introspection: unknown) =>
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes("/d/")) return new Response(JSON.stringify({ id: "c589", slug: "pk", name: "pk" }));
      if (init?.body?.includes("__type")) return typeof introspection === "number" ? new Response("{}", { status: introspection }) : new Response(JSON.stringify(introspection));
      return new Response(JSON.stringify({ data: { canExecuteOperation: false } }));
    }) as unknown as typeof fetch;
  it("refuses a server older than dev.35 — its document query has no idOrSlug argument", async () => {
    const old = server({ data: { __type: { fields: [{ name: "document", args: [{ name: "identifier" }] }] } } });
    await expect(checkRemoteVault("https://old.example.com", "pk", "tok", old)).rejects.toBeInstanceOf(RemoteTooOldError);
    await expect(checkRemoteVault("https://old.example.com", "pk", "tok", old)).rejects.toThrow("This vault's server is too old for this app (it needs Powerhouse 6.2.3-dev.35 or newer).");
  });
  it("accepts a current server, and one that does not answer introspection (it cannot be told, so it is not refused)", async () => {
    expect((await checkRemoteVault("https://s.example.com", "pk", "tok", server({ data: { __type: { fields: [{ name: "document", args: [{ name: "idOrSlug" }] }] } } }))).id).toBe("c589");
    expect((await checkRemoteVault("https://s.example.com", "pk", "tok", server({ errors: [{ message: "introspection is disabled" }] }))).id).toBe("c589");
    expect((await checkRemoteVault("https://s.example.com", "pk", "tok", server(500))).id).toBe("c589");
  });
});

describe("discoverRemoteVaults", () => {
  const SB = "https://switchboard.knowledge-vault.vetra.io";
  const drives: Record<string, { id: string; slug: string; name: string; meta: { preferredEditor: string } }> = {
    c589: { id: "c589", slug: "powerhouse-knowledge", name: "Powerhouse Knowledge", meta: { preferredEditor: "knowledge-vault" } },
    team: { id: "team", slug: "team-wiki", name: "Team Wiki", meta: { preferredEditor: "knowledge-vault" } },
    flows: { id: "flows", slug: "workflows", name: "Workflows", meta: { preferredEditor: "workflow-studio" } },
  };
  /** A Switchboard at switchboard.<host>, a Connect app at <host>; `listing` is what the vault package's route answers. */
  const server = (listing: { status: number; body?: unknown }, seen: string[] = []) =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      seen.push(`${new Headers(init?.headers).get("authorization") ? "auth" : "anon"} ${url}`);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (!url.startsWith(SB)) return new Response("<!doctype html><title>Connect</title>", { status: 200, headers: { "content-type": "text/html" } });
      if (url === `${SB}/graphql`) {
        const q = String(JSON.parse(String(init?.body)).query);
        if (q.includes("__typename")) return json(200, { data: { __typename: "Query" } });
        if (q.includes("__type(")) return json(200, { data: { __type: { fields: [{ name: "document", args: [{ name: "idOrSlug" }] }] } } });
        if (q.includes("findDocuments")) return json(200, { data: { findDocuments: { items: Object.values(drives).map((d) => ({ id: d.id, name: d.slug, slug: d.slug, state: {} })) } } });
      }
      if (url === `${SB}/api/@powerhousedao/knowledge-note/drives`) return listing.body === undefined ? new Response(null, { status: listing.status }) : json(listing.status, listing.body);
      const d = url.match(/\/d\/([^/]+)$/);
      if (d) {
        const drive = Object.values(drives).find((x) => x.id === decodeURIComponent(d[1]!) || x.slug === decodeURIComponent(d[1]!));
        return drive ? json(200, drive) : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
  const listing = { status: 200, body: { drives: [{ id: "c589", name: "powerhouse-knowledge", slug: "powerhouse-knowledge", nodes: 2863 }, { id: "team", name: "team-wiki", slug: "team-wiki", nodes: 40 }] } };

  it("lists the server's vaults by their own names, marks those already added, and preselects the one a link names", async () => {
    const seen: string[] = [];
    const d = await discoverRemoteVaults("switchboard.knowledge-vault.vetra.io/d/team-wiki", "tok", new Set(["c589"]), server(listing, seen));
    expect(d).toEqual({
      switchboardUrl: SB,
      vaults: [
        { id: "c589", slug: "powerhouse-knowledge", name: "Powerhouse Knowledge", documents: 2863, added: true },
        { id: "team", slug: "team-wiki", name: "Team Wiki", documents: 40, added: false },
      ],
      hint: "team",
    });
    expect(seen.filter((l) => l.startsWith("anon"))).toEqual([]); // every request carries the person's sign-in
  });

  it("finds the Switchboard beside a Connect address, and scans its drives by preferred editor when it has no vault listing", async () => {
    const d = await discoverRemoteVaults("https://knowledge-vault.vetra.io/graphql", "tok", new Set(), server({ status: 404 }));
    expect(d.switchboardUrl).toBe(SB);
    expect(d.vaults.map((v) => v.name)).toEqual(["Powerhouse Knowledge", "Team Wiki"]); // the workflow drive is not a vault
    await expect(discoverRemoteVaults("https://example.org", "tok", new Set(), server(listing))).rejects.toBeInstanceOf(RemoteNotSwitchboardError);
  });

  it("asks a signed-out person to sign in, and a signed-in one to sign in again, when the server refuses them", async () => {
    await expect(discoverRemoteVaults(SB, undefined, new Set(), server({ status: 401 }))).rejects.toThrow("Sign in, then try again.");
    await expect(discoverRemoteVaults(SB, "stale", new Set(), server({ status: 401 }))).rejects.toThrow("Sign in again and retry.");
  });
});

