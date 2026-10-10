import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { suggestedFileName, type ArchiveSummary, type TransferJob } from "../backup-files.js";
import { plainError } from "../problem.js";
import type { SettingsApi } from "../screens/Settings.js";
import { Dialog } from "../shell/Dialog.js";
import { requestGoHome } from "../shell/go-home.js";
import { invokeIfTauri, isTauri } from "../shell/tauri.js";
import type { SidecarInfo } from "../sidecar.js";
import type { ActionResult, BackupInfo, VaultSummary } from "../vaults.js";
import "./backups.css";

/**
 * Settings › Backup & restore. Four questions, in the order people ask them:
 *   Is my work safe?           → the status card: the last backup, and "Back up now".
 *   How do I take it with me?  → Export to a file / Import a file (a `.kvbackup` holds every local vault).
 *   Can I go back?             → Restore points: every backup, newest first, each restorable or savable.
 *   How do I start over?       → Delete all local data, last and apart.
 * Backups, restores and imports-that-replace run with the store closed: the engine restarts, and
 * one panel at the top walks through the steps while it does.
 */
const RESTART_GRACE_MS = 120_000;
const STALE_DAYS = 7;

type Step = { label: string; state: "done" | "active" | "todo"; progress?: number | null };
type Activity = {
  title: string;
  steps: Step[];
  outcome?: { ok: boolean; title: string; detail?: string; file?: string };
};
class Cancelled extends Error {}

