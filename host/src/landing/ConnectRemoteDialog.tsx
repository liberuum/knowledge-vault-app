import { useState, type FormEvent } from "react";
import type { RemoteDiscovery, RemoteVault } from "../api/remote.js";
import { Dialog } from "../shell/Dialog.js";
import { plainError } from "../problem.js";

export type ConnectRemoteApi = {
  discover: (url: string) => Promise<RemoteDiscovery>;
  add: (url: string, drive: string) => Promise<RemoteVault>;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const count = new Intl.NumberFormat();

/**
 * Connect vaults on a server. One field: the server's address, with or without /graphql, a link to one of its
 * vaults, even its Connect app's address. The engine asks the server, as the signed-in person, which vaults they
 * may read (the drives whose app is the Knowledge Vault); one or several are added from that list.
 */
export function ConnectRemoteDialog({ api, onAdded, onClose }: { api: ConnectRemoteApi; onAdded: (vaults: RemoteVault[]) => void; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<RemoteDiscovery | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"find" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function find(e: FormEvent) {
    e.preventDefault();
    setBusy("find");
    setError(null);
    try {
      const d = await api.discover(url.trim());
      const open = d.vaults.filter((v) => !v.added);
      const first = d.hint && open.some((v) => v.id === d.hint) ? d.hint : open.length === 1 ? open[0]!.id : undefined;
      setPicked(new Set(first ? [first] : []));
      setFound(d);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function add() {
    if (!found) return;
    setBusy("add");
    setError(null);
    const added: RemoteVault[] = [];
    try {
      for (const id of picked) added.push(await api.add(found.switchboardUrl, id));
      onAdded(added);
      onClose();
    } catch (err) {
      // Whatever was added before the failure stays added, and shows as such.
      if (added.length > 0) {
        onAdded(added);
        setFound((f) => (f ? { ...f, vaults: f.vaults.map((v) => (added.some((a) => a.id === v.id) ? { ...v, added: true } : v)) } : f));
        setPicked((prev) => new Set([...prev].filter((id) => !added.some((a) => a.id === id))));
      }
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const host = found ? new URL(found.switchboardUrl).host : "";
  const open = found?.vaults.filter((v) => !v.added) ?? [];
  return (
    <Dialog open title="Connect a remote vault" onClose={onClose}>
      {found === null ? (
        <form onSubmit={(e) => void find(e)} className="kv-dialog-form">
          <p>A vault on a server you have access to. The app talks to that server directly, signed in as you; nothing is copied to this computer.</p>
          <label htmlFor="remote-url">Vault server</label>
          <input id="remote-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://switchboard.example.com" autoFocus autoComplete="off" spellCheck={false} disabled={busy !== null} />
          <p className="kv-remote-hint">Its address is enough: with or without /graphql, or a link to one of its vaults.</p>
          {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
          <div className="kv-dialog-actions">
            <button type="button" className="kv-button" onClick={onClose} disabled={busy !== null}>Cancel</button>
            <button type="submit" className="kv-button kv-button-primary" disabled={busy !== null || !url.trim()}>{busy === "find" ? "Looking for vaults…" : "Find vaults"}</button>
          </div>
        </form>
      ) : (
        <div className="kv-dialog-form">
          {found.vaults.length === 0 ? (
            <p role="status">{host} has no vaults you can read. Ask its administrator for access, then try again.</p>
          ) : (
            <>
              <p>{found.vaults.length === 1 ? "The vault" : "The vaults"} you can open on <strong>{host}</strong>:</p>
              <ul className="kv-remote-list" aria-label={`Vaults on ${host}`}>
                {found.vaults.map((v) => (
                  <li key={v.id}>
                    <label className="kv-remote-option" data-added={v.added ? "" : undefined}>
                      <input type="checkbox" checked={v.added || picked.has(v.id)} disabled={v.added || busy !== null} onChange={() => toggle(v.id)} />
                      <span className="kv-remote-option-text">
                        <span className="kv-remote-option-name">{v.name}</span>
                        <span className="kv-remote-option-meta">{v.added ? "Already in your vaults" : v.documents !== null ? `${count.format(v.documents)} items` : v.slug}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {open.length === 0 && <p role="status">All of them are already in your vaults.</p>}
            </>
          )}
          {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
          <div className="kv-dialog-actions">
            <button type="button" className="kv-button" onClick={() => { setFound(null); setError(null); }} disabled={busy !== null}>Back</button>
            <button type="button" className="kv-button kv-button-primary" onClick={() => void add()} disabled={busy !== null || picked.size === 0}>
              {busy === "add" ? "Adding…" : picked.size > 1 ? `Add ${picked.size} vaults` : "Add vault"}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
