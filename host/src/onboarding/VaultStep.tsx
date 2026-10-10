import { useEffect, useState, type FormEvent } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { fetchVaults, type VaultSummary } from "../vaults.js";
import { createGuideVault } from "./api.js";
import { rememberGuide } from "./progress.js";
import { plainError } from "../problem.js";

type Props = { info: SidecarInfo; vaultId?: string; onBack: () => void; onReady: (vaultId: string) => void };

/**
 * The first vault: a name, already filled in. Coming back shows the vault the guide made; opened with vaults
 * already there (from Settings), it offers them before a new one (review I4). A vault whose processing could not
 * be set up says so here, not after the first source sat in a queue nobody reads (review I1).
 */
export function VaultStep({ info, vaultId, onBack, onReady }: Props) {
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [name, setName] = useState("My vault");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notReady, setNotReady] = useState<{ id: string; reason: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchVaults(info)
      .then((list) => alive && setVaults(list))
      .catch(() => alive && setVaults([]));
    return () => {
      alive = false;
    };
  }, [info]);

  const use = (id: string) => {
    rememberGuide({ vault: id, step: "sources" });
    onReady(id);
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const { vault, pipeline } = await createGuideVault(info, trimmed);
      if (pipeline.state === "ready") return use(vault.id);
      rememberGuide({ vault: vault.id, step: "sources" });
      setNotReady({ id: vault.id, reason: pipeline.state === "failed" ? `Processing could not be set up: ${pipeline.error}` : "Processing is not set up yet: the AI step did not finish." });
    } catch (err) {
      setError(`Could not create the vault: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const existing = vaultId && vaults ? (vaults.find((v) => v.id === vaultId) ?? null) : null;

  return (
    <section aria-labelledby="onb-title">
      <h2 id="onb-title" className="kv-onb-title" tabIndex={-1}>Create your first vault</h2>
      <p className="kv-onb-lead">A vault holds your sources and the notes written from them. Many people keep one per subject or project; you can add more later.</p>
      {vaults === null && <p role="status" className="kv-quiet">Loading…</p>}
      {notReady && (
        <>
          <p role="alert" className="kv-error">{plainError(notReady.reason)}</p>
          <div className="kv-onb-actions">
            <button type="button" className="kv-button" onClick={() => use(notReady.id)}>Continue anyway</button>
            <button type="button" className="kv-button kv-button-primary" onClick={onBack}>Back to choosing the AI</button>
          </div>
        </>
      )}
      {!notReady && existing && (
        <>
          <p className="kv-onb-ok">Your vault <strong>{existing.name}</strong> is ready.</p>
          <div className="kv-onb-actions">
            <button type="button" className="kv-button" onClick={onBack}>Back</button>
            <button type="button" className="kv-button kv-button-primary" onClick={() => use(existing.id)}>Continue</button>
          </div>
        </>
      )}
      {!notReady && !existing && vaults !== null && (
        <>
          {vaults.length > 0 && (
            <div className="kv-onb-existing">
              <p className="kv-onb-label">Use one of your vaults</p>
              <ul>
                {vaults.map((v) => (
                  <li key={v.id}>
                    <button type="button" className="kv-onb-card kv-onb-card-row" onClick={() => use(v.id)}>
                      <strong>{v.name}</strong>
                      <span>{v.noteCount} note{v.noteCount === 1 ? "" : "s"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form onSubmit={(e) => void create(e)}>
            <label htmlFor="onb-vault-name" className="kv-onb-label">{vaults.length > 0 ? "Or create a new vault" : "Name"}</label>
            <input id="onb-vault-name" className="kv-onb-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={busy} autoFocus={vaults.length === 0} />
            {!name.trim() && <p className="kv-hint">A vault needs a name, for example the subject it is about.</p>}
            {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
            <div className="kv-onb-actions">
              <button type="button" className="kv-button" onClick={onBack} disabled={busy}>Back</button>
              <button type="submit" className="kv-button kv-button-primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create vault"}</button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
