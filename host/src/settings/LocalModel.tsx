import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscoveredModel, DiscoveredServer, LocalDiscovery, LocalProbe } from "../vaults.js";

export const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8080/v1";
/** The last address tried, so a failed connect does not send the user back to the default. */
export const LAST_URL_KEY = "kv-local-model-url";
type UrlStore = Pick<Storage, "getItem" | "setItem">;

type Props = {
  /** Whether the saved model is on this computer, and which. */
  current: { local: boolean; endpoint: string; model: string };
  probe: (endpoint: string) => Promise<LocalProbe>;
  /** Save this endpoint and model as the vault's model (no key). */
  use: (endpoint: string, model: string) => Promise<void>;
  disabled?: boolean;
  /** Where the last address tried is kept (tests inject one). */
  storage?: UrlStore;
  /** Find the model servers running on this computer (the engine scans); absent, only an address can be entered. */
  discover?: () => Promise<LocalDiscovery>;
};

/** One line about a found model, in words: where it runs, whether it is ready, how much it reads at once. */
export function describeFound(server: DiscoveredServer, model: DiscoveredModel): string {
  const parts = [`${server.provider} on port ${server.port}`];
  if (model.loaded === true) parts.push("loaded");
  if (model.loaded === false) parts.push("not loaded yet, so the first answer takes longer");
  if (model.contextLength) parts.push(`reads ${model.contextLength.toLocaleString("en")} tokens at once`);
  const sentence = `${parts.join(", ")}.`;
  return model.contextLength && model.contextLength < 16_384 ? `${sentence} That is short for whole sources: long ones will be cut.` : sentence;
}

/**
 * Settings › Models: run the pipeline on a model on this computer — llama.cpp, Ollama, LM Studio, any
 * OpenAI-compatible server. Connect to its address, see what it serves, use it; no key needed.
 */
