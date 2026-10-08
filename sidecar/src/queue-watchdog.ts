import { randomUUID } from "node:crypto";
import { execute, gql, toActions } from "./reactor-gql.js";

/**
 * The pipeline's trigger fires only for a PENDING task whose source exists and that it has not
 * seen before. Two kinds of task therefore sit forever: one a failed run claimed (IN_PROGRESS,
 * no handoff — the model refused, the key ran dry), and one whose source was deleted. The
 * watchdog fails the first and queues it again as a fresh task (which the trigger will fire),
 * and fails the second with its reason. It never touches a task while a run is in progress,
 * and only after a task has been held for a while.
 */
export type QueueTask = {
  id: string;
  taskType: string;
  status: string;
  target?: string | null;
  documentRef?: string | null;
  currentPhase?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  handoffs?: unknown[] | null;
};
export type Repair =
  | { kind: "requeue"; task: QueueTask; reason: string }
  | { kind: "drop"; task: QueueTask; reason: string };

export const STALE_HOLD_MS = 10 * 60_000;

/**
 * What to do about each task, given the sources that still exist and the time. On the start-up
 * pass (`startup`), every held task is one a closed app cut off — no run can be holding it — so it
 * is queued again at once, whatever its phase: the pipeline restarts it from the beginning, and
 * the extract step skips claims the vault already has.
 */
export function planRepairs(tasks: readonly QueueTask[], sourceIds: ReadonlySet<string>, nowIso: string, opts: { staleMs?: number; startup?: boolean } = {}): Repair[] {
  const staleMs = opts.staleMs ?? STALE_HOLD_MS;
  const now = Date.parse(nowIso);
  const out: Repair[] = [];
  for (const t of tasks) {
    if (t.taskType !== "claim") continue;
    if (t.status !== "PENDING" && t.status !== "IN_PROGRESS") continue;
    const ref = t.documentRef ?? "";
    if (!ref || !sourceIds.has(ref)) {
      out.push({ kind: "drop", task: t, reason: "the source no longer exists" });
      continue;
    }
    if (t.status !== "IN_PROGRESS") continue;
    if (opts.startup) {
      out.push({ kind: "requeue", task: t, reason: "the app was closed while it was being processed; queued again" });
      continue;
    }
    if ((t.handoffs?.length ?? 0) === 0) {
      const since = Date.parse(t.updatedAt ?? t.createdAt ?? "");
      if (Number.isFinite(since) && now - since >= staleMs) out.push({ kind: "requeue", task: t, reason: "held with no progress; queued again" });
    }
  }
  return out;
}

export type SourceState = { id: string; name: string; status: string; claims: number };
export type SourceRepair =
  | { kind: "reopen"; source: SourceState; reason: string }
  | { kind: "queue"; source: SourceState; reason: string };

/**
 * A source must never read as extracted without claims, and one that says it is being extracted
 * must have a task to do it. Checked on the start-up pass, over every source of the vault.
 */
export function planSourceRepairs(sources: readonly SourceState[], tasks: readonly QueueTask[]): SourceRepair[] {
  const open = new Set(tasks.filter((t) => t.taskType === "claim" && (t.status === "PENDING" || t.status === "IN_PROGRESS")).map((t) => t.documentRef ?? ""));
  const out: SourceRepair[] = [];
  for (const s of sources) {
    if (s.status === "EXTRACTED" && s.claims === 0) {
      out.push({ kind: "reopen", source: s, reason: "marked extracted but no claims were ever made" });
      if (!open.has(s.id)) out.push({ kind: "queue", source: s, reason: "queued again" });
    } else if (s.status === "EXTRACTING" && !open.has(s.id)) {
      out.push({ kind: "queue", source: s, reason: "waiting to be extracted with no task to do it" });
    }
  }
  return out;
}

export type WatchdogDeps = {
  origin: string;
  fetchImpl: typeof fetch;
  now?: () => string;
  newId?: () => string;
};
export type WatchdogResult = { requeued: string[]; dropped: string[]; reopened?: string[]; queued?: string[]; skipped?: string };
export type PassOptions = {
  /** The first pass after the engine started: everything held was cut off, and the sources are checked too. */
  startup?: boolean;
  /** Runs that began before this moment belong to a previous life of the engine: they are not in progress. */
  engineStartedAt?: string;
};

