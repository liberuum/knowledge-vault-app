import { useEffect, useState } from "react";
import { DeleteVaultDialog } from "../landing/DeleteVaultDialog.js";
import { RenameVaultDialog } from "../landing/RenameVaultDialog.js";
import type { SettingsApi } from "../screens/Settings.js";
import type { SidecarInfo } from "../sidecar.js";
import { shortAddress, type IdentityController } from "../state/use-identity.js";
import type { LocalProtection, VaultSummary } from "../vaults.js";
import { MaintenanceCards } from "./Maintenance.js";
import { invokeIfTauri, isTauri } from "../shell/tauri.js";
import { plainError } from "../problem.js";

const number = new Intl.NumberFormat("en-US");
const RESTART_GRACE_MS = 90_000;

/**
 * Spec §4.4: one switch for every local vault. Protecting makes the signed-in
 * Renown identity their administrator; the engine restarts with authentication
 * on, and the app reloads to talk to it as that identity.
 */
function ProtectionCard({ info, api, identity, pollMs, onRestarted }: { info: SidecarInfo; api: SettingsApi; identity: IdentityController; pollMs: number; onRestarted: () => void }) {
  const [protection, setProtection] = useState<LocalProtection | null>(null);
  const [restarting, setRestarting] = useState<{ target: boolean; adminAddress: string | null; startedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = identity.status?.authenticated === true && !!identity.status.address;

  useEffect(() => {
    let alive = true;
    api.fetchProtection(info).then((p) => alive && setProtection(p)).catch((e: Error) => alive && setError(`Could not read the protection setting: ${e.message}`));
    return () => {
      alive = false;
    };
  }, [api, info]);

  // While the engine restarts, ask /status until it answers with the new setting (or give up).
  useEffect(() => {
    if (!restarting) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const status = await api.fetchStatus(info);
        if (!alive) return;
        if (status.protected === restarting.target) {
          setProtection({ protected: status.protected, adminAddress: status.adminAddress ?? restarting.adminAddress });
          setRestarting(null);
          onRestarted();
          return;
        }
      } catch {
        // not back yet
      }
      if (!alive) return;
      if (Date.now() - restarting.startedAt > RESTART_GRACE_MS) {
        setError("The engine did not come back within 90 seconds. Restart the app.");
        setRestarting(null);
        return;
      }
      timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [restarting, api, info, pollMs, onRestarted]);

  async function toggle() {
    if (!protection) return;
    const target = !protection.protected;
    setError(null);
    try {
      const result = await api.setProtection(info, target);
      if (result.restarting) setRestarting({ target, adminAddress: result.adminAddress, startedAt: Date.now() });
      else setProtection({ protected: result.protected, adminAddress: result.adminAddress });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const canProtect = signedIn;
  // Opening protected vaults again is the administrator's call (spec §4.4).
  const admin = protection?.adminAddress ?? "";
  const canOpen = signedIn && !!admin && (identity.status?.address ?? "").toLowerCase() === admin.toLowerCase();
  return (
    <section className="kv-identity-card" aria-labelledby="kv-protection-title">
      <h2 id="kv-protection-title" className="kv-settings-subtitle">Protection</h2>
      {protection === null && !error && <p className="kv-quiet">…</p>}
      {protection && !restarting && (
        <>
          {protection.protected ? (
            <p className="kv-settings-lead">
              Local vaults are protected: the engine answers only your sign-in, and <span className="kv-mono">{shortAddress(protection.adminAddress ?? "")}</span> is their administrator. Every change is signed as you.
            </p>
          ) : (
            <p className="kv-settings-lead">Local vaults are open: the engine answers anyone using this computer, and changes carry the app's own key. Protecting them makes your Renown identity their administrator.</p>
          )}
          <div className="kv-form-actions">
            <button type="button" className="kv-button" disabled={protection.protected ? !canOpen : !canProtect} onClick={() => void toggle()}>
              {protection.protected ? "Open local vaults" : "Protect local vaults"}
            </button>
            {!protection.protected && !canProtect && <span className="kv-hint">Sign in first — protection makes your Renown identity the vaults' administrator.</span>}
            {protection.protected && !canOpen && <span className="kv-hint">Sign in as the administrator ({shortAddress(admin)}) to open the vaults again.</span>}
          </div>
        </>
      )}
      {restarting && <p role="status" className="kv-identity-waiting">Restarting the engine with the new setting…</p>}
      {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
    </section>
  );
}

/** Every local vault with rename and delete — the complete list the tiles' ⋯ menus are a shortcut to — and the protection switch. */
export function VaultsSection({
  info,
  api,
  identity,
  pollMs = 1000,
  onRestarted = () => window.location.reload(),
}: {
  info: SidecarInfo;
  api: SettingsApi;
  identity: IdentityController;
  pollMs?: number;
  /** After the engine came back with the new setting: the app reloads to talk to the engine it now is. */
  onRestarted?: () => void;
}) {
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<VaultSummary | null>(null);
  const [deleting, setDeleting] = useState<VaultSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [exported, setExported] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState<string | null>(null);

  async function exportOne(v: VaultSummary) {
    setExporting(v.id);
    try {
      const r = await api.exportVault(info, v.id);
      setExported((prev) => ({ ...prev, [v.id]: r.failed?.length ? `${r.path} (${r.failed.length} document${r.failed.length === 1 ? "" : "s"} could not be read)` : r.path }));
    } catch (e) {
      setExported((prev) => ({ ...prev, [v.id]: `Export failed: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      setExporting(null);
    }
  }

  useEffect(() => {
    let alive = true;
    api.fetchVaults(info).then((v) => alive && setVaults(v)).catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [api, info]);

  async function rename(v: VaultSummary, name: string) {
    setBusy(true);
    setDialogError(null);
    try {
      const r = await api.renameVault(info, v.id, name);
      setVaults((prev) => (prev ?? []).map((x) => (x.id === v.id ? { ...x, name: r.name } : x)));
      setRenaming(null);
    } catch (e) {
      setDialogError(`Could not rename the vault: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function remove(v: VaultSummary) {
    setBusy(true);
    setDialogError(null);
    try {
      await api.deleteVault(info, v.id);
      setVaults((prev) => (prev ?? []).filter((x) => x.id !== v.id));
      setDeleting(null);
    } catch (e) {
      setDialogError(`Could not delete the vault: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kv-settings-body">
      <p className="kv-settings-lead">Vaults live in the engine's store on this computer. Renaming keeps everything; deleting removes the vault with all its notes, maps and sources.</p>
      {error && <p role="alert" className="kv-error">Could not load the vaults: {plainError(error)}</p>}
      {vaults && vaults.length === 0 && <p className="kv-quiet">No vaults yet.</p>}
      {vaults && vaults.length > 0 && (
        <ul className="kv-settings-list" aria-label="Vaults">
          {vaults.map((v) => (
            <li key={v.id} className="kv-settings-row">
              <div className="kv-settings-row-main">
                <span className="kv-settings-row-title">{v.name}</span>
                <span className="kv-settings-row-meta">{number.format(v.noteCount)} note{v.noteCount === 1 ? "" : "s"}</span>
                {exported[v.id] && (
                  <span className="kv-settings-row-meta kv-mono">
                    {exported[v.id]}
                    {isTauri() && !exported[v.id]!.startsWith("Export failed") && (
                      <button type="button" className="kv-link-button" onClick={() => void invokeIfTauri("reveal_path", { path: exported[v.id] })}> Show</button>
                    )}
                  </span>
                )}
              </div>
              <div className="kv-settings-row-actions">
                <button type="button" className="kv-button" disabled={exporting === v.id} title="Write the vault as documents (the drive-sync format) under the data folder's exports/" onClick={() => void exportOne(v)}>{exporting === v.id ? "Exporting…" : "Export"}</button>
                <button type="button" className="kv-button" onClick={() => { setDialogError(null); setRenaming(v); }}>Rename</button>
                <button type="button" className="kv-button kv-button-danger-quiet" onClick={() => { setDialogError(null); setDeleting(v); }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ProtectionCard info={info} api={api} identity={identity} pollMs={pollMs} onRestarted={onRestarted} />
      <MaintenanceCards info={info} api={api} pollMs={pollMs} onRestarted={onRestarted} />
      {renaming && <RenameVaultDialog name={renaming.name} busy={busy} error={dialogError} onSave={(n) => void rename(renaming, n)} onClose={() => setRenaming(null)} />}
      {deleting && <DeleteVaultDialog name={deleting.name} noteCount={deleting.noteCount} busy={busy} error={dialogError} onConfirm={() => void remove(deleting)} onClose={() => setDeleting(null)} />}
    </div>
  );
}
