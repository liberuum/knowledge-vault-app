/**
 * The engine's PGlite store maintenance collects planner statistics
 * (patches/@powerhousedao%2Freactor-api@6.2.3-dev.85.patch). Without them Postgres plans from its
 * defaults: on a 930 MB store the sync outbox query took 5 s per page instead of 105 ms, and the
 * first write after a start stalled the store for minutes. This runs the maintenance the engine
 * actually loads — the reactor-api beside the installed Switchboard — so a stack bump that drops
 * the patch fails here rather than in a user's vault.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

type Maintenance = {
  start(pg: PGlite, label: string, baseBytes: number): void;
  noteSync(): void;
  run(): Promise<string>;
  stop(): Promise<void>;
};
type PgliteNode = { PgliteMaintenance: new (options?: { intervalMs?: number; vacuumFullAboveBytes?: number }) => Maintenance };

async function engineMaintenance(): Promise<Maintenance> {
  const sidecar = fileURLToPath(new URL("..", import.meta.url));
  const switchboard = realpathSync(join(sidecar, "node_modules/@powerhousedao/switchboard"));
  const entry = join(switchboard, "../reactor-api/dist/src/pglite/pglite-node.mjs");
  const { PgliteMaintenance } = (await import(pathToFileURL(entry).href)) as PgliteNode;
  // intervalMs 0: no timer; the test runs each pass itself.
  return new PgliteMaintenance({ intervalMs: 0, vacuumFullAboveBytes: 0 });
}

async function hasStatistics(pg: PGlite, table: string): Promise<boolean> {
  const { rows } = await pg.query<{ n: number }>(
    `select count(*)::int as n from pg_statistic where starelid = $1::regclass`,
    [table],
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** A table with rows that VACUUM has counted, as a running store's are, but no statistics. */
async function counted(pg: PGlite, table: string): Promise<void> {
  await pg.exec(`create table ${table} (id int, kind text); insert into ${table} select g, 'k' || (g % 7) from generate_series(1, 2000) g;`);
  await pg.exec(`vacuum ${table}`);
}

let pg: PGlite | undefined;
let maintenance: Maintenance | undefined;
afterEach(async () => {
  await maintenance?.stop();
  await pg?.close();
  pg = undefined;
  maintenance = undefined;
});

describe("store maintenance collects planner statistics", () => {
  it("analyzes a store without statistics on its first pass, once", async () => {
    pg = new PGlite();
    await pg.exec("create schema reactor");
    await counted(pg, "reactor.operations");
    expect(await hasStatistics(pg, "reactor.operations")).toBe(false);

    maintenance = await engineMaintenance();
    maintenance.start(pg, "test-store", 0);
    expect(await maintenance.run()).toBe("analyze");
    expect(await hasStatistics(pg, "reactor.operations")).toBe(true);
    // Checked once per open; with no writes since, later passes have nothing to do.
    expect(await maintenance.run()).toBe("idle");
  });

  it("leaves a store that has statistics alone on its first pass", async () => {
    pg = new PGlite();
    await counted(pg, "public.notes");
    await pg.exec("analyze");
    maintenance = await engineMaintenance();
    maintenance.start(pg, "test-store", 0);
    expect(await maintenance.run()).toBe("idle");
  });

  it("refreshes statistics in every pass that follows writes", async () => {
    pg = new PGlite();
    await pg.waitReady;
    maintenance = await engineMaintenance();
    maintenance.start(pg, "test-store", 0);
    expect(await maintenance.run()).toBe("idle"); // the first-pass check: an empty store
    await counted(pg, "public.later");
    maintenance.noteSync();
    expect(await maintenance.run()).toBe("vacuum");
    expect(await hasStatistics(pg, "public.later")).toBe(true);
  });
});
