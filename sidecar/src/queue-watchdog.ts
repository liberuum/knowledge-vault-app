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

/** What to do about each task, given the sources that still exist and the time. */
export function planRepairs(tasks: readonly QueueTask[], sourceIds: ReadonlySet<string>, nowIso: string, staleMs = STALE_HOLD_MS): Repair[] {
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
    if (t.status === "IN_PROGRESS" && (t.handoffs?.length ?? 0) === 0) {
      const since = Date.parse(t.updatedAt ?? t.createdAt ?? "");
      if (Number.isFinite(since) && now - since >= staleMs) out.push({ kind: "requeue", task: t, reason: "held with no progress; queued again" });
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
export type WatchdogResult = { requeued: string[]; dropped: string[]; skipped?: string };

/** One pass over a vault's queue. */
export async function repairQueue(deps: WatchdogDeps, vaultId: string, workflowId: string): Promise<WatchdogResult> {
  const f = deps.fetchImpl;
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? randomUUID;
  // Never while a run is going: a task held by a run in progress is not stuck.
  const runs = await gql<{ workflowRuntime: { runsPage: { items: Array<{ status: string }> } } }>(
    deps.origin,
    `query($w: String!) { workflowRuntime { runsPage(workflowId: $w, paging: { limit: 5 }) { items { status } } } }`,
    { w: workflowId },
    f,
  );
  if (runs.workflowRuntime.runsPage.items.some((r) => /running|pending|queued/i.test(r.status))) return { requeued: [], dropped: [], skipped: "a run is in progress" };

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
  const repairs = planRepairs(queue.document.document.state.global.tasks ?? [], sourceIds, now());
  if (repairs.length === 0) return { requeued: [], dropped: [] };

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
  await execute(deps.origin, queueId, toActions(ops, () => at), f);
  return result;
}

/** Every `intervalMs`, every vault with a live pipeline gets a pass; the first one soon after start. */
export function startQueueWatchdog(opts: {
  deps: WatchdogDeps;
  pipelines: () => Array<{ vaultId: string; workflowId: string }>;
  intervalMs?: number;
  initialDelayMs?: number;
  log?: (line: string) => void;
}): () => void {
  const log = opts.log ?? ((line) => console.log(`[sidecar] ${line}`));
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const p of opts.pipelines()) {
        try {
          const r = await repairQueue(opts.deps, p.vaultId, p.workflowId);
          if (r.requeued.length || r.dropped.length) log(`queue watchdog (${p.vaultId}): queued again ${r.requeued.length} (${r.requeued.join(", ")}); dropped ${r.dropped.length} for a missing source`);
        } catch (error) {
          log(`queue watchdog (${p.vaultId}) failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void pass(), opts.initialDelayMs ?? 30_000);
  const every = setInterval(() => void pass(), opts.intervalMs ?? 120_000);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
