import { useEffect, useRef, useState } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { filesFromDrop } from "../api/dropped-files.js";
import { fetchConverter, fetchVaults } from "../vaults.js";
import { addSample, addText } from "./api.js";
import { handFiles } from "./pending-files.js";
import { describeDrop, dropAddresses } from "./drop-addresses.js";
import { rememberGuide } from "./progress.js";
import { ensureAutoPublish, vaultIntake } from "./vault-intake.js";

type Props = { info: SidecarInfo; vaultId?: string; onBack: () => void; onStarted: (vaultId: string) => void };

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What goes in first: files (converted by the vault's own intake, shown on the next screen), pasted text, or the
 * app's guide. With nothing at hand the one action is "Start with the guide": results without a file of your own.
 */
export function SourcesStep({ info, vaultId, onBack, onStarted }: Props) {
  const [target, setTarget] = useState<string | null>(vaultId ?? null);
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [pasting, setPasting] = useState(false);
  const [guideToo, setGuideToo] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversionOff, setConversionOff] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // What already went in, so a retry after a partial failure adds only the rest (review I3).
  const added = useRef<{ guide: boolean; text: string }>({ guide: false, text: "" });

  // Reopened without the vault in the address: the guide's vault is the one there is.
  useEffect(() => {
    if (vaultId) return;
    let alive = true;
    fetchVaults(info)
      .then((list) => alive && setTarget(list[0]?.id ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [info, vaultId]);
  useEffect(() => {
    let alive = true;
    fetchConverter(info)
      .then((c) => alive && setConversionOff(c.mode === "off"))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [info]);

  const add = (more: FileList | readonly File[] | null | undefined) => {
    // Copied now: a picker's FileList is live and empties when the input is reset (right after this call), while
    // React may run the update below only at the next render — the picker then added nothing.
    const list = more ? Array.from(more) : [];
    if (conversionOff || list.length === 0) return;
    setFiles((current) => [...current, ...list]);
  };
  /** What a drop carried when it held no files — shown, so a drag the window cannot read is not silent. */
  const [dropNote, setDropNote] = useState<string | null>(null);

  // Files dropped anywhere on this screen are taken (Memory: a drop target the size of the page), and the zone
  // lights up while they are dragged. WebKit fires the drop only when dragenter and dragover are both cancelled.
  useEffect(() => {
    if (busy) return;
    // Every drag is accepted here: some file managers describe a file drag only as "text/uri-list" until the drop,
    // so the type list is not a reliable test (the drop itself says what it carries).
    const onOver = (e: globalThis.DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = conversionOff ? "none" : "copy";
      setOver(true);
    };
    const onLeave = (e: globalThis.DragEvent) => {
      if (e.relatedTarget === null) setOver(false); // left the window
    };
    const onDrop = (e: globalThis.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const dt = e.dataTransfer;
      const listed = Array.from(dt?.files ?? []);
      const fromItems = listed.length
        ? []
        : Array.from(dt?.items ?? [])
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((f): f is File => f !== null);
      const got = listed.length ? listed : fromItems;
      if (got.length) {
        setDropNote(null);
        add(got);
        return;
      }
      // No files: WebKitGTK (Linux) shows a page only the first file's address. The window keeps the drop's whole
      // list, and the engine reads each file for us; the addresses the page saw are the fallback.
      if (!dt) return;
      setDropNote("Reading the dropped files…");
      void dropAddresses(dt).then(async ({ addresses, seen }) => {
        const { files: read, failed } = await filesFromDrop(info, addresses.join("\n"));
        add(read);
        if (failed.length) setDropNote(`Some files could not be read: ${failed.join("; ")}`);
        else if (read.length === 0) setDropNote(`That drop carried no file this window can read (${describeDrop(seen)}). Use Choose files… instead.`);
        else setDropNote(null);
      });
    };
    window.addEventListener("dragenter", onOver);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onOver);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [busy, conversionOff, info]);

  const own = files.length + (text.trim() ? 1 : 0);
  const withGuide = own === 0 || guideToo;
  const count = own + (withGuide ? 1 : 0);
  const label = busy ? "Adding…" : own === 0 ? "Start with the guide" : `Add ${count} source${count === 1 ? "" : "s"}`;

  async function start() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      if (withGuide && !added.current.guide) {
        await addSample(info, target);
        added.current.guide = true;
      }
      const pasted = text.trim();
      if (pasted && added.current.text !== pasted) {
        await addText(info, target, pasted);
        added.current.text = pasted;
      }
      if (files.length) {
        const intake = vaultIntake(target);
        if (intake) {
          intake.add(files);
          ensureAutoPublish(target, intake);
        } else {
          handFiles(target, files); // an older vault package takes them when the vault opens
        }
        setFiles([]);
      }
      rememberGuide({ vault: target, step: "notes" });
      onStarted(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="onb-title">
      <h2 id="onb-title" className="kv-onb-title" tabIndex={-1}>Add your first sources</h2>
      <p className="kv-onb-lead">Each source is read and turned into notes on its own. That takes a few minutes per source, and you can keep working meanwhile.</p>
      <div className="kv-onb-drop" data-over={over} data-off={conversionOff}>
        {conversionOff ? (
          <>
            <p className="kv-onb-drop-title">Reading files is turned off</p>
            <p className="kv-hint">Turn it on in Settings › Conversion, or paste text below.</p>
          </>
        ) : (
          <>
            <p className="kv-onb-drop-title">{over ? "Release to add them" : "Drop files here"}</p>
            <p className="kv-hint">PDF, Word, PowerPoint, Excel, web pages, Markdown or plain text. Long documents become several sources, one per part.</p>
            <button type="button" className="kv-button" onClick={() => picker.current?.click()} disabled={busy}>Choose files…</button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>
      {files.length > 0 && (
        <ul className="kv-onb-files" aria-label="Files to add">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span className="kv-onb-file-name">{f.name}</span>
              <span className="kv-hint">{size(f.size)}</span>
              <button type="button" className="kv-link" onClick={() => setFiles((current) => current.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} disabled={busy}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {pasting ? (
        <>
          <label htmlFor="onb-paste" className="kv-onb-label">Paste text</label>
          <textarea id="onb-paste" className="kv-onb-input kv-onb-textarea" value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder="Notes, an article, a transcript…" disabled={busy} autoFocus />
        </>
      ) : (
        <button type="button" className="kv-link kv-onb-paste" onClick={() => setPasting(true)} disabled={busy}>Or paste some text</button>
      )}
      <div className="kv-onb-guide">
        {own === 0 ? (
          <p>
            <strong>Nothing at hand?</strong> Start with the app's own guide, <em>How Knowledge Vault works</em>: its notes explain notes, links and the maps of your topics.
          </p>
        ) : (
          <label className="kv-onb-check">
            <input type="checkbox" checked={guideToo} onChange={(e) => setGuideToo(e.target.checked)} disabled={busy} />
            <span>Also add the app's guide, <em>How Knowledge Vault works</em></span>
          </label>
        )}
      </div>
      {dropNote && <p role="status" className={dropNote.startsWith("Reading") ? "kv-quiet" : "kv-error"}>{dropNote}</p>}
      {!target && <p className="kv-error">Create a vault first: go back one step.</p>}
      {error && <p role="alert" className="kv-error">{error}</p>}
      <div className="kv-onb-actions">
        <button type="button" className="kv-button" onClick={onBack} disabled={busy}>Back</button>
        <button type="button" className="kv-button kv-button-primary" onClick={() => void start()} disabled={busy || !target}>{label}</button>
      </div>
    </section>
  );
}
