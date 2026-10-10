import { useState } from "react";
import { shortAddress, type IdentityController } from "../state/use-identity.js";
import { plainError } from "../problem.js";

/**
 * Sign in with Renown: the engine opens the system browser, the user signs with
 * their wallet, the engine keeps the credential. Nothing here holds a key.
 */
export function IdentitySection({ identity }: { identity: IdentityController }) {
  // One hook instance for the whole app (App owns it): the landing's chip and the
  // host declaration see the sign-in the moment this section completes it.
  const { status, error, signIn, cancel, signOut } = identity;
  const [copied, setCopied] = useState(false);
  if (!status) return <p className="kv-quiet" role="status">{error ? `Could not read the sign-in state: ${error}` : "…"}</p>;

  if (status.expired) {
    return (
      <div className="kv-settings-body">
        <p className="kv-settings-lead">Your sign-in expired. A Renown credential lasts seven days; signing in again renews it — protected vaults and connected servers need it.</p>
        <div className="kv-identity-card">
          {status.address && (
            <p className="kv-hint">
              Was signed in as <span className="kv-mono">{status.address}</span>.
            </p>
          )}
          <button type="button" className="kv-button kv-button-primary" onClick={() => void signIn()}>Sign in again</button>
          {(status.lastError || error) && <p role="alert" className="kv-error">{status.lastError ?? error}</p>}
        </div>
      </div>
    );
  }

  if (status.authenticated && status.address) {
    const since = status.authenticatedAt ? new Date(status.authenticatedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : undefined;
    return (
      <div className="kv-settings-body">
        <p className="kv-settings-lead">Your sign-in is kept by the engine on this computer and used for vaults on servers you connect. Local vaults stay open without it.</p>
        <div className="kv-identity-card">
          <div className="kv-identity-row">
            <span className="kv-identity-dot" aria-hidden="true" />
            <span className="kv-identity-label">Signed in as</span>
            <button
              type="button"
              className="kv-mono kv-identity-address"
              title="Copy the address"
              onClick={() => {
                void navigator.clipboard.writeText(status.address!).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : status.address}
            </button>
          </div>
          <dl className="kv-facts">
            {status.did && (<><dt>Identity</dt><dd className="kv-mono">{status.did}</dd></>)}
            {since && (<><dt>Since</dt><dd>{since}</dd></>)}
            <dt>This app's key</dt><dd className="kv-mono">{status.appDid}</dd>
          </dl>
          <div className="kv-form-actions">
            <button type="button" className="kv-button" onClick={() => void signOut()}>Sign out</button>
          </div>
        </div>
        {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
      </div>
    );
  }

  if (status.pending) {
    return (
      <div className="kv-settings-body">
        <p className="kv-settings-lead">Finish signing in in your browser: connect your wallet and approve this app.</p>
        <div className="kv-identity-card">
          <p role="status" className="kv-identity-waiting">Waiting for the browser…</p>
          {status.pending.url && (
            <p className="kv-hint">
              If it did not open, <a href={status.pending.url} target="_blank" rel="noreferrer">open the sign-in page</a>.
            </p>
          )}
          <div className="kv-form-actions">
            <button type="button" className="kv-button" onClick={() => void cancel()}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="kv-settings-body">
      <p className="kv-settings-lead">Signing in uses your Renown identity — no password. It lets you protect your local vaults and connect vaults on servers you have access to. Nothing is shared beyond your wallet address.</p>
      <div className="kv-identity-card">
        <button type="button" className="kv-button kv-button-primary" onClick={() => void signIn()}>Sign in with Renown</button>
        <p className="kv-hint">Your browser opens; the app stays here and picks the sign-in up when you are done.</p>
        {(status.lastError || error) && <p role="alert" className="kv-error">{status.lastError ?? error}</p>}
      </div>
    </div>
  );
}

export { shortAddress };
