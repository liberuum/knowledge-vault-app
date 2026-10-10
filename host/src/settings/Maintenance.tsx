import { useEffect, useState } from "react";
import type { SettingsApi } from "../screens/Settings.js";
import { Dialog } from "../shell/Dialog.js";
import type { SidecarInfo } from "../sidecar.js";
import type { ActionResult, BackupInfo } from "../vaults.js";
import { requestGoHome } from "../shell/go-home.js";
import { plainError } from "../problem.js";

const RESTART_GRACE_MS = 120_000;

function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.ceil(bytes / 1e6))} MB`;
}
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Spec §9: backups, restores and the delete-all run with the store closed — the
 * engine records the wish and restarts. We wait for the result it records
 * (`lastAction`), then refresh (a backup) or reload (the store changed).
 */
function useScheduled(info: SidecarInfo, api: SettingsApi, pollMs: number, onRestarted: () => void) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [last, setLast] = useState<ActionResult | null>(null);
  const [waiting, setWaiting] = useState<{ action: ActionResult["action"]; since: string | null; startedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.fetchBackups(info).then(
      (r) => {
        if (!alive) return;
        setBackups(r.backups);
        setLast(r.lastAction);
      },
      (e: Error) => alive && setError(`Could not list the backups: ${e.message}`),
    );
    return () => {
      alive = false;
    };
  }, [api, info]);

  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await api.fetchBackups(info);
        if (!alive) return;
        if (r.lastAction && r.lastAction.at !== waiting.since) {
          setBackups(r.backups);
          setLast(r.lastAction);
          setWaiting(null);
          if (waiting.action !== "backup" && r.lastAction.ok) {
            // After a delete-all the app is at its first run: back to the front door, not Settings.
            if (waiting.action === "delete-all") window.location.hash = "#/";
            onRestarted();
          }
          return;
        }
      } catch {
        // the engine is restarting
      }
      if (!alive) return;
      if (Date.now() - waiting.startedAt > RESTART_GRACE_MS) {
        setError("The engine did not come back within two minutes. Restart the app.");
        setWaiting(null);
        return;
      }
      timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [waiting, api, info, pollMs, onRestarted]);

  async function schedule(action: ActionResult["action"], run: () => Promise<unknown>) {
    setError(null);
    try {
      // The result to wait past is the one recorded now — not whatever the first read happened to see.
      const before = await api.fetchBackups(info).catch(() => null);
      const since = before?.lastAction?.at ?? last?.at ?? null;
      if (action === "delete-all") requestGoHome();
      await run();
      setWaiting({ action, since, startedAt: Date.now() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return { backups, last, waiting, error, schedule };
}

export function MaintenanceCards({ info, api, pollMs, onRestarted }: { info: SidecarInfo; api: SettingsApi; pollMs: number; onRestarted: () => void }) {
  const { backups, last, waiting, error, schedule } = useScheduled(info, api, pollMs, onRestarted);
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [typed, setTyped] = useState("");
  const [includeBackups, setIncludeBackups] = useState(false);
  const busy = waiting !== null;
  return (
    <>
      <section className="kv-identity-card" aria-labelledby="kv-backups-title">
        <h2 id="kv-backups-title" className="kv-settings-subtitle">Backups</h2>
        <p className="kv-settings-lead">A backup copies every local vault, its records and settings — never your keys — into the data folder. The engine restarts to make it; the app updates by itself. One is also made before an upgrade opens your store. The newest ten are kept.</p>
        <div className="kv-form-actions">
          <button type="button" className="kv-button" disabled={busy} onClick={() => void schedule("backup", () => api.requestBackup(info))}>Back up now</button>
        </div>
        {waiting && <p role="status" className="kv-identity-waiting">Restarting the engine… the {waiting.action === "delete-all" ? "deletion" : waiting.action} runs before it starts again.</p>}
        {last && !waiting && <p className={last.ok ? "kv-quiet" : "kv-error"}>Last: {last.detail} ({when(last.at)})</p>}
        {backups && backups.length === 0 && <p className="kv-quiet">No backups yet.</p>}
        {backups && backups.length > 0 && (
          <ul className="kv-settings-list" aria-label="Backups">
            {backups.map((b) => (
              <li key={b.name} className="kv-settings-row">
                <div className="kv-settings-row-main">
                  <span className="kv-settings-row-title kv-mono">{b.name}</span>
                  <span className="kv-settings-row-meta">{size(b.bytes)} · stack {b.stackVersion}</span>
                </div>
                <div className="kv-settings-row-actions">
                  <button type="button" className="kv-button" disabled={busy} onClick={() => setRestoring(b)}>Restore</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
      </section>

      <section className="kv-identity-card" aria-labelledby="kv-delete-all-title">
        <h2 id="kv-delete-all-title" className="kv-settings-subtitle">Delete all local data</h2>
        <p className="kv-settings-lead">Removes every local vault, the settings, your sign-in, exports and the downloaded converter. The app returns to its first run. Remote vaults are not touched.</p>
        <label htmlFor="kv-delete-all-confirm">Type delete to confirm</label>
        <input id="kv-delete-all-confirm" className="kv-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={busy} />
        <label className="kv-check">
          <input type="checkbox" checked={includeBackups} onChange={(e) => setIncludeBackups(e.target.checked)} disabled={busy} /> Delete the backups too
        </label>
        <div className="kv-form-actions">
          <button
            type="button"
            className="kv-button kv-button-danger"
            disabled={busy || typed.trim() !== "delete"}
            onClick={() => void schedule("delete-all", () => api.requestDeleteAll(info, includeBackups))}
          >
            Delete all local data
          </button>
        </div>
      </section>

      {restoring && (
        <Dialog open title="Restore this backup?" onClose={() => setRestoring(null)} kind="danger">
          <div className="kv-dialog-form">
            <p>
              Your local vaults go back to <span className="kv-mono">{restoring.name}</span>. Settings, your sign-in and remote vaults stay as they are. What is there now is kept as a backup of its own, so this can be undone. The engine restarts.
            </p>
            <div className="kv-dialog-actions">
              <button type="button" className="kv-button" onClick={() => setRestoring(null)}>Cancel</button>
              <button
                type="button"
                className="kv-button kv-button-danger"
                onClick={() => {
                  const name = restoring.name;
                  setRestoring(null);
                  void schedule("restore", () => api.requestRestore(info, name));
                }}
              >
                Restore this backup
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
