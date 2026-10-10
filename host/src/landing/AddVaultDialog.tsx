import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { RemoteDiscovery, RemoteVault } from "../api/remote.js";
import { plainError } from "../problem.js";
import { Dialog } from "../shell/Dialog.js";
import { NameIdeas } from "./NameIdeas.js";
import { validateVaultName } from "./vault-name.js";
import "./add-vault.css";

export type AddMode = "create" | "connect";
export type ConnectRemoteApi = {
  discover: (url: string) => Promise<RemoteDiscovery>;
  add: (url: string, drive: string) => Promise<RemoteVault>;
};

const MODES: ReadonlyArray<{ mode: AddMode; title: string; line: string }> = [
  { mode: "create", title: "Create a new vault", line: "Kept on this computer" },
  { mode: "connect", title: "Connect one on a server", line: "Shared with you, or your own" },
];
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const count = new Intl.NumberFormat();

type Props = {
  /** Which choice is open first: Create from "Add vault" and Ctrl+N; Connect from "Already have a vault on a server?". */
  initial: AddMode;
  /** Creates the vault and opens it (the landing's create). */
  onCreate: (name: string) => void;
  creating: boolean;
  createError: string | null;
  connect: ConnectRemoteApi;
  onAdded: (vaults: RemoteVault[]) => void;
  /** Signed out, a server that asks who you are refuses: the Connect side says so before it is tried. */
  signedIn: boolean;
  onSignIn?: () => void;
  onClose: () => void;
};

/**
 * One way in for a vault (Six Minds, Memory — the vault pickers of note apps): first what kind — a new one on this
 * computer, or one on a server — then only the fields that choice needs. Create is first and focused, so making a
 * vault stays a name and Enter.
 */
export function AddVaultDialog({ initial, onCreate, creating, createError, connect, onAdded, signedIn, onSignIn, onClose }: Props) {
  const [mode, setMode] = useState<AddMode>(initial);
  const tabs = useRef<Record<AddMode, HTMLButtonElement | null>>({ create: null, connect: null });
  // Arrow keys move between the two choices, as in any tab list.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next: AddMode = e.key === "Home" ? "create" : e.key === "End" ? "connect" : mode === "create" ? "connect" : "create";
    setMode(next);
    tabs.current[next]?.focus();
  }
  return (
    <Dialog open title="Add a vault" onClose={onClose}>
      <div className="kv-add">
        <div className="kv-add-choices" role="tablist" aria-label="How to add a vault" onKeyDown={onKeyDown}>
          {MODES.map((m) => (
            <button
              key={m.mode}
              ref={(el) => {
                tabs.current[m.mode] = el;
              }}
              type="button"
              role="tab"
              id={`kv-add-tab-${m.mode}`}
              aria-selected={mode === m.mode}
              aria-controls="kv-add-panel"
              tabIndex={mode === m.mode ? 0 : -1}
              className="kv-add-choice"
              onClick={() => setMode(m.mode)}
            >
              <span className="kv-add-choice-icon" aria-hidden="true">{m.mode === "create" ? <PlusIcon /> : <ServerIcon />}</span>
              <span className="kv-add-choice-text">
                <strong>{m.title}</strong>
                <span>{m.line}</span>
              </span>
            </button>
          ))}
        </div>
        <div id="kv-add-panel" role="tabpanel" aria-labelledby={`kv-add-tab-${mode}`} className="kv-add-panel" key={mode}>
          {mode === "create" ? (
            <CreatePanel busy={creating} error={createError} onCreate={onCreate} onCancel={onClose} />
          ) : (
            <ConnectPanel api={connect} onAdded={onAdded} onClose={onClose} signedIn={signedIn} onSignIn={onSignIn} />
          )}
        </div>
      </div>
    </Dialog>
  );
}

function CreatePanel({ busy, error, onCreate, onCancel }: { busy: boolean; error: string | null; onCreate: (name: string) => void; onCancel: () => void }) {
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
    <form className="kv-dialog-form" onSubmit={submit}>
      <label htmlFor="add-vault-name">Name</label>
      <input
        id="add-vault-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Research notes"
        autoFocus
        data-autofocus
        autoComplete="off"
        disabled={busy}
        aria-describedby={reason ? "add-vault-reason" : undefined}
        aria-invalid={reason ? true : undefined}
      />
      <NameIdeas value={name} onPick={setName} disabled={busy} />
      {reason && (
        <p id="add-vault-reason" className="kv-reason">
          {reason}
        </p>
      )}
      {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
      <Note>Your sources and notes stay on this computer. Next, you add the first sources.</Note>
      <div className="kv-dialog-actions">
        <button type="button" className="kv-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="kv-button kv-button-primary" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create vault"}
        </button>
      </div>
    </form>
  );
}

/** Connect vaults on a server: its address, then which of its vaults (the engine asks the server, as the person). */
function ConnectPanel({ api, onAdded, onClose, signedIn, onSignIn }: { api: ConnectRemoteApi; onAdded: (vaults: RemoteVault[]) => void; onClose: () => void; signedIn: boolean; onSignIn?: () => void }) {
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

  if (found === null) {
    return (
      <form onSubmit={(e) => void find(e)} className="kv-dialog-form">
        <label htmlFor="remote-url">Server address</label>
        <input id="remote-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://switchboard.example.com" autoFocus autoComplete="off" spellCheck={false} disabled={busy !== null} />
        <p className="kv-remote-hint">The address is enough — with or without /graphql, or a link to one of its vaults.</p>
        {!signedIn && (
          <p className="kv-add-signin">
            Some servers ask who you are.
            {onSignIn ? (
              <>
                {" "}
                <button type="button" className="kv-link" onClick={onSignIn}>
                  Sign in
                </button>{" "}
                first if yours does; open ones need nothing.
              </>
            ) : (
              " Open ones need nothing."
            )}
          </p>
        )}
        {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
        <Note>Nothing is copied to this computer: the app reads the server directly, signed in as you.</Note>
        <div className="kv-dialog-actions">
          <button type="button" className="kv-button" onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button type="submit" className="kv-button kv-button-primary" disabled={busy !== null || !url.trim()}>
            {busy === "find" ? "Looking for vaults…" : "Find vaults"}
          </button>
        </div>
      </form>
    );
  }

  const host = new URL(found.switchboardUrl).host;
  const open = found.vaults.filter((v) => !v.added);
  return (
    <div className="kv-dialog-form">
      {found.vaults.length === 0 ? (
        <p role="status">{host} has no vaults you can read. Ask its administrator for access, then try again.</p>
      ) : (
        <>
          <p>
            {found.vaults.length === 1 ? "The vault" : "The vaults"} you can open on <strong>{host}</strong>:
          </p>
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
        <button
          type="button"
          className="kv-button"
          onClick={() => {
            setFound(null);
            setError(null);
          }}
          disabled={busy !== null}
        >
          Back
        </button>
        <button type="button" className="kv-button kv-button-primary" onClick={() => void add()} disabled={busy !== null || picked.size === 0}>
          {busy === "add" ? "Connecting…" : picked.size > 1 ? `Connect ${picked.size} vaults` : "Connect vault"}
        </button>
      </div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="kv-add-note">
      <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      <span>{children}</span>
    </p>
  );
}
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function ServerIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
    </svg>
  );
}
