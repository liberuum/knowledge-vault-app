import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDocument, deleteDocument, execute, gql, toActions } from "./reactor-gql.js";

/**
 * Starter workflows (spec 2026-10-15 workflows side trip): ready-made Workflow Studio workflows that bring sources
 * into one vault — an RSS or Atom feed, new research papers on a topic, Granola meeting notes. Each is an ordinary
 * workflow in the Workflows drive, made from Activepieces pieces and the vault's own *Ingest source* step, on the
 * vault pipeline's Knowledge Vault connection (followed when the pipeline is set up again, as Reweave notes is).
 *
 * Made in an order that leaves nothing behind on a mistake: a key is checked through its connection first, the
 * workflow is published as a draft and its trigger tested (a wrong feed address fails here), and only then is it
 * switched on. The tested items are the latest ones; up to three are run through the workflow when asked, because a
 * polling trigger only delivers what arrives after it was switched on.
 */

export const STARTER_IDS = ["feed", "papers", "granola"] as const;
export type StarterId = (typeof STARTER_IDS)[number];

/** The piece versions these starters were verified with (runtime 6.2.3-dev.52, 15 Oct 2026). */
export const STARTER_PIECES = {
  rss: { name: "@activepieces/piece-rss", version: "0.7.0" },
  text: { name: "@activepieces/piece-text-helper", version: "0.6.6" },
  granola: { name: "@activepieces/piece-granola", version: "0.1.2" },
} as const;
const VAULT_PIECE = "@powerhousedao/piece-knowledge-vault";
/** How many of the latest items "add the latest ones now" runs through the workflow. */
export const BACKFILL_ITEMS = 3;

export type StarterRequest = {
  starter: string;
  feedUrl?: unknown;
  topic?: unknown;
  apiKey?: unknown;
  /** Queue what arrives for processing (default) or only collect it in Sources. */
  process?: unknown;
  /** Run the latest items through the workflow now (default). */
  backfill?: unknown;
};
export type StarterRecord = {
  workflowId: string;
  starter: StarterId;
  /** How the workflow is named after the vault: "Feed: example.com", "Papers on “graphs”". */
  label: string;
  /** What makes two of this starter the same: the feed's address, the topic, or the account for a key. */
  same?: string;
  /** The vault connection the *Ingest source* step runs on, and that step's id: followed when the pipeline's changes. */
  vaultConnectionId: string;
  ingestStepId: string;
  /** A connection of its own (an API key), with its secret. */
  connectionId?: string;
  secretRef?: string;
  createdAt: string;
};
export type StarterSummary = { workflowId: string; starter: StarterId; label: string; name: string; createdAt: string; status: string };
export type AddedStarter = StarterSummary & { added: number; addError?: string };

/** A request the person can fix (a malformed address, a rejected key); `status` 409 when the vault cannot have one yet. */
export class StarterError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

