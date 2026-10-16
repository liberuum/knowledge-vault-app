import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKFILL_ITEMS, createStarterManager, feedAddress, papersAddress, planStarter, readStarters, StarterError, topicOf } from "./starters.js";

type Call = { query: string; variables: Record<string, unknown> };
type Op = { index: number; error: string | null; action: { id?: string; type: string; input?: unknown } };

/**
 * The engine as starters.ts sees it: documents with their global operations, the runtime's secrets, a connection
 * check, a trigger test and `fire`. Each behaviour can be turned to fail.
 */
function fakeEngine(opts: { checkOk?: boolean; testError?: string; items?: unknown[]; fireStatus?: string } = {}) {
  const calls: Call[] = [];
  const docs = new Map<string, { name: string; ops: Op[] }>();
  const secrets = new Set<string>();
  let n = 0;
  const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
  const fail = (message: string) => ({ ok: true, json: async () => ({ errors: [{ message }] }) });
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    const q = body.query;
    const v = body.variables;
    const ns = /(Connection|Workflow)\s*\{\s*createDocument/.exec(q)?.[1];
    if (ns) {
      const id = `doc${++n}`;
      docs.set(id, { name: v.name as string, ops: [] });
      return ok({ [ns]: { createDocument: { id } } });
    }
    if (q.includes("createSecret")) {
      const ref = `secret://v1:${++n}`;
      secrets.add(ref);
      return ok({ workflowRuntime: { createSecret: { ref } } });
    }
    if (q.includes("deleteSecret")) {
      secrets.delete(v.ref as string);
      return ok({ workflowRuntime: { deleteSecret: true } });
    }
    if (q.includes("execute(")) {
      const doc = docs.get(v.id as string)!;
      for (const a of v.a as Array<{ type: string; input: unknown }>) doc.ops.push({ index: doc.ops.length, error: null, action: a });
      return ok({ execute: { id: v.id } });
    }
    if (q.includes("operations(")) {
      const doc = docs.get(v.id as string)!;
      return ok({ document: { document: { operations: { items: doc.ops.map(({ index, error, action }) => ({ index, error, action: { id: action.id, type: action.type } })), hasNextPage: false, cursor: null } } } });
    }
    if (q.includes("deleteDocument")) {
      docs.delete(v.id as string);
      return ok({ deleteDocument: true });
    }
    if (q.includes("checkConnection")) return ok({ workflowRuntime: { checkConnection: { ok: opts.checkOk ?? true, detail: opts.checkOk === false ? "Invalid API key" : null } } });
    if (q.includes("testTrigger")) return opts.testError ? fail(opts.testError) : ok({ workflowRuntime: { testTrigger: opts.items ?? [] } });
    if (q.includes("fire(")) return ok({ workflowRuntime: { fire: { status: opts.fireStatus ?? "SUCCEEDED", error: opts.fireStatus && opts.fireStatus !== "SUCCEEDED" ? "boom" : null } } });
    if (q.includes("document(idOrSlug")) {
      const doc = docs.get(v.id as string);
      if (!doc) return ok({ document: null });
      const status = [...doc.ops].reverse().find((o) => o.action.type === "SET_WORKFLOW_STATUS");
      return ok({ document: { document: { name: doc.name, state: { global: { status: (status?.action.input as { status?: string } | undefined)?.status ?? "DRAFT" } } } } });
    }
    throw new Error(`unexpected query: ${q}`);
  }) as unknown as typeof fetch;
  const opsOf = (id: string) => docs.get(id)?.ops.map((o) => o.action) ?? [];
  return { fetchImpl, calls, docs, secrets, opsOf };
}

const NOW = "2026-10-15T10:00:00.000Z";
const ctx = { driveId: "vault1", vaultConnectionId: "kv-conn", pieceVersion: "1.0.54-dev.33", now: NOW };

