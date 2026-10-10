import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SettingsApi } from "../screens/Settings.js";
import type { SidecarInfo } from "../sidecar.js";
import type { AppSettings, ConversionMode, ConverterComponent, ConverterStatus, InstallJob } from "../vaults.js";
import { plainError } from "../problem.js";

const STATE_LABEL: Record<ConverterStatus["state"], string> = {
  off: "Stopped",
  starting: "Starting",
  ready: "Ready",
  down: "Not responding",
};

/** The card's headline: the helper's state on this computer, the server's answer elsewhere, or Off. */
export function headline(status: ConverterStatus): string {
  if (status.mode === "off") return "Off";
  if (status.mode === "remote") return status.health?.ok === true ? "Another server · Ready" : "Another server · Not responding";
  return STATE_LABEL[status.state];
}

/** The dot beside the headline follows the same reading. */
export function dotState(status: ConverterStatus): "off" | "starting" | "ready" | "down" {
  if (status.mode === "off") return "off";
  if (status.mode === "remote") return status.health?.ok === true ? "ready" : "down";
  return status.state;
}

/** Format ids as the converter reports them, in words a person uses. */
const WORDS: Record<string, string> = {
  pdf: "PDF",
  md: "Markdown",
  markdown: "Markdown",
  txt: "plain text",
  text: "plain text",
  docx: "Word",
  doc: "Word",
  pptx: "slides",
  xlsx: "spreadsheets",
  csv: "CSV",
  html: "web pages",
  epub: "EPUB",
  image: "images",
  asciidoc: "AsciiDoc",
};

/** One sentence derived from the converter's own health — never a hard-coded list. */
export function describeHealth(status: ConverterStatus): string {
  if (status.mode === "off") return "Documents are not converted. Text can still be pasted.";
  if (!status.health) {
    if (status.state === "starting") return "Starting the converter…";
    return status.mode === "remote" ? "The server did not answer." : "The converter did not answer.";
  }
  const formats = Array.isArray(status.health.formats) ? (status.health.formats as string[]) : [];
  const words = [...new Set(formats.map((f) => WORDS[f] ?? f.toUpperCase()))];
  const list = words.length === 0 ? "nothing yet" : words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  const binding = status.health.binding !== false;
  const ready = status.health.ready === true;
  const more = !binding
    ? " Word, slides, spreadsheets and scanned PDFs need the converter's binding, which is not installed."
    : !ready
      ? " Scanned PDFs and images need the PDF models, which are not installed."
      : " Scanned PDFs are read with OCR.";
  return `Reads ${list} files.${more}`;
}