type Op = { type: string; input: unknown };
/** `same`: what makes two of one starter the same (a feed's address, a topic) — a vault follows each once. */
type Plan = { label: string; description: string; same: string; ops: Op[]; ingestStepId: string; connection?: { connectorId: string; key: string; name: string } };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The feed's address: a scheme is added when none was typed ("example.com/feed"); anything but http(s) is refused. */
export function feedAddress(raw: unknown): URL {
  const typed = text(raw);
  if (!typed) throw new StarterError("Paste the feed's address first.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new StarterError("That is not a web address. A feed's address looks like https://example.com/feed.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new StarterError("A feed's address starts with https:// or http://.");
  if (!url.hostname.includes(".")) throw new StarterError("That address has no site in it. A feed's address looks like https://example.com/feed.");
  return url;
}

/** arXiv's own search, newest submissions first, as an Atom feed the RSS piece reads. */
export function papersAddress(topic: string): string {
  const phrase = topic.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  return `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:"${phrase}"`)}&sortBy=submittedDate&sortOrder=descending&max_results=20`;
}

export function topicOf(raw: unknown): string {
  const topic = text(raw).replace(/\s+/g, " ");
  if (topic.length < 2) throw new StarterError("Name a topic, for example “knowledge graphs”.");
  if (topic.length > 100) throw new StarterError("Keep the topic short: a few words, as you would search for it.");
  return topic;
}

/** The *Ingest source* step every starter ends in. Expressions are the runtime's own `{{…}}`, read per run. */
function ingestStep(o: {
  id: string;
  driveId: string;
  connectionId: string;
  pieceVersion: string;
  title: string;
  content: string;
  sourceType: string;
  folder: string;
  url: string;
  author: string;
  publishedAt: string;
  dedupe: string;
  queue: boolean;
  tool: string;
  x: number;
}): Op {
  const config = {
    drive: o.driveId,
    title: o.title,
    content: o.content,
    source_type: o.sourceType,
    url: o.url,
    author: o.author,
    published_at: o.publishedAt,
    folder: o.folder,
    dedupe_key: o.dedupe,
    queue: o.queue,
    tool: o.tool,
  };
  const expressions = ["title", "content", "url", "author", "published_at", ...(o.dedupe ? ["dedupe_key"] : [])];
  return {
    type: "ADD_STEP",
    input: {
      id: o.id,
      key: "ingest",
      name: "Add it to the vault",
      config,
      position: { x: o.x, y: 0 },
      pieceName: VAULT_PIECE,
      actionName: "ingest-source",
      connectionId: o.connectionId,
      pieceVersion: o.pieceVersion,
      timeoutSeconds: 120,
      propertySettings: expressions.map((prop) => ({ mode: "EXPRESSION", prop })),
    },
  };
}

const edge = (from: string, to: string): Op => ({ type: "ADD_EDGE", input: { id: randomUUID(), from, to, port: "next" } });
/** One run at a time, nothing dropped, a failure reported — the vault pipeline's own policy. */
const POLICY: Op = { type: "SET_POLICY", input: { concurrency: "QUEUE", runTimeoutSeconds: 0, onFailure: "NOTIFY" } };

/** What one starter makes, before anything exists: its label, its operations up to publishing, and a connection when it needs a key. */
export function planStarter(request: StarterRequest, ctx: { driveId: string; vaultConnectionId: string; pieceVersion: string; now: string }): Plan {
  const queue = request.process !== false;
  const triggerId = randomUUID();
  const ingestStepId = randomUUID();
  const base = { driveId: ctx.driveId, connectionId: ctx.vaultConnectionId, pieceVersion: ctx.pieceVersion, id: ingestStepId, queue };
  const publish: Op = { type: "PUBLISH_WORKFLOW", input: { publishedAt: ctx.now } };

  if (request.starter === "feed") {
    const url = feedAddress(request.feedUrl);
    const label = `Feed: ${url.hostname.replace(/^www\./, "")}`;
    const textStepId = randomUUID();
    const description = `Each new post in ${url.href} becomes a source in Sources › Feeds${queue ? " and is turned into notes" : ""}.`;
    return {
      label,
      description,
      same: url.href,
      ingestStepId,
      ops: [
        { type: "SET_WORKFLOW_DESCRIPTION", input: { description } },
        {
          type: "SET_TRIGGER",
          input: { id: triggerId, config: { rss_feed_url: url.href, pollEverySeconds: 900 }, pieceName: STARTER_PIECES.rss.name, triggerName: "new-item", pieceVersion: STARTER_PIECES.rss.version },
        },
        {
          type: "ADD_STEP",
          input: {
            id: textStepId,
            key: "text",
            name: "Turn the post into text",
            // feedparser puts a post's full content (content:encoded) in description, the teaser in summary
            config: { html: "{{trigger.payload.description || trigger.payload.summary || trigger.payload.title}}", gfm: true },
            position: { x: 320, y: 0 },
            pieceName: STARTER_PIECES.text.name,
            actionName: "html_to_markdown",
            pieceVersion: STARTER_PIECES.text.version,
            timeoutSeconds: 60,
            propertySettings: [{ mode: "EXPRESSION", prop: "html" }],
          },
        },
        ingestStep({
          ...base,
          title: "{{trigger.payload.title || 'Untitled post'}}",
          content: "{{steps.text.output || trigger.payload.title}}",
          sourceType: "ARTICLE",
          folder: "Feeds",
          url: "{{trigger.payload.link?}}",
          author: "{{trigger.payload.author?}}",
          publishedAt: "{{trigger.payload.pubDate || trigger.payload.date?}}",
          // None: the trigger delivers each post once, and a feed's guid (often a whole URL) overflows the store key
          // of the vault piece up to 1.0.54-dev.33 (fixed after it: long keys are hashed).
          dedupe: "",
          tool: "rss",
          x: 640,
        }),
        edge(triggerId, textStepId),
        edge(textStepId, ingestStepId),
        POLICY,
        publish,
      ],
    };
  }

  if (request.starter === "papers") {
    const topic = topicOf(request.topic);
    const label = `Papers on “${topic}”`;
    const description = `New arXiv papers matching “${topic}” arrive as sources in Sources › Papers, one abstract each${queue ? ", and are turned into notes" : ""}.`;
    return {
      label,
      description,
      same: topic.toLowerCase(),
      ingestStepId,
      ops: [
        { type: "SET_WORKFLOW_DESCRIPTION", input: { description } },
        {
          type: "SET_TRIGGER",
          input: { id: triggerId, config: { rss_feed_url: papersAddress(topic), pollEverySeconds: 3600 }, pieceName: STARTER_PIECES.rss.name, triggerName: "new-item", pieceVersion: STARTER_PIECES.rss.version },
        },
        ingestStep({
          ...base,
          title: "{{trigger.payload.title || 'Untitled paper'}}",
          // An abstract is plain text: no HTML step, which would escape its characters.
          content: "{{trigger.payload.summary || trigger.payload.description || trigger.payload.title}}",
          sourceType: "PAPER",
          folder: "Papers",
          url: "{{trigger.payload.link?}}",
          author: "{{trigger.payload.author?}}",
          publishedAt: "{{trigger.payload.pubDate || trigger.payload.date?}}",
          dedupe: "{{trigger.payload.guid || trigger.payload.link}}",
          tool: "arxiv",
          x: 320,
        }),
        edge(triggerId, ingestStepId),
        POLICY,
        publish,
      ],
    };
  }

  if (request.starter === "granola") {
    const key = text(request.apiKey);
    if (!key) throw new StarterError("Paste your Granola API key first.");
    const label = "Granola meeting notes";
    const description = `Each new meeting note in Granola arrives as a source in Sources › Meetings${queue ? " and is turned into notes" : ""}.`;
    return {
      label,
      description,
      // One Granola account per vault: a second key would bring the same meetings twice.
      same: "granola",
      ingestStepId,
      connection: { connectorId: `${STARTER_PIECES.granola.name}#granola`, key, name: "Granola" },
      ops: [
        { type: "SET_WORKFLOW_DESCRIPTION", input: { description } },
        // connectionId is filled in once the Granola connection exists (see add)
        { type: "SET_TRIGGER", input: { id: triggerId, config: { pollEverySeconds: 600 }, pieceName: STARTER_PIECES.granola.name, triggerName: "new_note", pieceVersion: STARTER_PIECES.granola.version } },
        ingestStep({
          ...base,
          title: "{{trigger.payload.title || trigger.payload.calendar_event_title || 'Meeting notes'}}",
          content: "{{trigger.payload.summary_markdown || trigger.payload.summary_text || trigger.payload.title}}",
          sourceType: "CONVERSATION",
          folder: "Meetings",
          url: "",
          author: "{{trigger.payload.owner_name?}}",
          publishedAt: "{{trigger.payload.scheduled_start_time || trigger.payload.created_at?}}",
          dedupe: "{{trigger.payload.id}}",
          tool: "granola",
          x: 320,
        }),
        edge(triggerId, ingestStepId),
        POLICY,
        publish,
      ],
    };
  }

  throw new StarterError(`There is no starter called “${request.starter}”.`);
}

