import { useCallback, useEffect, useRef, useState } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { invokeIfTauri, isTauri } from "../shell/tauri.js";
import { checkForUpdate, type UpdateInfo } from "../update-check.js";
import { startUpdateDownload, updateDownloadStatus, type InstallerKind, type UpdateDownload } from "../update-download.js";
import { UPDATE_FEED } from "../update-feed.js";
import { ControlError, fetchStatus } from "../vaults.js";
import "./update-notice.css";

/**
 * A newer release on GitHub: a card drops from the top centre, says so for three seconds, and folds
 * into a pill that stays. Update downloads the installer for this computer into the Downloads
 * folder (the engine fetches it, app-update.ts), showing the progress; then the app opens the
 * installer and quits so it can be replaced (the shell's install_update, update.rs) — after a short
 * countdown that can be stopped. Where that cannot happen, a card says how to install it by hand.
 */

const SHOW_MS = 3000;
const POLL_MS = 500;
const INSTALL_IN_S = 3;

type Phase = "hidden" | "card" | "pill" | "downloading" | "installing" | "done" | "ready" | "failed";

/** The version of the app that is running — what an update replaces. In development there is none, so every release is newer. */
async function runningVersion(info: SidecarInfo): Promise<string> {
  if (import.meta.env.DEV) return "0.0.0-dev";
  if (isTauri()) {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    } catch {
      // fall back to the engine's word
    }
  }
  return (await fetchStatus(info)).appVersion;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_048_576)} MB`;
}

/** What happens once the installer opens, in a line. */
function onceOpen(kind: InstallerKind): string {
  switch (kind) {
    case "dmg":
      return "In the window that opens, drag Knowledge Vault onto Applications.";
    case "setup":
      return "Follow the installer's steps.";
    case "deb":
      return "Your software installer opens the package.";
    case "appimage":
      return "The new version starts by itself.";
  }
}

/** Where Quit is, and what opening the installer means, for the file that was downloaded. */
function howToInstall(kind: InstallerKind, name: string): { quit: string; open: string } {
  switch (kind) {
    case "dmg":
      return { quit: "Click the Knowledge Vault icon in the menu bar, at the top right of the screen, and choose Quit.", open: `Open ${name} in your Downloads folder and drag Knowledge Vault onto Applications, replacing the old one.` };
    case "setup":
      return { quit: "Click the Knowledge Vault icon in the system tray, at the bottom right of the taskbar (behind ^ if it is hidden), and choose Quit.", open: `Run ${name} from your Downloads folder.` };
    case "deb":
      return { quit: "Click the Knowledge Vault icon in the system tray and choose Quit.", open: `Open ${name} from your Downloads folder to install it, or run sudo apt install ./${name} there.` };
    case "appimage":
      return { quit: "Click the Knowledge Vault icon in the system tray and choose Quit.", open: `Start ${name} from your Downloads folder (allow it to run as a program first: chmod +x). The old AppImage can then be deleted.` };
  }
}

export type UpdateNoticeProps = {
  info: SidecarInfo;
  feed?: string;
  /** For tests: the version that is running, and the engine's download routes. */
  version?: () => Promise<string>;
  download?: { status: () => Promise<UpdateDownload>; start: (release: { version: string; assets: UpdateInfo["assets"] }) => Promise<UpdateDownload> };
};

export function UpdateNotice({ info, feed = UPDATE_FEED, version, download }: UpdateNoticeProps) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("hidden");
  const [state, setState] = useState<UpdateDownload>({ state: "idle" });
  const [held, setHeld] = useState(false); // pointer or focus on the card: it stays open
  const [left, setLeft] = useState(INSTALL_IN_S); // seconds before the installer opens
  const [installError, setInstallError] = useState<string | null>(null);
  const api = useRef(download ?? { status: () => updateDownloadStatus(info), start: (r: { version: string; assets: UpdateInfo["assets"] }) => startUpdateDownload(info, r) });

  // Is there a newer release? (at most one question to GitHub a day: update-check.ts)
  useEffect(() => {
    let alive = true;
    void (async () => {
      const current = await (version ?? (() => runningVersion(info)))().catch(() => null);
      if (!current || !alive) return;
      const found = await checkForUpdate(feed, current, fetch, window.localStorage);
      if (!found || !alive) return;
      setUpdate(found);
      // A download the engine already holds for it (the window was reloaded): carry on from there.
      const now = await api.current.status().catch((): UpdateDownload => ({ state: "idle" }));
      if (!alive) return;
      const same = now.state !== "idle" && now.version === found.latest;
      setState(same ? now : { state: "idle" });
      setPhase(same && now.state === "downloading" ? "downloading" : same && now.state === "done" ? "ready" : "card");
    })();
    return () => {
      alive = false;
    };
  }, [info, feed, version]);

  // The first card folds into the pill after three seconds on screen: counted from when it has landed
  // (at start-up the window may be busy and paint it late), only while the window is visible, and
  // not while the pointer or focus is on it.
  const [landed, setLanded] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    if (phase !== "card") return setLanded(false);
    // Reduced motion: no drop animation to wait for — landed once painted.
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setLanded(true)));
      return () => cancelAnimationFrame(frame);
    }
  }, [phase]);
  useEffect(() => {
    if (phase !== "card" || !landed || held || !visible) return;
    const timer = setTimeout(() => setPhase("pill"), SHOW_MS);
    return () => clearTimeout(timer);
  }, [phase, landed, held, visible]);

  // While downloading: the engine's progress, until it is done or failed.
  useEffect(() => {
    if (phase !== "downloading") return;
    let alive = true;
    const timer = setInterval(() => {
      void api.current.status().then((s) => {
        if (!alive) return;
        setState(s);
        if (s.state === "done") setPhase(isTauri() ? "installing" : "done");
        else if (s.state === "failed") setPhase("failed");
      }).catch(() => undefined);
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase]);

  const start = useCallback(async () => {
    if (!update) return;
    setHeld(false);
    try {
      const s = await api.current.start({ version: update.latest, assets: update.assets });
      setState(s);
      setPhase(s.state === "done" ? (isTauri() ? "installing" : "done") : s.state === "failed" ? "failed" : "downloading");
    } catch (error) {
      // An engine older than the download route answers 404: the release page still has the installer.
      const old = error instanceof ControlError && error.status === 404;
      setState({ state: "failed", version: update.latest, error: old ? "This engine cannot download updates yet. Restart the app, or get the installer from the release page." : error instanceof Error ? error.message : String(error) });
      setPhase("failed");
    }
  }, [update]);

  // Downloaded: the installer opens and the app quits, after a countdown that Later stops.
  const install = useCallback(async () => {
    if (state.state !== "done") return;
    try {
      await invokeIfTauri("install_update", { path: state.path });
      // The app is quitting; nothing more to show.
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error));
      setPhase("done");
    }
  }, [state]);
  useEffect(() => {
    if (phase !== "installing") return;
    setLeft(INSTALL_IN_S);
    const timer = setInterval(() => setLeft((s) => s - 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    if (phase === "installing" && left <= 0) void install();
  }, [phase, left, install]);

  if (!update || phase === "hidden") return null;
  const hold = { onPointerEnter: () => setHeld(true), onPointerLeave: () => setHeld(false), onFocus: () => setHeld(true), onBlur: () => setHeld(false) };

  if (phase === "card") {
    return (
      <div className="kv-update" role="status" aria-live="polite">
        <div className="kv-update-card" data-enter="drop" onAnimationEnd={() => setLanded(true)} {...hold}>
          <p className="kv-update-title">Knowledge Vault {update.latest} is available</p>
          <p className="kv-update-text">Update downloads it, then the app closes and the installer opens. Your vaults stay where they are.</p>
          <div className="kv-update-actions">
            <button type="button" className="kv-button kv-button-primary" onClick={() => void start()}>Update now</button>
            <button type="button" className="kv-button" onClick={() => setPhase("pill")}>Later</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "installing" && state.state === "done") {
    return (
      <div className="kv-update" role="status" aria-live="polite">
        <div className="kv-update-card" data-enter="drop">
          <p className="kv-update-title">Installing Knowledge Vault {update.latest}</p>
          <p className="kv-update-text">
            The app closes and the installer opens {left > 0 ? `in ${left} s` : "now"}. {onceOpen(state.kind)}
          </p>
          <div className="kv-update-actions">
            <button type="button" className="kv-button kv-button-primary" onClick={() => void install()}>Install now</button>
            <button type="button" className="kv-button" onClick={() => setPhase("done")}>Later</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "done" && state.state === "done") {
    const how = howToInstall(state.kind, state.name);
    return (
      <div className="kv-update" role="status" aria-live="polite">
        <div className="kv-update-card kv-update-card-wide" data-enter="drop">
          <p className="kv-update-title">Version {update.latest} is downloaded</p>
          {installError && <p className="kv-update-text">The installer could not be opened from the app ({installError}). Install it like this:</p>}
          <ol className="kv-update-steps">
            <li><strong>Quit Knowledge Vault fully.</strong> Closing the window keeps it running. {how.quit}</li>
            <li><strong>Open the installer.</strong> {how.open}</li>
          </ol>
          <p className="kv-update-text">Your vaults stay where they are, and a backup is made before the new version opens them.</p>
          <div className="kv-update-actions">
            <button type="button" className="kv-button kv-button-primary" onClick={() => void invokeIfTauri("reveal_path", { path: state.path })}>Show in folder</button>
            <button type="button" className="kv-button" onClick={() => setPhase("ready")}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "failed") {
    return (
      <div className="kv-update" role="alert">
        <div className="kv-update-card" data-enter="drop" data-error="true">
          <p className="kv-update-title">The download did not finish</p>
          <p className="kv-update-text">{state.state === "failed" ? state.error : "Something went wrong."}</p>
          <div className="kv-update-actions">
            <button type="button" className="kv-button kv-button-primary" onClick={() => void start()}>Try again</button>
            <a className="kv-button" href={update.url} target="_blank" rel="noreferrer">Open the release page</a>
            <button type="button" className="kv-button" onClick={() => setPhase("pill")}>Later</button>
          </div>
        </div>
      </div>
    );
  }

  // The pill: an update waiting, its download under way, or the downloaded installer.
  const downloading = phase === "downloading";
  const progress = downloading && state.state === "downloading" && state.total ? Math.min(1, state.received / state.total) : null;
  const label = downloading
    ? progress === null
      ? "Downloading the update…"
      : `Downloading ${Math.round(progress * 100)}% · ${megabytes(state.state === "downloading" ? state.received : 0)}`
    : phase === "ready"
      ? `Update ${update.latest} downloaded · install`
      : `Update to ${update.latest}`;
  return (
    <div className="kv-update">
      <button
        type="button"
        className="kv-update-pill"
        data-enter="fold"
        data-busy={downloading || undefined}
        disabled={downloading}
        aria-live="polite"
        title={downloading ? undefined : phase === "ready" ? "Install the downloaded update" : `Download Knowledge Vault ${update.latest}; the app then closes and the installer opens`}
        onClick={() => (phase === "ready" ? setPhase(isTauri() ? "installing" : "done") : void start())}
      >
        <svg className="kv-update-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="M8 2v8m0 0-3-3m3 3 3-3M3 13h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{label}</span>
        {progress !== null && <span className="kv-update-bar" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />}
      </button>
    </div>
  );
}
