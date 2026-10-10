import { useState, type FormEvent } from "react";
import { Dialog } from "../shell/Dialog.js";
import { plainError } from "../problem.js";

/** Deleting a vault is the one irreversible act in the app: the name must be typed exactly. */
export function DeleteVaultDialog({ name, noteCount, busy, error, onConfirm, onClose }: { name: string; noteCount: number; busy: boolean; error: string | null; onConfirm: () => void; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const confirmed = typed.trim() === name;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (confirmed && !busy) onConfirm();
  }
  return (
    <Dialog open title={`Delete “${name}”?`} onClose={onClose} kind="danger">
      <form onSubmit={submit} className="kv-dialog-form">
        <p>
          This deletes the vault and everything in it{noteCount > 0 ? ` — ${noteCount.toLocaleString("en-US")} note${noteCount === 1 ? "" : "s"}, its maps and sources` : ""}. It cannot be undone.
        </p>
        <label htmlFor="delete-vault-confirm">Type the vault’s name to confirm</label>
        <input id="delete-vault-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={name} autoFocus autoComplete="off" disabled={busy} />
        {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
        <div className="kv-dialog-actions">
          <button type="button" className="kv-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="kv-button kv-button-danger" disabled={!confirmed || busy}>{busy ? "Deleting…" : "Delete vault"}</button>
        </div>
      </form>
    </Dialog>
  );
}
