import { useState, type FormEvent } from "react";
import { validateVaultName } from "./vault-name.js";
import { plainError } from "../problem.js";

type Props = {
  firstRun: boolean;
  busy: boolean;
  error: string | null;
  onCreate: (name: string) => void;
  onCancel?: () => void;
};

/** The inline create form: Enter creates and opens the vault. On first run it is the screen's single target. */
export function NewVaultForm({ firstRun, busy, error, onCreate, onCancel }: Props) {
  const [name, setName] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const check = validateVaultName(name);
    if (!check.ok) return setReason(check.reason);
    setReason(null);
    onCreate(check.name);
  }
  return (
    <section className={firstRun ? "kv-create kv-create-first" : "kv-create"} aria-labelledby="create-heading">
      <h3 id="create-heading" className="kv-create-heading">{firstRun ? "Create your first vault" : "New vault"}</h3>
      <form className="kv-new-vault" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel?.()}>
        <label htmlFor="vault-name">Name</label>
        <input
          id="vault-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Research notes"
          autoFocus
          autoComplete="off"
          disabled={busy}
          aria-describedby={reason ? "vault-name-reason" : undefined}
          aria-invalid={reason ? true : undefined}
        />
        <button type="submit" className="kv-button kv-button-primary" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create vault"}
        </button>
        {!firstRun && onCancel && (
          <button type="button" className="kv-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </form>
      {reason && <p id="vault-name-reason" className="kv-reason">{reason}</p>}
      {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
    </section>
  );
}