describe("starter inputs", () => {
  it("reads a feed address: a missing scheme is added, anything but a web address is refused", () => {
    expect(feedAddress("example.com/feed").href).toBe("https://example.com/feed");
    expect(feedAddress("  http://blog.example.org/rss.xml ").href).toBe("http://blog.example.org/rss.xml");
    expect(() => feedAddress("")).toThrow(/Paste the feed's address/);
    expect(() => feedAddress("ftp://example.com/feed")).toThrow(/starts with https/);
    expect(() => feedAddress("localhost/feed")).toThrow(/no site in it/);
    expect(() => feedAddress("https://exa mple.com")).toThrow(/not a web address/);
  });

  it("turns a topic into arXiv's newest-first search, quotes and spacing tidied", () => {
    expect(topicOf("  knowledge   graphs ")).toBe("knowledge graphs");
    expect(() => topicOf("a")).toThrow(/Name a topic/);
    expect(() => topicOf("x".repeat(101))).toThrow(/Keep the topic short/);
    const url = new URL(papersAddress('knowledge "graphs"'));
    expect(url.origin + url.pathname).toBe("https://export.arxiv.org/api/query");
    expect(url.searchParams.get("search_query")).toBe('all:"knowledge graphs"');
    expect(url.searchParams.get("sortBy")).toBe("submittedDate");
    expect(url.searchParams.get("sortOrder")).toBe("descending");
  });
});

describe("planStarter", () => {
  it("plans a feed: the RSS trigger every 15 minutes, HTML to Markdown, then Ingest source on the vault's connection", () => {
    const plan = planStarter({ starter: "feed", feedUrl: "www.example.com/feed", process: false }, ctx);
    expect(plan.label).toBe("Feed: example.com");
    expect(plan.connection).toBeUndefined();
    const trigger = plan.ops.find((o) => o.type === "SET_TRIGGER")!.input as Record<string, unknown>;
    expect(trigger).toMatchObject({ pieceName: "@activepieces/piece-rss", triggerName: "new-item", pieceVersion: "0.7.0", config: { rss_feed_url: "https://www.example.com/feed", pollEverySeconds: 900 } });
    const steps = plan.ops.filter((o) => o.type === "ADD_STEP").map((o) => o.input as Record<string, unknown>);
    expect(steps.map((s) => s.actionName)).toEqual(["html_to_markdown", "ingest-source"]);
    const ingest = steps[1]!;
    expect(ingest).toMatchObject({ id: plan.ingestStepId, connectionId: "kv-conn", pieceVersion: "1.0.54-dev.33", pieceName: "@powerhousedao/piece-knowledge-vault" });
    expect(ingest.config).toMatchObject({ drive: "vault1", source_type: "ARTICLE", folder: "Feeds", queue: false, dedupe_key: "", content: "{{steps.text.output || trigger.payload.title}}" });
    expect((ingest.propertySettings as Array<{ prop: string }>).map((p) => p.prop)).not.toContain("dedupe_key");
    expect(plan.ops.filter((o) => o.type === "ADD_EDGE")).toHaveLength(2);
    // Published, not switched on: that happens once the trigger was tried.
    expect(plan.ops.at(-1)).toEqual({ type: "PUBLISH_WORKFLOW", input: { publishedAt: NOW } });
    expect(plan.ops.some((o) => o.type === "SET_WORKFLOW_STATUS")).toBe(false);
    expect(plan.description).not.toMatch(/turned into notes/);
  });

  it("plans papers on a topic: arXiv hourly, the abstract as a paper, deduped on its id, queued by default", () => {
    const plan = planStarter({ starter: "papers", topic: "retrieval augmented generation" }, ctx);
    expect(plan.label).toBe("Papers on “retrieval augmented generation”");
    const trigger = plan.ops.find((o) => o.type === "SET_TRIGGER")!.input as { config: Record<string, unknown> };
    expect(trigger.config.pollEverySeconds).toBe(3600);
    expect(String(trigger.config.rss_feed_url)).toContain("export.arxiv.org");
    const ingest = plan.ops.find((o) => o.type === "ADD_STEP")!.input as { config: Record<string, unknown> };
    expect(ingest.config).toMatchObject({ source_type: "PAPER", folder: "Papers", queue: true, dedupe_key: "{{trigger.payload.guid || trigger.payload.link}}" });
    expect(plan.description).toMatch(/turned into notes/);
  });

  it("plans Granola meeting notes with a connection of their own for the key", () => {
    const plan = planStarter({ starter: "granola", apiKey: " grn_123 " }, ctx);
    expect(plan.connection).toEqual({ connectorId: "@activepieces/piece-granola#granola", key: "grn_123", name: "Granola" });
    const trigger = plan.ops.find((o) => o.type === "SET_TRIGGER")!.input as Record<string, unknown>;
    expect(trigger).toMatchObject({ pieceName: "@activepieces/piece-granola", triggerName: "new_note", config: { pollEverySeconds: 600 } });
    expect(() => planStarter({ starter: "granola", apiKey: "  " }, ctx)).toThrow(/Granola API key/);
    expect(() => planStarter({ starter: "zapier" }, ctx)).toThrow(StarterError);
  });
});

describe("the starter manager", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "kv-starters-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const manager = (engine: ReturnType<typeof fakeEngine>, connection: () => string | undefined = () => "kv-conn") =>
    createStarterManager({
      dataDir,
      origin: "http://127.0.0.1:4201",
      fetchImpl: engine.fetchImpl,
      pieceVersion: "1.0.54-dev.33",
      workflowsDrive: async () => ({ id: "wfdrive" }),
      vaultName: async () => "Research",
      vaultConnection: connection,
      now: () => NOW,
    });

  it("refuses a vault whose processing is not set up, before anything is made", async () => {
    const engine = fakeEngine();
    const error = await manager(engine, () => undefined).add("vault1", { starter: "papers", topic: "graphs" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StarterError);
    expect((error as StarterError).status).toBe(409);
    expect(engine.calls).toHaveLength(0);
  });

  it("adds a feed: published as a draft, its trigger tried, switched on, the latest items run through it, recorded", async () => {
    const items = [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }];
    const engine = fakeEngine({ items });
    const out = await manager(engine).add("vault1", { starter: "feed", feedUrl: "example.com/feed" });
    expect(out).toMatchObject({ workflowId: "doc1", label: "Feed: example.com", name: "Research — Feed: example.com", status: "ENABLED", added: BACKFILL_ITEMS });
    const types = engine.opsOf("doc1").map((a) => a.type);
    expect(types[0]).toBe("SET_WORKFLOW_NAME");
    expect(types.indexOf("PUBLISH_WORKFLOW")).toBeLessThan(types.indexOf("SET_WORKFLOW_STATUS"));
    // the trigger was tried before the workflow was switched on
    const order = engine.calls.map((c) => (c.query.includes("testTrigger") ? "test" : c.query.includes("execute(") ? "execute" : c.query.includes("fire(") ? "fire" : "")).filter(Boolean);
    expect(order).toEqual(["execute", "test", "execute", "fire", "fire", "fire"]);
    expect(engine.calls.filter((c) => c.query.includes("fire(")).map((c) => c.variables.p)).toEqual(items.slice(0, 3));
    expect(readStarters(dataDir).vault1).toEqual([expect.objectContaining({ workflowId: "doc1", starter: "feed", vaultConnectionId: "kv-conn" })]);
  });

  it("refuses a second workflow for the same feed or topic, and allows it again once the first is deleted", async () => {
    const engine = fakeEngine();
    const m = manager(engine);
    const first = await m.add("vault1", { starter: "feed", feedUrl: "example.com/feed" });
    const twice = await m.add("vault1", { starter: "feed", feedUrl: "https://example.com/feed" }).catch((e: unknown) => e);
    expect(twice).toBeInstanceOf(StarterError);
    expect((twice as StarterError).status).toBe(409);
    expect((twice as Error).message).toBe("This vault already has “Feed: example.com”. Open it in Workflow Studio to change it.");
    // another feed, the same topic in another case, another vault
    await m.add("vault1", { starter: "feed", feedUrl: "example.com/other-feed" });
    await m.add("vault1", { starter: "papers", topic: "Graphs" });
    await expect(m.add("vault1", { starter: "papers", topic: "graphs" })).rejects.toThrow(/already has “Papers on “Graphs””/);
    await m.add("vault2", { starter: "feed", feedUrl: "example.com/feed" });
    engine.docs.delete(first.workflowId);
    expect((await m.add("vault1", { starter: "feed", feedUrl: "example.com/feed" })).label).toBe("Feed: example.com");
  });

  it("skips the latest items when asked, and says when one of them could not be added", async () => {
    const engine = fakeEngine({ items: [{ title: "a" }] });
    expect((await manager(engine).add("vault1", { starter: "papers", topic: "graphs", backfill: false })).added).toBe(0);
    expect(engine.calls.some((c) => c.query.includes("fire("))).toBe(false);
    const failing = fakeEngine({ items: [{ title: "a" }], fireStatus: "FAILED" });
    expect(await manager(failing).add("vault1", { starter: "papers", topic: "graphs" })).toMatchObject({ added: 0, addError: "boom" });
  });

  it("deletes the workflow and records nothing when the feed address gives no feed", async () => {
    const engine = fakeEngine({ testError: "Error: Not a feed" });
    const error = await manager(engine).add("vault1", { starter: "feed", feedUrl: "example.com" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StarterError);
    expect((error as Error).message).toMatch(/did not give a feed.*\(Not a feed\)/);
    expect(engine.docs.size).toBe(0);
    expect(readStarters(dataDir)).toEqual({});
  });

  it("checks a key through its connection first: a rejected key leaves no connection and no secret", async () => {
    const engine = fakeEngine({ checkOk: false });
    await expect(manager(engine).add("vault1", { starter: "granola", apiKey: "bad" })).rejects.toThrow("Granola did not accept that key: Invalid API key.");
    expect(engine.docs.size).toBe(0);
    expect(engine.secrets.size).toBe(0);
  });

  it("puts an accepted key in a connection the trigger runs on", async () => {
    const engine = fakeEngine();
    const out = await manager(engine).add("vault1", { starter: "granola", apiKey: "grn_ok" });
    const record = readStarters(dataDir).vault1![0]!;
    const connection = engine.opsOf(record.connectionId!);
    expect(connection.map((a) => a.type)).toEqual(["SET_CONNECTION_NAME", "SET_CONNECTOR", "SET_SECRET_REF"]);
    expect(connection[1]!.input).toEqual({ connectorId: "@activepieces/piece-granola#granola", authType: "SECRET_TEXT" });
    expect(connection[2]!.input).toMatchObject({ name: "value", ref: [...engine.secrets][0] });
    const trigger = engine.opsOf(out.workflowId).find((a) => a.type === "SET_TRIGGER")!.input as Record<string, unknown>;
    expect(trigger.connectionId).toBe(record.connectionId);
    expect(record.secretRef).toBe([...engine.secrets][0]);
  });

  it("lists what exists, forgetting a workflow deleted in Studio together with its key", async () => {
    const engine = fakeEngine();
    const m = manager(engine);
    const feed = await m.add("vault1", { starter: "feed", feedUrl: "example.com/feed" });
    const granola = await m.add("vault1", { starter: "granola", apiKey: "grn_ok" });
    expect((await m.list("vault1")).map((s) => [s.label, s.status])).toEqual([
      ["Feed: example.com", "ENABLED"],
      ["Granola meeting notes", "ENABLED"],
    ]);
    engine.docs.delete(granola.workflowId);
    expect((await m.list("vault1")).map((s) => s.workflowId)).toEqual([feed.workflowId]);
    expect(engine.secrets.size).toBe(0);
    expect([...engine.docs.keys()]).toEqual([feed.workflowId]);
  });

  it("follows the vault's connection when the pipeline was set up again, and publishes", async () => {
    const engine = fakeEngine();
    let current = "kv-conn";
    const m = manager(engine, () => current);
    const { workflowId } = await m.add("vault1", { starter: "papers", topic: "graphs" });
    expect(await m.follow()).toEqual({ moved: [], failed: [] });
    current = "kv-conn-2";
    expect(await m.follow()).toEqual({ moved: [workflowId], failed: [] });
    const tail = engine.opsOf(workflowId).slice(-2);
    expect(tail[0]).toMatchObject({ type: "UPDATE_STEP", input: { connectionId: "kv-conn-2", id: readStarters(dataDir).vault1![0]!.ingestStepId } });
    expect(tail[1]!.type).toBe("PUBLISH_WORKFLOW");
    expect(readStarters(dataDir).vault1![0]!.vaultConnectionId).toBe("kv-conn-2");
  });

  it("removes a vault's starters with their connections and keys", async () => {
    const engine = fakeEngine();
    const m = manager(engine);
    await m.add("vault1", { starter: "granola", apiKey: "grn_ok" });
    await m.add("vault2", { starter: "papers", topic: "graphs" });
    await m.removeVault("vault1");
    expect(engine.secrets.size).toBe(0);
    expect([...engine.docs.values()].map((d) => d.name)).toEqual(["Research — Papers on “graphs”"]);
    expect(Object.keys(readStarters(dataDir))).toEqual(["vault2"]);
  });
});