/** Settings › Conversion: where documents convert, what converts today, and the helper's state. */
export function ConversionSection({ info, api }: { info: SidecarInfo; api: SettingsApi }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [status, setStatus] = useState<ConverterStatus | null>(null);
  const [mode, setMode] = useState<ConversionMode>("local");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      api
        .fetchConverter(info)
        .then(setStatus)
        .catch((e: Error) => setError(e.message)),
    [api, info],
  );

  useEffect(() => {
    let alive = true;
    api
      .fetchSettings(info)
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setMode(s.conversion.mode);
        setRemoteUrl(s.conversion.remoteUrl);
      })
      .catch((e: Error) => alive && setError(e.message));
    void refresh();
    return () => {
      alive = false;
    };
  }, [api, info, refresh]);

  // While the helper starts or an install runs, ask again shortly.
  const jobActive = status?.job !== null && status?.job !== undefined && status.job.phase !== "done" && status.job.phase !== "failed";
  useEffect(() => {
    if (status?.state !== "starting" && !jobActive) return;
    const timer = setTimeout(() => void refresh(), 1500);
    return () => clearTimeout(timer);
  }, [status, jobActive, refresh]);

  async function install(component: ConverterComponent) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.installConverter(info, component));
    } catch (err) {
      setError(`Could not start the install: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  async function remove(component: ConverterComponent) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.removeConverter(info, component));
    } catch (err) {
      setError(`Could not remove it: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.saveSettings(info, { conversion: { mode, remoteUrl } });
      setSettings(next);
      setSaved(true);
      await refresh();
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  async function restart() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.restartConverter(info));
    } catch (err) {
      setError(`Could not restart the converter: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const canRestart = settings?.conversion.mode === "local" && (status?.state === "ready" || status?.state === "down");
  return (
    <div className="kv-settings-body">
      <p className="kv-settings-lead">
        Files you add — PDF, Word, slides, spreadsheets, Markdown — are turned into text on this computer before they become sources. Nothing leaves this
        computer unless you choose another server.
      </p>
      {status === null && !error && <p className="kv-quiet" role="status">Loading…</p>}
      {status && (
        <div className="kv-converter" data-state={dotState(status)}>
          <div className="kv-converter-head">
            <span className="kv-dot" aria-hidden="true" />
            <strong>{headline(status)}</strong>
            {status.mode === "remote" && status.url && <span className="kv-quiet">{status.url}</span>}
          </div>
          <p className="kv-converter-reads">{describeHealth(status)}</p>
          {status.error && <p role="alert" className="kv-error">{plainError(status.error)}</p>}
          {status.state === "down" && (
            <p className="kv-hint">
              Log: <code>{status.logPath}</code>
            </p>
          )}
          {canRestart && (
            <div>
              <button type="button" className="kv-button" onClick={() => void restart()} disabled={busy}>
                Restart
              </button>
            </div>
          )}
        </div>
      )}
      {status && settings?.conversion.mode === "local" && (
        <>
          <h3 className="kv-settings-subheading">Components</h3>
          <ul className="kv-components">
            <ComponentRow
              name="Converter binding"
              what="Word, slides, spreadsheets, web pages and more · 23 MB download, 68 MB installed"
              installed={status.installed.binding.installed}
              installedNote={status.installed.binding.version ? `Installed · version ${status.installed.binding.version}` : "Installed"}
              unavailable={status.installed.binding.supported ? null : (status.installed.binding.reason ?? "Not available on this computer.")}
              job={status.job?.component === "binding" ? status.job : null}
              busy={busy || jobActive}
              onInstall={() => void install("binding")}
              onRemove={() => void remove("binding")}
              installLabel="Install binding"
              removeLabel="Remove binding"
            />
            <ComponentRow
              name="PDF models"
              what="Scanned PDFs, images, tables and OCR · about 720 MB"
              installed={status.installed.models.installed}
              installedNote="Installed"
              unavailable={!status.installed.models.supported ? (status.installed.models.reason ?? "Not available on this computer.") : status.installed.binding.installed ? null : "Needs the converter binding first."}
              job={status.job?.component === "models" ? status.job : null}
              busy={busy || jobActive}
              onInstall={() => void install("models")}
              onRemove={() => void remove("models")}
              installLabel="Install models"
              removeLabel="Remove models"
            />
          </ul>
        </>
      )}
      {settings && (
        <form className="kv-form" onSubmit={(e) => void submit(e)}>
          <fieldset className="kv-radios">
            <legend>Where documents convert</legend>
            <label>
              <input type="radio" name="conversion-mode" value="local" checked={mode === "local"} onChange={() => setMode("local")} disabled={busy} />
              On this computer — recommended
            </label>
            <label>
              <input type="radio" name="conversion-mode" value="remote" checked={mode === "remote"} onChange={() => setMode("remote")} disabled={busy} />
              Another server
            </label>
            <label>
              <input type="radio" name="conversion-mode" value="off" checked={mode === "off"} onChange={() => setMode("off")} disabled={busy} />
              Off
            </label>
          </fieldset>
          {mode === "remote" && (
            <>
              <label htmlFor="conversion-url">Server URL</label>
              <input id="conversion-url" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="http://10.0.0.5:5011" disabled={busy} />
              <p className="kv-hint">A conversion service reachable from this computer — for example your team's container. Documents you add are sent there.</p>
            </>
          )}
          <div className="kv-form-actions">
            <button type="submit" className="kv-button kv-button-primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            {saved && <span className="kv-form-saved" role="status">Saved</span>}
          </div>
          {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
        </form>
      )}
    </div>
  );
}

type RowProps = {
  name: string;
  what: string;
  installed: boolean;
  installedNote: string;
  /** Why it cannot be installed here (platform, or a prerequisite); null when it can. */
  unavailable: string | null;
  job: InstallJob | null;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
  installLabel: string;
  removeLabel: string;
};

/** One installable component: its state, the one action that fits it, and the install's progress while it runs. */
function ComponentRow({ name, what, installed, installedNote, unavailable, job, busy, onInstall, onRemove, installLabel, removeLabel }: RowProps) {
  const running = job !== null && job.phase !== "done" && job.phase !== "failed";
  return (
    <li className="kv-component" data-installed={installed} data-running={running}>
      <div className="kv-component-main">
        <strong>{name}</strong>
        <span className="kv-quiet">{what}</span>
        {running && (
          <div className="kv-component-progress" role="status">
            <progress value={job.percent ?? undefined} max={100} aria-label={`${name} install progress`} />
            <span>{job.message}</span>
          </div>
        )}
        {job?.phase === "failed" && <p role="alert" className="kv-error">{plainError(job.error)}</p>}
        {!running && installed && <span className="kv-quiet">{installedNote}</span>}
        {!running && !installed && unavailable && <span className="kv-quiet">{unavailable}</span>}
      </div>
      <div className="kv-component-actions">
        {!running && installed && (
          <button type="button" className="kv-button kv-button-danger-quiet" onClick={onRemove} disabled={busy}>
            {removeLabel}
          </button>
        )}
        {!running && !installed && unavailable === null && (
          <button type="button" className="kv-button kv-button-primary" onClick={onInstall} disabled={busy}>
            {installLabel}
          </button>
        )}
      </div>
    </li>
  );
}