/** One pass over a vault's queue (and, on start-up, its sources). */
export async function repairQueue(deps: WatchdogDeps, vaultId: string, workflowId: string, pass: PassOptions = {}): Promise<WatchdogResult> {
  const f = deps.fetchImpl;
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? randomUUID;
  // Never while a run is going: a task held by a run in progress is not stuck. A run that began
  // before this engine started was cut off with the previous one, however its record reads.
  const runs = await gql<{ workflowRuntime: { runsPage: { items: Array<{ status: string; startedAt?: string | null }> } } }>(
    deps.origin,
    `query($w: String!) { workflowRuntime { runsPage(workflowId: $w, paging: { limit: 5 }) { items { status startedAt } } } }`,
    { w: workflowId },
    f,
  );
  const live = runs.workflowRuntime.runsPage.items.filter((r) => /running|pending|queued/i.test(r.status) && !(pass.engineStartedAt && r.startedAt && r.startedAt < pass.engineStartedAt));
  if (live.length) return { requeued: [], dropped: [], skipped: "a run is in progress" };

  const drive = await gql<{ document: { document: { state: { global: { nodes: Array<{ id: string; documentType?: string | null }> } } } } }>(
    deps.origin,
    `query($id: String!) { document(idOrSlug: $id) { document { state } } }`,
    { id: vaultId },
    f,
  );
  const nodes = drive.document.document.state.global.nodes;
  const queueId = nodes.find((n) => n.documentType === "bai/pipeline-queue")?.id;
  if (!queueId) return { requeued: [], dropped: [], skipped: "no pipeline queue" };
  const sourceIds = new Set(nodes.filter((n) => n.documentType === "bai/source").map((n) => n.id));

  const queue = await gql<{ document: { document: { state: { global: { tasks?: QueueTask[] } } } } }>(
    deps.origin,
    `query($id: String!) { document(idOrSlug: $id) { document { state } } }`,
    { id: queueId },
    f,
  );
  const tasks = queue.document.document.state.global.tasks ?? [];
  const repairs = planRepairs(tasks, sourceIds, now(), { startup: pass.startup });
  const at = now();
  const ops: { type: string; input: unknown }[] = [];
  const result: WatchdogResult = { requeued: [], dropped: [] };
  for (const r of repairs) {
    ops.push({ type: "FAIL_TASK", input: { taskId: r.task.id, reason: r.reason, updatedAt: at } });
    if (r.kind === "requeue") {
      ops.push({ type: "ADD_TASK", input: { id: newId(), taskType: "claim", target: r.task.target ?? "", documentRef: r.task.documentRef, createdAt: at } });
      result.requeued.push(r.task.target ?? r.task.id);
    } else {
      result.dropped.push(r.task.target ?? r.task.id);
    }
  }

  if (pass.startup) {
    // The sources, once per launch: never "extracted" without claims, never "extracting" without a task.
    const sources: SourceState[] = [];
    for (const id of sourceIds) {
      const doc = await gql<{ document: { document: { name: string; state: { global: { status?: string; extractedClaims?: unknown[] } } } } }>(
        deps.origin,
        `query($id: String!) { document(idOrSlug: $id) { document { name state } } }`,
        { id },
        f,
      );
      const g = doc.document.document.state.global;
      sources.push({ id, name: doc.document.document.name, status: g.status ?? "", claims: g.extractedClaims?.length ?? 0 });
    }
    // Tasks this pass is adding count as open for the sources they cover.
    const afterRepairs = [...tasks, ...repairs.filter((r) => r.kind === "requeue").map((r) => ({ ...r.task, status: "PENDING" }))];
    const sourceRepairs = planSourceRepairs(sources, afterRepairs);
    result.reopened = [];
    result.queued = [];
    for (const r of sourceRepairs) {
      if (r.kind === "reopen") {
        await execute(deps.origin, r.source.id, toActions([{ type: "SET_SOURCE_STATUS", input: { status: "EXTRACTING" } }], () => at), f);
        result.reopened.push(r.source.name);
      } else {
        ops.push({ type: "ADD_TASK", input: { id: newId(), taskType: "claim", target: r.source.name, documentRef: r.source.id, createdAt: at } });
        result.queued.push(r.source.name);
      }
    }
  }

  if (ops.length) await execute(deps.origin, queueId, toActions(ops, () => at), f);
  return result;
}

/** Every `intervalMs`, every vault with a live pipeline gets a pass; the first one soon after start. */
export function startQueueWatchdog(opts: {
  deps: WatchdogDeps;
  pipelines: () => Array<{ vaultId: string; workflowId: string }>;
  engineStartedAt: string;
  intervalMs?: number;
  initialDelayMs?: number;
  log?: (line: string) => void;
}): () => void {
  const log = opts.log ?? ((line) => console.log(`[sidecar] ${line}`));
  let busy = false;
  let first = true;
  const pass = async () => {
    if (busy) return;
    busy = true;
    const startup = first;
    first = false;
    try {
      for (const p of opts.pipelines()) {
        try {
          const r = await repairQueue(opts.deps, p.vaultId, p.workflowId, { startup, engineStartedAt: opts.engineStartedAt });
          const touched = r.requeued.length + r.dropped.length + (r.reopened?.length ?? 0) + (r.queued?.length ?? 0);
          if (touched) log(`queue watchdog (${p.vaultId}${startup ? ", start-up" : ""}): queued again ${r.requeued.length + (r.queued?.length ?? 0)} (${[...r.requeued, ...(r.queued ?? [])].join(", ")}); dropped ${r.dropped.length} for a missing source; reopened ${r.reopened?.length ?? 0} marked extracted without claims`);
        } catch (error) {
          log(`queue watchdog (${p.vaultId}) failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      busy = false;
    }
  };
  const soon = setTimeout(() => void pass(), opts.initialDelayMs ?? 30_000);
  const every = setInterval(() => void pass(), opts.intervalMs ?? 120_000);
  soon.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(soon);
    clearInterval(every);
  };
}
