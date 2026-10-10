import { useState, type FormEvent } from "react";
import { Dialog } from "../shell/Dialog.js";
import { validateVaultName } from "./vault-name.js";
import { plainError } from "../problem.js";

export function RenameVaultDialog({ name, busy, error, onSave, onClose }: { name: string; busy: boolean; error: string | null; onSave: (name: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const [reason, setReason] = useState<string | null>(null);
  const check = validateVaultName(value);
  const unchanged = check.ok && check.name === name;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!check.ok) return setReason(check.reason);
    setReason(null);
    onSave(check.name);
  }
  return (
    <Dialog open title="Rename vault" onClose={onClose}>
      <form onSubmit={submit} className="kv-dialog-form">
        <label htmlFor="rename-vault-name">Name</label>
        <input id="rename-vault-name" value={value} onChange={(e) => setValue(e.target.value)} autoFocus disabled={busy} aria-invalid={reason ? true : undefined} />
        {reason && <p className="kv-reason">{reason}</p>}
        {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
        <div className="kv-dialog-actions">
          <button type="button" className="kv-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="kv-button kv-button-primary" disabled={busy || !check.ok || unchanged}>{busy ? "Saving…" : "Save name"}</button>
        </div>
      </form>
    </Dialog>
  );
}