// --- records -------------------------------------------------------------------------------------------------

const file = (dataDir: string) => join(dataDir, "starters.json");
export function readStarters(dataDir: string): Record<string, StarterRecord[]> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(dataDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, StarterRecord[]>) : {};
  } catch {
    return {};
  }
}
function writeStarters(dataDir: string, records: Record<string, StarterRecord[]>): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n");
  renameSync(tmp, file(dataDir));
}

// --- manager -------------------------------------------------------------------------------------------------

export type StarterDeps = {
  dataDir: string;
  origin: string;
  fetchImpl: typeof fetch;
  /** The installed vault package's piece version, which *Ingest source* is pinned to. */
  pieceVersion: string;
  workflowsDrive: () => Promise<{ id: string }>;
  vaultName: (vaultId: string) => Promise<string>;
  /** The vault pipeline's Knowledge Vault connection; undefined while the vault has no pipeline. */
  vaultConnection: (vaultId: string) => string | undefined;
  now?: () => string;
};

export function createStarterManager(deps: StarterDeps) {
  const f = deps.fetchImpl;
  const now = () => (deps.now ?? (() => new Date().toISOString()))();
  const run = <T>(query: string, variables: Record<string, unknown>) => gql<T>(deps.origin, query, variables, f);

  async function createSecret(value: string, label: string): Promise<string> {
    const data = await run<{ workflowRuntime: { createSecret: { ref: string } } }>(`mutation($v: String!, $l: String) { workflowRuntime { createSecret(value: $v, label: $l) { ref } } }`, { v: value, l: label });
    return data.workflowRuntime.createSecret.ref;
  }
  const deleteSecret = (ref: string) => run(`mutation($ref: String!) { workflowRuntime { deleteSecret(ref: $ref) } }`, { ref }).catch(() => undefined);
  const remove = (id: string) => deleteDocument(deps.origin, id, f).catch(() => undefined);

  /** A workflow's status, or null when it is gone (deleted in Studio). */
  async function workflowState(workflowId: string): Promise<{ status: string; name: string } | null> {
    const data = await run<{ document: { document: { name: string; state: { global: { status?: string } } } | null } | null }>(`query($id: String!) { document(idOrSlug: $id) { document { name state } } }`, {
      id: workflowId,
    }).catch(() => null);
    const doc = data?.document?.document;
    return doc ? { status: doc.state.global.status ?? "UNKNOWN", name: doc.name } : null;
  }

  function save(vaultId: string, change: (list: StarterRecord[]) => StarterRecord[]): void {
    const all = readStarters(deps.dataDir);
    const next = change(all[vaultId] ?? []);
    if (next.length) all[vaultId] = next;
    else delete all[vaultId];
    writeStarters(deps.dataDir, all);
  }

  /** Point each starter's *Ingest source* step at the vault's current pipeline connection, and publish. Never throws. */
  async function follow(vaultId?: string): Promise<{ moved: string[]; failed: string[] }> {
    const moved: string[] = [];
    const failed: string[] = [];
    for (const [vault, list] of Object.entries(readStarters(deps.dataDir))) {
      if (vaultId && vault !== vaultId) continue;
      const current = deps.vaultConnection(vault);
      if (!current) continue;
      for (const record of list) {
        if (record.vaultConnectionId === current) continue;
        try {
          await execute(
            deps.origin,
            record.workflowId,
            toActions(
              [
                { type: "UPDATE_STEP", input: { id: record.ingestStepId, connectionId: current } },
                { type: "PUBLISH_WORKFLOW", input: { publishedAt: now() } },
              ],
              now,
            ),
            f,
          );
          save(vault, (l) => l.map((r) => (r.workflowId === record.workflowId ? { ...r, vaultConnectionId: current } : r)));
          moved.push(record.workflowId);
        } catch {
          failed.push(record.workflowId);
        }
      }
    }
    return { moved, failed };
  }

  /** The vault's starters that still exist, with their status; one deleted in Studio is forgotten (its key with it). */
  async function list(vaultId: string): Promise<StarterSummary[]> {
    await follow(vaultId);
    const out: StarterSummary[] = [];
    for (const record of readStarters(deps.dataDir)[vaultId] ?? []) {
      const state = await workflowState(record.workflowId);
      if (!state) {
        if (record.connectionId) await remove(record.connectionId);
        if (record.secretRef) await deleteSecret(record.secretRef);
        save(vaultId, (l) => l.filter((r) => r.workflowId !== record.workflowId));
        continue;
      }
      out.push({ workflowId: record.workflowId, starter: record.starter, label: record.label, name: state.name, createdAt: record.createdAt, status: state.status });
    }
    return out;
  }

  async function add(vaultId: string, request: StarterRequest): Promise<AddedStarter> {
    if (!(STARTER_IDS as readonly string[]).includes(request.starter)) throw new StarterError(`There is no starter called “${request.starter}”.`);
    const vaultConnectionId = deps.vaultConnection(vaultId);
    if (!vaultConnectionId) throw new StarterError("This vault's processing is not set up yet. Choose an AI model in Settings › Models, then try again.", 409);
    const plan = planStarter(request, { driveId: vaultId, vaultConnectionId, pieceVersion: deps.pieceVersion, now: now() });
    // The same feed or topic twice would bring every item in twice; one deleted in Studio no longer counts.
    const twin = (await list(vaultId)).find((s) => s.starter === request.starter && readStarters(deps.dataDir)[vaultId]?.find((r) => r.workflowId === s.workflowId)?.same === plan.same);
    if (twin) throw new StarterError(`This vault already has “${twin.label}”. Open it in Workflow Studio to change it.`, 409);
    const vaultName = await deps.vaultName(vaultId);
    const name = `${vaultName} — ${plan.label}`;
    const { id: workflowsDriveId } = await deps.workflowsDrive();

    const made: { documents: string[]; secret?: string } = { documents: [] };
    const undo = async () => {
      for (const id of [...made.documents].reverse()) await remove(id);
      if (made.secret) await deleteSecret(made.secret);
    };
    try {
      // 1. A key gets its own connection, checked before anything else is made.
      let connectionId: string | undefined;
      if (plan.connection) {
        const connectionName = `${vaultName} — ${plan.connection.name}`;
        made.secret = await createSecret(plan.connection.key, `${connectionName} — API key`);
        connectionId = await createDocument(deps.origin, "powerhouse/connection", connectionName, workflowsDriveId, f);
        made.documents.push(connectionId);
        await execute(
          deps.origin,
          connectionId,
          toActions(
            [
              { type: "SET_CONNECTION_NAME", input: { name: connectionName } },
              { type: "SET_CONNECTOR", input: { connectorId: plan.connection.connectorId, authType: "SECRET_TEXT" } },
              { type: "SET_SECRET_REF", input: { id: randomUUID(), ref: made.secret, name: "value" } },
            ],
            now,
          ),
          f,
        );
        const check = await run<{ workflowRuntime: { checkConnection: { ok: boolean; detail: string | null } } }>(
          `mutation($c: String!) { workflowRuntime { checkConnection(connectionId: $c) { ok detail } } }`,
          { c: connectionId },
        );
        if (!check.workflowRuntime.checkConnection.ok) throw new StarterError(`${plan.connection.name} did not accept that key: ${check.workflowRuntime.checkConnection.detail ?? "no reason given"}.`);
      }

      // 2. The workflow, published but not switched on.
      const workflowId = await createDocument(deps.origin, "powerhouse/workflow", name, workflowsDriveId, f);
      made.documents.push(workflowId);
      const ops = plan.ops.map((op) => (op.type === "SET_TRIGGER" && connectionId ? { ...op, input: { ...(op.input as object), connectionId } } : op));
      await execute(deps.origin, workflowId, toActions([{ type: "SET_WORKFLOW_NAME", input: { name } }, ...ops], now), f);

      // 3. Its trigger, tried once: a wrong address or an account that answers nothing fails here.
      let items: unknown[] = [];
      try {
        const tested = await run<{ workflowRuntime: { testTrigger: unknown } }>(`mutation($w: String!) { workflowRuntime { testTrigger(workflowId: $w, timeoutSeconds: 45) } }`, { w: workflowId });
        items = Array.isArray(tested.workflowRuntime.testTrigger) ? tested.workflowRuntime.testTrigger : [];
      } catch (error) {
        throw new StarterError(triggerProblem(request.starter, error));
      }

      // 4. On, and recorded.
      await execute(deps.origin, workflowId, toActions([{ type: "SET_WORKFLOW_STATUS", input: { status: "ENABLED" } }], now), f);
      const record: StarterRecord = {
        workflowId,
        starter: request.starter as StarterId,
        label: plan.label,
        same: plan.same,
        vaultConnectionId,
        ingestStepId: plan.ingestStepId,
        ...(connectionId ? { connectionId } : {}),
        ...(made.secret ? { secretRef: made.secret } : {}),
        createdAt: now(),
      };
      save(vaultId, (l) => [...l, record]);
      made.documents = [];
      made.secret = undefined;

      // 5. The latest items, through the same workflow, when asked. A failure here keeps the workflow.
      let added = 0;
      let addError: string | undefined;
      if (request.backfill !== false) {
        for (const item of items.slice(0, BACKFILL_ITEMS)) {
          try {
            const fired = await run<{ workflowRuntime: { fire: { status: string; error: string | null } } }>(
              `mutation($w: String!, $p: Unknown) { workflowRuntime { fire(workflowId: $w, payload: $p) { status error } } }`,
              { w: workflowId, p: item },
            );
            if (fired.workflowRuntime.fire.status === "SUCCEEDED") added++;
            else addError = fired.workflowRuntime.fire.error ?? `a run ended ${fired.workflowRuntime.fire.status.toLowerCase()}`;
          } catch (error) {
            addError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      return { workflowId, starter: record.starter, label: plan.label, name, createdAt: record.createdAt, status: "ENABLED", added, ...(addError ? { addError } : {}) };
    } catch (error) {
      await undo();
      throw error;
    }
  }

  /** A vault going away takes its starters with it: their workflows, connections and keys. */
  async function removeVault(vaultId: string): Promise<void> {
    for (const record of readStarters(deps.dataDir)[vaultId] ?? []) {
      await remove(record.workflowId);
      if (record.connectionId) await remove(record.connectionId);
      if (record.secretRef) await deleteSecret(record.secretRef);
    }
    save(vaultId, () => []);
  }

  return { add, list, follow, removeVault };
}

/** What a failed trigger test means, in the person's words; the runtime's reason follows. */
function triggerProblem(starter: string, error: unknown): string {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/^(?:Http)?Error:\s*/, "").slice(0, 200);
  if (starter === "feed") return `That address did not give a feed. Use the feed's own address (it often ends in /feed, /rss or .xml), not the site's home page. (${reason})`;
  if (starter === "papers") return `arXiv did not answer just now. Try again in a minute. (${reason})`;
  return `Granola did not answer: ${reason}`;
}