export function LocalModel({ current, probe, use, disabled, storage, discover }: Props) {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const lastTried = (): string | null => {
    try {
      return store?.getItem(LAST_URL_KEY) || null;
    } catch {
      return null;
    }
  };
  const [open, setOpen] = useState(false);
  // The saved local endpoint when one is in use; otherwise what the user last typed; the default only the first time.
  const [url, setUrl] = useState(() => (current.local ? current.endpoint : (lastTried() ?? DEFAULT_LOCAL_ENDPOINT)));
  const [result, setResult] = useState<LocalProbe | null>(null);
  const [checking, setChecking] = useState(false);
  const [chosen, setChosen] = useState("");
  const [saving, setSaving] = useState(false);
  const [found, setFound] = useState<LocalDiscovery | null>(null);
  const [scanning, setScanning] = useState(false);

  const scan = useCallback(async () => {
    if (!discover) return;
    setScanning(true);
    try {
      setFound(await discover());
    } catch {
      setFound(null); // the address field below still works
    } finally {
      setScanning(false);
    }
  }, [discover]);
  // Opening the panel looks for running servers straight away: nothing to type when one is found.
  // Keyed on opening only — a parent may pass a new `discover` on every render.
  const scanRef = useRef(scan);
  scanRef.current = scan;
  useEffect(() => {
    if (open) void scanRef.current();
  }, [open]);

  const choose = (endpoint: string, model: string) => {
    setSaving(true);
    void use(endpoint, model).then(
      () => {
        setOpen(false);
        setSaving(false);
      },
      () => setSaving(false),
    );
  };

  const connect = async (address: string) => {
    try {
      if (address.trim()) store?.setItem(LAST_URL_KEY, address.trim());
    } catch {
      // storage full or blocked: the address simply is not remembered
    }
    setChecking(true);
    setResult(null);
    try {
      const r = await probe(address);
      setResult(r);
      if (r.ok) setChosen(r.models.includes(current.model) ? current.model : (r.models[0] ?? ""));
    } catch (e) {
      setResult({ ok: false, endpoint: address, detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  };

  const status = result && (
    <p role="status" className={result.ok ? "kv-form-saved" : "kv-error"}>
      {result.ok
        ? `Connected to ${result.endpoint} — serving ${result.models.join(", ")}`
        : `Could not connect: ${result.detail}`}
    </p>
  );

  if (current.local && !open) {
    const stillServed = result?.ok ? result.models.includes(current.model) : null;
    return (
      <section className="kv-local-model" aria-label="Local model">
        <p className="kv-local-model-title">
          Using a model on this computer: <strong>{current.model || "none chosen"}</strong> at <code>{current.endpoint}</code>
        </p>
        <div className="kv-form-actions">
          <button type="button" className="kv-button" disabled={disabled || checking} onClick={() => void connect(current.endpoint)}>
            {checking ? "Checking…" : "Check connection"}
          </button>
          <button type="button" className="kv-button" disabled={disabled} onClick={() => { setOpen(true); setResult(null); }}>Change</button>
        </div>
        {status}
        {stillServed === false && <p className="kv-error">The server no longer serves {current.model}. Choose one it serves with Change.</p>}
      </section>
    );
  }

  if (!open) {
    return (
      <div className="kv-local-model-start">
        <button type="button" className="kv-button" disabled={disabled} onClick={() => setOpen(true)}>Use a local model…</button>
        <span className="kv-hint">A model running on this computer (llama.cpp, Ollama, LM Studio): no key, nothing leaves the machine.</span>
      </div>
    );
  }

  return (
    <section className="kv-local-model" aria-label="Local model">
      {discover && (
        <div className="kv-local-found" aria-live="polite" aria-busy={scanning}>
          {scanning && <p className="kv-quiet" role="status">Looking for AI models on this computer…</p>}
          {!scanning && found && found.servers.length > 0 && (
            <>
              <p className="kv-local-found-title">Found on this computer</p>
              <ul className="kv-local-found-list">
                {found.servers.flatMap((server) =>
                  server.models.map((model) => (
                    <li key={`${server.endpoint} ${model.id}`} className="kv-local-found-item">
                      <div className="kv-local-found-text">
                        <strong>{model.id}</strong>
                        <span className="kv-hint">{describeFound(server, model)}</span>
                      </div>
                      <button
                        type="button"
                        className="kv-button kv-button-primary"
                        disabled={disabled || saving}
                        aria-label={`Use ${model.id}`}
                        onClick={() => choose(server.endpoint, model.id)}
                      >
                        {current.local && current.endpoint === server.endpoint && current.model === model.id ? "In use" : "Use"}
                      </button>
                    </li>
                  )),
                )}
              </ul>
            </>
          )}
          {!scanning && found && found.servers.length === 0 && (
            <p className="kv-hint">
              No AI model is running on this computer. <a href="https://ollama.com" target="_blank" rel="noreferrer">Ollama</a> and{" "}
              <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">LM Studio</a> are free ways to run one; start it, then scan again.
            </p>
          )}
          {!scanning && found && <p className="kv-hint">{found.hint}</p>}
          {!scanning && (
            <div className="kv-form-actions">
              <button type="button" className="kv-button" disabled={disabled || saving} onClick={() => void scan()}>
                Scan again
              </button>
            </div>
          )}
        </div>
      )}
      <label htmlFor="local-model-url">Local server address</label>
      <div className="kv-form-inline">
        <input id="local-model-url" value={url} onChange={(e) => { setUrl(e.target.value); setResult(null); }} placeholder={DEFAULT_LOCAL_ENDPOINT} disabled={disabled || checking} />
        <button type="button" className="kv-button" disabled={disabled || checking || !url.trim()} onClick={() => void connect(url)}>
          {checking ? "Connecting…" : "Connect"}
        </button>
      </div>
      <p className="kv-hint">Its OpenAI-compatible API, usually ending in <code>/v1</code>. It can be on this computer, your local network or a VPN such as Tailscale.</p>
      {status}
      {result?.ok && (
        <>
          {result.models.length > 1 && (
            <>
              <label htmlFor="local-model-choice">Model</label>
              <select id="local-model-choice" value={chosen} onChange={(e) => setChosen(e.target.value)} disabled={disabled || saving}>
                {result.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </>
          )}
          <div className="kv-form-actions">
            <button
              type="button"
              className="kv-button kv-button-primary"
              disabled={disabled || saving || !chosen}
              onClick={() => {
                setSaving(true);
                void use(result.endpoint, chosen).then(() => { setOpen(false); setSaving(false); }, () => setSaving(false));
              }}
            >
              {saving ? "Saving…" : `Use ${chosen}`}
            </button>
            <button type="button" className="kv-button" disabled={saving} onClick={() => { setOpen(false); setResult(null); }}>Cancel</button>
          </div>
        </>
      )}
      {!result?.ok && (
        <div className="kv-form-actions">
          <button type="button" className="kv-button" onClick={() => { setOpen(false); setResult(null); }}>Cancel</button>
        </div>
      )}
    </section>
  );
}
