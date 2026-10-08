import { useCallback, useEffect, useState } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { fetchPipeline as realFetchPipeline, setupPipeline as realSetupPipeline, type PipelineStatus } from "../vaults.js";
import { describePipeline } from "./pipeline-chip.js";

export type PipelineChipApi = {
  fetchPipeline: (info: SidecarInfo, vaultId: string) => Promise<PipelineStatus>;
  setupPipeline: (info: SidecarInfo, vaultId: string) => Promise<PipelineStatus>;
};
const realApi: PipelineChipApi = { fetchPipeline: realFetchPipeline, setupPipeline: realSetupPipeline };

/** In a local vault's app bar: how processing stands, refreshed every 30 s, with the one action that fixes it. */
export function PipelineChip({ info, vaultId, api = realApi, onModels, onRuns, pollMs = 30_000 }: { info: SidecarInfo; vaultId: string; api?: PipelineChipApi; onModels: () => void; onRuns: (workflowId?: string) => void; pollMs?: number }) {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.fetchPipeline(info, vaultId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, info, vaultId]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (alive) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refresh, pollMs]);

  async function setup() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.setupPipeline(info, vaultId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return error ? <span className="kv-pipeline-chip" data-tone="warn" title={error}><span className="kv-identity-dot" aria-hidden="true" />Processing: unknown</span> : null;
  const d = describePipeline(status);
  const tooltip = status.state === "ready" ? (status.lastRun?.problem?.message ?? status.lastRun?.error ?? status.trigger?.lastError ?? undefined) : status.state === "stale" ? status.reason : undefined;
  // Once the pipeline exists, its workflow is one click away: the live run view in Workflow Studio.
  const workflowId = status.state === "ready" || status.state === "stale" ? status.workflowId : undefined;
  const act = d.action === "models" ? onModels : d.action === "runs" ? () => onRuns(workflowId) : () => void setup();
  return (
    <span className="kv-pipeline-chip" data-tone={d.tone} title={error ?? tooltip}>
      <span className="kv-identity-dot" aria-hidden="true" />
      {workflowId ? (
        <button type="button" className="kv-pipeline-link" aria-label={`${d.label} — open in Workflow Studio`} onClick={() => onRuns(workflowId)}>
          {d.label}
        </button>
      ) : (
        <span>{d.label}</span>
      )}
      {d.action && (
        <button type="button" onClick={act} disabled={busy}>
          {busy && d.action === "setup" ? "Setting up…" : d.actionLabel}
        </button>
      )}
    </span>
  );
}