export function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.ceil(bytes / 1e6))} MB`;
}
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** "Today, 6:19 PM" · "Yesterday, 9:02 AM" · "Mon 6 Oct, 6:19 PM" · "6 Oct 2025, 6:19 PM". */
export function friendlyWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return `Today, ${time(d)}`;
  if (sameDay(d, yesterday)) return `Yesterday, ${time(d)}`;
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear() ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" };
  return `${d.toLocaleDateString(undefined, opts)}, ${time(d)}`;
}
/** The status card's headline: "Backed up today at 6:19 PM" · "Last backup 9 days ago" · "No backup yet". */
export function lastBackupLine(latest: BackupInfo | undefined, now = new Date()): { text: string; fresh: boolean } {
  if (!latest) return { text: "No backup yet", fresh: false };
  const d = new Date(latest.createdAt);
  if (Number.isNaN(d.getTime())) return { text: "Backed up", fresh: true };
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return { text: `Backed up today at ${time(d)}`, fresh: true };
  if (sameDay(d, yesterday)) return { text: `Backed up yesterday at ${time(d)}`, fresh: true };
  return { text: days <= STALE_DAYS ? `Backed up ${days} days ago` : `Last backup ${days} days ago`, fresh: days <= STALE_DAYS };
}
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/** "Research · 39 notes" for one vault; "3 vaults · 120 notes" for more. */
export function vaultsLine(vaults: { name: string; noteCount: number }[] | undefined | null): string | null {
  if (!vaults?.length) return null;
  const notes = vaults.reduce((n, v) => n + v.noteCount, 0);
  return vaults.length === 1 ? `${vaults[0]!.name} · ${plural(notes, "note")}` : `${plural(vaults.length, "vault")} · ${plural(notes, "note")}`;
}
const KIND: Record<NonNullable<BackupInfo["kind"]>, string | null> = { backup: null, "pre-restore": "Before a restore", "before-upgrade": "Before an update", imported: "Imported" };
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function BackupsSection({
  info,
  api,
  pollMs = 1000,
  onRestarted = () => window.location.reload(),
  canPickFiles = isTauri(),
}: {
  info: SidecarInfo;
  api: SettingsApi;
  pollMs?: number;
  onRestarted?: () => void;
  /** The desktop's file dialogs pick where an export goes and which file to import; a browser has none. */
  canPickFiles?: boolean;
}) {
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [last, setLast] = useState<ActionResult | null>(null);
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = useState<BackupInfo | null>(null);
  const [importing, setImporting] = useState<ArchiveSummary | null>(null);
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const alive = useRef(true);

  const refresh = async () => {
    const r = await api.fetchBackups(info);
    if (!alive.current) return r;
    setBackups(r.backups);
    setLast(r.lastAction);
    return r;
  };
  useEffect(() => {
    alive.current = true;
    refresh().catch((e: Error) => alive.current && setError(`Could not list the backups: ${e.message}`));
    api.fetchVaults(info).then((v) => alive.current && setVaults(v), () => {});
    // An export still being written (the page was reloaded, or Settings reopened): follow it.
    api.fetchTransfer(info).then(
      (j) => {
        if (alive.current && j?.state === "running") void run(j.kind === "export" ? "Exporting" : "Importing", (step) => followJob(j, step));
      },
      () => {},
    );
    return () => {
      alive.current = false;
    };
  }, [api, info]); // once per engine; the flows read the latest state when they run

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = () => Date.now() + RESTART_GRACE_MS;
  const since = async () => (await api.fetchBackups(info).catch(() => null))?.lastAction?.at ?? last?.at ?? null;

  /** The result the engine records after it restarts — past `before`. */
  async function waitForAction(before: string | null): Promise<ActionResult> {
    const until = deadline();
    for (;;) {
      if (!alive.current) throw new Cancelled();
      try {
        const r = await api.fetchBackups(info);
        if (r.lastAction && r.lastAction.at !== before) {
          if (alive.current) {
            setBackups(r.backups);
            setLast(r.lastAction);
          }
          return r.lastAction;
        }
      } catch {
        // the engine is restarting
      }
      if (Date.now() > until) throw new Error("The engine did not come back within two minutes. Restart the app.");
      await sleep(pollMs);
    }
  }
  /** Follows a transfer to its end; `onGone` ends early when the engine goes away (an import that restores). */
  async function waitForJob(id: (j: TransferJob) => boolean, onProgress: (j: TransferJob) => void, onGone?: () => boolean): Promise<TransferJob | null> {
    const until = deadline();
    for (;;) {
      if (!alive.current) throw new Cancelled();
      try {
        const j = await api.fetchTransfer(info);
        if (j && id(j)) {
          onProgress(j);
          if (j.state !== "running") return j;
        } else if (onGone?.()) return null;
      } catch {
        if (onGone?.()) return null;
      }
      if (Date.now() > until) throw new Error("The file is taking longer than two minutes; it carries on in the background.");
      await sleep(pollMs);
    }
  }
  /** The vault list answers once the engine is wholly up — only then is the page reloaded. */
  async function waitForEngine(): Promise<void> {
    const until = deadline();
    for (;;) {
      try {
        await api.fetchVaults(info);
        return;
      } catch {
        if (Date.now() > until) return;
        await sleep(pollMs);
      }
    }
  }

  async function run(title: string, flow: (step: (steps: Step[]) => void) => Promise<Activity["outcome"] | void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const step = (steps: Step[]) => alive.current && setActivity({ title, steps });
    try {
      const outcome = await flow(step);
      if (alive.current) setActivity(outcome ? { title, steps: [], outcome } : null);
    } catch (e) {
      if (e instanceof Cancelled) return;
      if (alive.current) setActivity({ title, steps: [], outcome: { ok: false, title: `${title} did not finish`, detail: plainError(e instanceof Error ? e.message : String(e)) } });
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const pct = (j: TransferJob) => (j.total > 0 ? Math.min(1, j.done / j.total) : null);
  async function followJob(j: TransferJob, step: (s: Step[]) => void): Promise<Activity["outcome"]> {
    const label = j.kind === "export" ? `Writing ${fileName(j.file)}` : `Unpacking ${fileName(j.file)}`;
    const end = await waitForJob((x) => x.id === j.id, (x) => step([{ label, state: "active", progress: pct(x) }]));
    if (!end || end.state === "failed") throw new Error(end?.error ?? "The engine stopped before the file was finished.");
    await refresh().catch(() => {});
    return end.kind === "export" ? { ok: true, title: "Exported", detail: `${fileName(end.file)} · ${size(end.bytes ?? 0)}`, file: end.file } : { ok: true, title: "Added to restore points", detail: fileName(end.file) };
  }

  const backUp = () =>
    run("Backing up", async (step) => {
      const before = await since();
      await api.requestBackup(info);
      step([{ label: "Making a clean copy of your vaults — the engine restarts for it", state: "active" }]);
      const r = await waitForAction(before);
      if (!r.ok) throw new Error(r.detail);
      return { ok: true, title: "Backed up", detail: "A new restore point is at the top of the list." };
    });

  const exportAll = () =>
    run("Exporting", async (step) => {
      const path = await api.chooseExportPath(suggestedFileName(new Date()));
      if (!path) return;
      const before = await since();
      await api.exportToFile(info, path);
      step([
        { label: "Making a clean copy of your vaults — the engine restarts for it", state: "active" },
        { label: `Writing ${fileName(path)}`, state: "todo" },
      ]);
      const r = await waitForAction(before);
      if (!r.ok) throw new Error(r.detail);
      const write = `Writing ${fileName(path)}`;
      const end = await waitForJob(
        (j) => j.kind === "export" && (j.file === path || j.file === `${path}.kvbackup`),
        (j) => step([{ label: "Made a clean copy of your vaults", state: "done" }, { label: write, state: "active", progress: pct(j) }]),
      );
      if (!end || end.state === "failed") throw new Error(end?.error ?? "The file was not written.");
      return { ok: true, title: "Exported", detail: `${fileName(end.file)} · ${size(end.bytes ?? 0)}`, file: end.file };
    });

  const saveToFile = (b: BackupInfo) =>
    run("Exporting", async (step) => {
      const path = await api.chooseExportPath(suggestedFileName(new Date(b.createdAt)));
      if (!path) return;
      const job = await api.saveBackupToFile(info, b.name, path);
      step([{ label: `Writing ${fileName(job.file)}`, state: "active", progress: 0 }]);
      return followJob(job, step);
    });

  const pickImport = () =>
    run("Importing", async () => {
      const path = await api.chooseImportFile();
      if (!path) return;
      const summary = await api.inspectBackupFile(info, path);
      if (alive.current) setImporting(summary);
    });

  const importFile = (summary: ArchiveSummary, restore: boolean) => {
    setImporting(null);
    void run("Importing", async (step) => {
      const before = await since();
      const unpack = `Unpacking ${fileName(summary.file)}`;
      const swap = "Switching to the imported vaults — yours are kept as a restore point";
      const job = await api.importBackupFile(info, summary.file, restore);
      step(restore ? [{ label: unpack, state: "active", progress: 0 }, { label: swap, state: "todo" }] : [{ label: unpack, state: "active", progress: 0 }]);
      // Once the job was seen, an engine that stops answering (or answers without it) is the restore's restart.
      let seen = false;
      const end = await waitForJob(
        (j) => j.id === job.id,
        (j) => {
          seen = true;
          step(restore ? [{ label: unpack, state: j.state === "done" ? "done" : "active", progress: pct(j) }, { label: swap, state: j.state === "done" ? "active" : "todo" }] : [{ label: unpack, state: "active", progress: pct(j) }]);
        },
        () => restore && seen,
      );
      if (end?.state === "failed") throw new Error(end.error ?? "The file could not be imported.");
      if (!restore) {
        await refresh().catch(() => {});
        return { ok: true, title: "Added to restore points", detail: `${fileName(summary.file)} — restore it whenever you like.` };
      }
      step([{ label: unpack, state: "done" }, { label: swap, state: "active" }]);
      const r = await waitForAction(before);
      if (!r.ok || r.action !== "restore") throw new Error(r.detail);
      step([{ label: unpack, state: "done" }, { label: swap, state: "done" }, { label: "Opening your vaults", state: "active" }]);
      await waitForEngine();
      onRestarted();
      throw new Cancelled(); // the page reloads
    });
  };

  const restore = (b: BackupInfo) => {
    setRestoring(null);
    void run("Restoring", async (step) => {
      const before = await since();
      await api.requestRestore(info, b.name);
      step([{ label: "Setting your current vaults aside and switching — the engine restarts", state: "active" }]);
      const r = await waitForAction(before);
      if (!r.ok) throw new Error(r.detail);
      step([{ label: "Switched to the restore point", state: "done" }, { label: "Opening your vaults", state: "active" }]);
      await waitForEngine();
      onRestarted();
      throw new Cancelled();
    });
  };

  const removeBackup = (b: BackupInfo) => {
    setDeleting(null);
    void run("Deleting", async () => {
      await api.deleteBackup(info, b.name);
      await refresh();
    });
  };

  const deleteAll = (includeBackups: boolean) => {
    setConfirmingDeleteAll(false);
    void run("Deleting everything", async (step) => {
      const before = await since();
      requestGoHome();
      await api.requestDeleteAll(info, includeBackups);
      step([{ label: "Deleting all local data — the engine restarts", state: "active" }]);
      const r = await waitForAction(before);
      if (!r.ok) throw new Error(r.detail);
      // After a delete-all the app is at its first run: back to the front door, not Settings.
      window.location.hash = "#/";
      onRestarted();
      throw new Cancelled();
    });
  };

  const latest = backups?.find((b) => b.kind !== "pre-restore" && b.kind !== "imported");
  const status = lastBackupLine(latest);
  const here = vaults ? (vaults.length ? `${vaultsLine(vaults.map((v) => ({ name: v.name, noteCount: v.noteCount })))} on this computer` : "No local vaults yet") : null;

  return (
    <div className="kv-bk">
      <section className={`kv-bk-status ${status.fresh ? "is-fresh" : "is-stale"}`} aria-labelledby="kv-bk-status-title">
        <span className="kv-bk-status-badge" aria-hidden="true">
          {status.fresh ? <ShieldCheckIcon /> : <ShieldIcon />}
        </span>
        <div className="kv-bk-status-main">
          <h3 id="kv-bk-status-title" className="kv-bk-status-title">{status.text}</h3>
          <p className="kv-bk-status-meta">
            {here ?? " "}
            {!status.fresh && latest === undefined && backups !== null && " — make a first restore point now."}
          </p>
        </div>
        <button type="button" className="kv-button kv-button-primary kv-bk-status-action" disabled={busy} onClick={() => void backUp()}>
          Back up now
        </button>
        {activity && <ActivityPanel activity={activity} onDismiss={busy ? undefined : () => setActivity(null)} />}
      </section>

      <section className="kv-bk-card" aria-labelledby="kv-bk-move-title">
        <header className="kv-bk-card-head">
          <h3 id="kv-bk-move-title" className="kv-bk-card-title">Move your vaults</h3>
          <p className="kv-bk-card-lead">Take every local vault to another computer, or keep a copy outside the app.</p>
        </header>
        <div className="kv-bk-tiles">
          <div className="kv-bk-tile">
            <span className="kv-bk-tile-icon" aria-hidden="true"><ExportIcon /></span>
            <h4 className="kv-bk-tile-title">Export to a file</h4>
            <p className="kv-bk-tile-text">Saves all your local vaults into one <span className="kv-bk-ext">.kvbackup</span> file you can keep anywhere.</p>
            <button type="button" className="kv-button" disabled={busy || !canPickFiles} onClick={() => void exportAll()}>Export…</button>
          </div>
          <div className="kv-bk-tile">
            <span className="kv-bk-tile-icon" aria-hidden="true"><ImportIcon /></span>
            <h4 className="kv-bk-tile-title">Import a file</h4>
            <p className="kv-bk-tile-text">Opens a <span className="kv-bk-ext">.kvbackup</span> file. You see what is in it before anything changes.</p>
            <button type="button" className="kv-button" disabled={busy || !canPickFiles} onClick={() => void pickImport()}>Import…</button>
          </div>
        </div>
        <p className="kv-bk-assurance">
          <LockIcon /> Files hold your notes, maps, sources and attachments — never your sign-in or keys.
        </p>
      </section>

      <section className="kv-bk-card" aria-labelledby="kv-bk-points-title">
        <header className="kv-bk-card-head">
          <h3 id="kv-bk-points-title" className="kv-bk-card-title">Restore points</h3>
          <p className="kv-bk-card-lead">Go back to any of these. What is there now is kept as a restore point first, so a restore can be undone.</p>
        </header>
        {backups === null && !error && <p className="kv-quiet">Loading…</p>}
        {backups && backups.length === 0 && <p className="kv-bk-empty">No restore points yet. <strong>Back up now</strong> makes the first one.</p>}
        {backups && backups.length > 0 && (
          <ol className="kv-bk-points" aria-label="Restore points">
            {backups.map((b, i) => {
              const tag = KIND[b.kind ?? "backup"];
              const holds = vaultsLine(b.vaults);
              return (
                <li key={b.name} className="kv-bk-point" title={`${b.name} · stack ${b.stackVersion}`}>
                  <span className="kv-bk-point-dot" aria-hidden="true" />
                  <div className="kv-bk-point-main">
                    <span className="kv-bk-point-title">
                      {friendlyWhen(b.createdAt)}
                      {i === 0 && <span className="kv-bk-chip is-latest">Newest</span>}
                      {tag && <span className="kv-bk-chip">{tag}</span>}
                    </span>
                    <span className="kv-bk-point-meta">
                      {[holds, size(b.bytes), b.importedFrom ? `from ${b.importedFrom}` : null].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  <div className="kv-bk-point-actions">
                    <button type="button" className="kv-button kv-button-quiet" disabled={busy || !canPickFiles} onClick={() => void saveToFile(b)} aria-label={`Save the restore point of ${friendlyWhen(b.createdAt)} to a file`}>
                      Save to file…
                    </button>
                    <button type="button" className="kv-button" disabled={busy} onClick={() => setRestoring(b)}>Restore</button>
                    <button type="button" className="kv-bk-icon-button" disabled={busy} onClick={() => setDeleting(b)} aria-label={`Delete the restore point of ${friendlyWhen(b.createdAt)}`} title="Delete">
                      <TrashIcon />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p className="kv-bk-footnote">The newest ten backups are kept, and three made before a restore. Imported ones stay until you delete them.</p>
        {last && !last.ok && !activity && <p role="alert" className="kv-error">Last: {plainError(last.detail)}</p>}
        {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
      </section>

      <section className="kv-bk-card kv-bk-danger" aria-labelledby="kv-delete-all-title">
        <header className="kv-bk-card-head">
          <h3 id="kv-delete-all-title" className="kv-bk-card-title">Delete all local data</h3>
          <p className="kv-bk-card-lead">Start over on this computer: the app returns to its first run.</p>
        </header>
        <div className="kv-bk-ledger">
          <div className="kv-bk-ledger-side is-removed">
            <span className="kv-bk-ledger-head">Removed</span>
            <ul aria-label="Removed">
              <li><span>Every local vault</span></li>
              <li><span>Settings and your sign-in</span></li>
              <li><span>Exports and the downloaded converter</span></li>
            </ul>
          </div>
          <div className="kv-bk-ledger-side is-kept">
            <span className="kv-bk-ledger-head">Kept</span>
            <ul aria-label="Kept">
              <li><span>Vaults on other servers</span></li>
              <li><span>Backup files you saved (<span className="kv-bk-ext">.kvbackup</span>)</span></li>
              <li><span>Restore points, unless you choose otherwise</span></li>
            </ul>
          </div>
        </div>
        <div>
          <button type="button" className="kv-button kv-button-danger-quiet kv-bk-danger-open" disabled={busy} onClick={() => setConfirmingDeleteAll(true)}>
            Delete all local data…
          </button>
        </div>
      </section>

      {restoring && (
        <Dialog open title={`Restore to ${friendlyWhen(restoring.createdAt)}?`} onClose={() => setRestoring(null)}>
          <div className="kv-dialog-form">
            <p>Your local vaults go back to how they were then{vaultsLine(restoring.vaults) ? <> — <strong>{vaultsLine(restoring.vaults)}</strong></> : null}.</p>
            <Assurance>What is here now is saved as a restore point first, so you can undo this.</Assurance>
            <p className="kv-quiet">Settings, your sign-in and remote vaults stay as they are. The engine restarts, which takes about half a minute.</p>
            <div className="kv-dialog-actions">
              <button type="button" className="kv-button" onClick={() => setRestoring(null)}>Cancel</button>
              <button type="button" className="kv-button kv-button-primary" onClick={() => restore(restoring)}>Restore</button>
            </div>
          </div>
        </Dialog>
      )}

      {deleting && (
        <Dialog open title="Delete this restore point?" onClose={() => setDeleting(null)} kind="danger">
          <div className="kv-dialog-form">
            <p>
              <strong>{friendlyWhen(deleting.createdAt)}</strong> · {size(deleting.bytes)}. This cannot be undone.
            </p>
            <div className="kv-dialog-actions">
              <button type="button" className="kv-button" onClick={() => setDeleting(null)}>Cancel</button>
              <button type="button" className="kv-button kv-button-danger" onClick={() => removeBackup(deleting)}>Delete</button>
            </div>
          </div>
        </Dialog>
      )}

      {importing && <ImportDialog summary={importing} onClose={() => setImporting(null)} onImport={(restore) => importFile(importing, restore)} />}

      {confirmingDeleteAll && (
        <DeleteAllDialog
          points={backups?.length ?? 0}
          bytes={(backups ?? []).reduce((n, b) => n + b.bytes, 0)}
          canExport={canPickFiles}
          onExportFirst={() => {
            setConfirmingDeleteAll(false);
            void exportAll();
          }}
          onConfirm={(includeBackups) => deleteAll(includeBackups)}
          onClose={() => setConfirmingDeleteAll(false)}
        />
      )}
    </div>
  );
}

function ImportDialog({ summary, onClose, onImport }: { summary: ArchiveSummary; onClose: () => void; onImport: (restore: boolean) => void }) {
  const holds = vaultsLine(summary.vaults);
  return (
    <Dialog open title={summary.tooNew ? "This file needs a newer app" : "Import this backup?"} onClose={onClose}>
      <div className="kv-dialog-form">
        <div className="kv-bk-file">
          <span className="kv-bk-file-icon" aria-hidden="true"><FileIcon /></span>
          <div className="kv-bk-file-main">
            <span className="kv-bk-file-name">{fileName(summary.file)}</span>
            <span className="kv-bk-file-meta">{size(summary.fileBytes)} file</span>
          </div>
        </div>
        <dl className="kv-bk-facts">
          <dt>Made</dt>
          <dd>{friendlyWhen(summary.createdAt)}</dd>
          <dt>Holds</dt>
          <dd>{holds ?? "Not recorded in this file"}</dd>
          <dt>Size</dt>
          <dd>{size(summary.bytes)} once unpacked</dd>
          {summary.appVersion && (
            <>
              <dt>Made by</dt>
              <dd>Knowledge Vault {summary.appVersion}</dd>
            </>
          )}
        </dl>
        {summary.tooNew ? (
          <p role="alert" className="kv-error">This file was made by a newer Knowledge Vault (stack {summary.stackVersion}). Update the app, then import it.</p>
        ) : (
          <Assurance>Importing replaces your local vaults with the ones in this file. What is here now is saved as a restore point first, so you can undo it.</Assurance>
        )}
        <div className="kv-dialog-actions">
          {summary.tooNew ? (
            <button type="button" className="kv-button" onClick={onClose}>Close</button>
          ) : (
            <>
              <button type="button" className="kv-button kv-button-quiet kv-bk-later" onClick={() => onImport(false)}>Only add to restore points</button>
              <button type="button" className="kv-button" onClick={onClose}>Cancel</button>
              <button type="button" className="kv-button kv-button-primary" onClick={() => onImport(true)}>Import and replace</button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The one step that cannot be undone: what goes and what stays first, the restore points as a choice
 * (kept unless ticked), a way to take a copy before going on, and the word typed to confirm — the
 * same shape as deleting one vault (landing/DeleteVaultDialog.tsx).
 */
function DeleteAllDialog({
  points,
  bytes,
  canExport,
  onExportFirst,
  onConfirm,
  onClose,
}: {
  points: number;
  bytes: number;
  canExport: boolean;
  onExportFirst: () => void;
  onConfirm: (includeBackups: boolean) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [withPoints, setWithPoints] = useState(false);
  const confirmed = typed.trim().toLowerCase() === "delete";
  const recoverable = points > 0 && !withPoints;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (confirmed) onConfirm(withPoints);
  }
  return (
    <Dialog open title="Delete all local data?" onClose={onClose} kind="danger">
      <form onSubmit={submit} className="kv-dialog-form kv-bk-delete">
        <p>Every local vault, the settings, your sign-in, exports and the downloaded converter are removed, and the app returns to its first run. Vaults on other servers are not touched.</p>
        {recoverable ? (
          <Assurance>
            {points === 1 ? `Your restore point (${size(bytes)}) stays` : `Your ${plural(points, "restore point")} (${size(bytes)}) stay`}, so everything can be brought back.
          </Assurance>
        ) : (
          <p className="kv-bk-warn">
            <AlertIcon /> <span>{points > 0 ? "With the restore points gone too, nothing can be brought back." : "There are no restore points, so nothing can be brought back."}</span>
          </p>
        )}
        {points > 0 && (
          <label className="kv-bk-choice">
            <input type="checkbox" checked={withPoints} onChange={(e) => setWithPoints(e.target.checked)} />
            <span>
              Also delete the restore points
              <span className="kv-bk-choice-meta">
                {plural(points, "restore point")} · {size(bytes)}
              </span>
            </span>
          </label>
        )}
        <label htmlFor="kv-delete-all-confirm" className="kv-bk-confirm-label">
          Type <code className="kv-bk-word">delete</code> to confirm
        </label>
        <input
          id="kv-delete-all-confirm"
          className={`kv-bk-confirm${confirmed ? " is-confirmed" : ""}`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="delete"
          autoFocus
          data-autofocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="kv-dialog-actions">
          {canExport && (
            <button type="button" className="kv-button kv-button-quiet kv-bk-later" onClick={onExportFirst}>
              Export to a file first
            </button>
          )}
          <button type="button" className="kv-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="kv-button kv-button-danger" disabled={!confirmed}>Delete everything</button>
        </div>
      </form>
    </Dialog>
  );
}

function ActivityPanel({ activity, onDismiss }: { activity: Activity; onDismiss: (() => void) | undefined }) {
  const { outcome } = activity;
  if (outcome) {
    return (
      <div className={`kv-bk-activity kv-bk-outcome ${outcome.ok ? "is-ok" : "is-failed"}`} role={outcome.ok ? "status" : "alert"}>
        <span className="kv-bk-outcome-mark" aria-hidden="true">{outcome.ok ? <CheckIcon /> : <AlertIcon />}</span>
        <div className="kv-bk-outcome-main">
          <span className="kv-bk-outcome-title">{outcome.title}</span>
          {outcome.detail && <span className="kv-bk-outcome-detail">{outcome.detail}</span>}
        </div>
        {outcome.file && isTauri() && (
          <button type="button" className="kv-button kv-button-quiet" onClick={() => void invokeIfTauri("reveal_path", { path: outcome.file })}>Show in folder</button>
        )}
        {onDismiss && (
          <button type="button" className="kv-bk-icon-button" onClick={onDismiss} aria-label="Dismiss">
            <CloseIcon />
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="kv-bk-activity" role="status" aria-live="polite">
      <span className="kv-bk-activity-title">{activity.title}…</span>
      <ol className="kv-bk-steps">
        {activity.steps.map((s) => (
          <li key={s.label} className={`kv-bk-step is-${s.state}`}>
            <span className="kv-bk-step-mark" aria-hidden="true">{s.state === "done" ? <CheckIcon /> : null}</span>
            <span className="kv-bk-step-body">
              <span className="kv-bk-step-label">
                {s.label}
                {s.state === "active" && typeof s.progress === "number" && <span className="kv-bk-step-pct"> {Math.round(s.progress * 100)}%</span>}
              </span>
              {s.state === "active" && (
                <span className={`kv-bk-bar ${typeof s.progress === "number" ? "" : "is-indeterminate"}`} role="progressbar" aria-label={s.label} aria-valuemin={0} aria-valuemax={100} {...(typeof s.progress === "number" ? { "aria-valuenow": Math.round(s.progress * 100) } : {})}>
                  <span className="kv-bk-bar-fill" style={typeof s.progress === "number" ? { width: `${Math.max(2, s.progress * 100)}%` } : undefined} />
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Assurance({ children }: { children: ReactNode }) {
  return (
    <p className="kv-bk-assure">
      <ShieldCheckIcon /> <span>{children}</span>
    </p>
  );
}

const icon = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
function ShieldIcon() {
  return <svg {...icon}><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" /><path d="M12 8v4M12 15.5v.01" /></svg>;
}
function ShieldCheckIcon() {
  return <svg {...icon}><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>;
}
function ExportIcon() {
  return <svg {...icon}><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5" /><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></svg>;
}
function ImportIcon() {
  return <svg {...icon}><path d="M12 3v12M7.5 10.5L12 15l4.5-4.5" /><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></svg>;
}
function LockIcon() {
  return <svg {...icon} width={14} height={14}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
}
function TrashIcon() {
  return <svg {...icon} width={16} height={16}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>;
}
function FileIcon() {
  return <svg {...icon}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>;
}
function CheckIcon() {
  return <svg {...icon} width={14} height={14} strokeWidth={2.2}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}
function AlertIcon() {
  return <svg {...icon} width={16} height={16}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16v.01" /></svg>;
}
function CloseIcon() {
  return <svg {...icon} width={14} height={14}><path d="M6 6l12 12M18 6L6 18" /></svg>;
}
