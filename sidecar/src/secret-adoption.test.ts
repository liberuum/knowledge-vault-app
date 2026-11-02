/**
 * Secrets made before the workflow runtime bound each one to the document that owns it (6.2.3-dev.85) own nothing,
 * and the runtime hands them to no connection. The released app (v0.2.5, stack 6.2.3-dev.73) made every one of its
 * secrets that way: pipeline keys, starter keys, connections made in Workflow Studio. The engine's runtime is patched
 * (patches/@powerhousedao%2Freactor-workflow@6.2.3-dev.90.patch) to give each one, once its trigger registry is seeded,
 * to the connection or workflow whose state names it. This runs that patched runtime, the one the engine loads, on its
 * real secret store over PGlite. Verified end to end on 2026-11-02 against a copy of a v0.2.5 store.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Packages as the engine resolves them: beside the installed Switchboard in bun's store. */
const switchboard = realpathSync(join(fileURLToPath(new URL("..", import.meta.url)), "node_modules/@powerhousedao/switchboard"));
const load = <T>(path: string) => import(pathToFileURL(join(switchboard, path)).href) as Promise<T>;

type Doc = { header: { id: string }; state: { global: unknown } };
type SecretStore = {
  create(input: { value: string; label: string; ownerId: string | null }): Promise<{ ref: string }>;
  stat(ref: string): Promise<{ ownerId: string | null }>;
};
type Runtime = { secrets(): Promise<SecretStore>; kvAdoptOwnerlessSecrets(): Promise<void> };

const KEY_ENV = "PH_WORKFLOWS_SECRETS_MASTER_KEY";
let pg: PGlite | undefined;
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = "ab".repeat(32);
});
afterEach(async () => {
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  await pg?.close();
  pg = undefined;
});

/** The engine's runtime over an in-memory secret store, reading `documents` (by type) as its reactor holds them. */
async function runtime(documents: Record<string, Doc[]>): Promise<Runtime> {
  const { Kysely } = await load<{ Kysely: new (options: unknown) => unknown }>("../../kysely/dist/esm/index.js");
  const { PGliteDialect } = await load<{ PGliteDialect: new (pg: PGlite) => unknown }>("../../kysely-pglite-dialect/dist/index.mjs");
  const { WorkflowRuntimeService } = await load<{ WorkflowRuntimeService: new (host: unknown) => Runtime }>("../reactor-workflow/dist/index.js");
  pg = new PGlite();
  const db = new Kysely({ dialect: new PGliteDialect(pg) });
  const quiet = () => undefined;
  return new WorkflowRuntimeService({
    relationalDb: { createNamespace: async () => db },
    reactorClient: { find: async ({ type }: { type: string }) => ({ results: documents[type] ?? [] }) },
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
  });
}

const doc = (id: string, global: unknown): Doc => ({ header: { id }, state: { global } });

describe("secrets made before secrets had owners", () => {
  it("are given to the connection or workflow whose state names them, and nothing else changes owner", async () => {
    // As the store holds them before the upgrade: no owner (OAuth app secrets keep none by design).
    let store!: SecretStore;
    const docs: Record<string, Doc[]> = {};
    const service = await runtime(docs);
    store = await service.secrets();
    const token = (await store.create({ value: "t", label: "My Vault — engine token", ownerId: null })).ref;
    const starterKey = (await store.create({ value: "k", label: "My Vault — Granola — API key", ownerId: null })).ref;
    const stepKey = (await store.create({ value: "w", label: "a workflow's own secret", ownerId: null })).ref;
    const unnamed = (await store.create({ value: "u", label: "named by nothing", ownerId: null })).ref;
    const oauthApp = (await store.create({ value: "o", label: "oauth-app:google:desktop", ownerId: null })).ref;
    const owned = (await store.create({ value: "x", label: "already owned", ownerId: "conn-other" })).ref;
    docs["powerhouse/connection"] = [
      doc("conn-pipeline", { name: "My Vault — Knowledge Vault", secretRefs: [{ id: "tok", ref: token, name: "token" }] }),
      doc("conn-granola", { name: "Granola", secretRefs: [{ id: "v", ref: starterKey, name: "value" }, { id: "o", ref: oauthApp, name: "client" }] }),
      doc("conn-thief", { name: "names an owned secret", secretRefs: [{ id: "s", ref: owned, name: "token" }] }),
    ];
    docs["powerhouse/workflow"] = [doc("wf-1", { steps: [{ id: "s1", config: { key: stepKey } }] })];

    await service.kvAdoptOwnerlessSecrets();

    const owner = async (ref: string) => (await store.stat(ref)).ownerId;
    expect(await owner(token)).toBe("conn-pipeline");
    expect(await owner(starterKey)).toBe("conn-granola");
    expect(await owner(stepKey)).toBe("wf-1");
    expect(await owner(unnamed)).toBeNull();
    expect(await owner(oauthApp)).toBeNull();
    expect(await owner(owned)).toBe("conn-other");
  });

  it("a store with no ownerless secret is left as it is", async () => {
    const docs: Record<string, Doc[]> = {};
    const service = await runtime(docs);
    const store = await service.secrets();
    const ref = (await store.create({ value: "t", label: "token", ownerId: "conn-1" })).ref;
    docs["powerhouse/connection"] = [doc("conn-2", { secretRefs: [{ id: "tok", ref, name: "token" }] })];
    await service.kvAdoptOwnerlessSecrets();
    expect((await store.stat(ref)).ownerId).toBe("conn-1");
  });
});
