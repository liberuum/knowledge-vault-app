import { initTheme, useTheme, type GraphQLReactorClient } from "@powerhousedao/reactor-browser";
import { filesFromUriList } from "./api/dropped-files.js";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { declareDesktopHost, setDroppedFileReader, setExternalSignIn, setHostModel } from "./bootstrap.js";
import { externalSignIn } from "./api/oauth.js";
import { installExternalLinksForTauri } from "./links.js";
import { localHostExtras } from "./local-engine.js";
import { modelDeclaration, openModelSettings } from "./model-declaration.js";
import { fetchSettings, fetchStatus } from "./vaults.js";
import type { TokenProvider } from "./api/identity.js";
import { Landing } from "./screens/Landing.js";
import { watchSidecar, watchSidecarLog, type LogWatcher, type SidecarInfo, type SidecarStatus, type StatusWatcher } from "./sidecar.js";
import { advance, currentStageLabel, type Progress } from "./landing/startup-stages.js";
import { invokeIfTauri, isTauri } from "./shell/tauri.js";

import { goHomeIfAsked } from "./shell/go-home.js";

export type LoadedApp = {
  App: ComponentType<{ info: SidecarInfo; client: GraphQLReactorClient; bearer?: TokenProvider }>;
  client: GraphQLReactorClient;
  /** The user's bearer for a protected local engine; absent for an open one. */
  bearer?: TokenProvider;
};
export type AppLoader = (info: SidecarInfo) => Promise<LoadedApp>;

let loading: Promise<LoadedApp> | undefined;
/**
 * Declare the host, then load the vault package and install the reactor —
 * once per engine, however often React re-runs effects (StrictMode mounts twice).
 * Order matters: the package runs its boot on import and reads the host slot
 * at that moment, so nothing in this module imports it statically. A protected
 * engine (spec §4.4) is declared with the user's bearer. The first declaration
 * already says which model the chat runs on, so the chat never mounts its own
 * connect form in the desktop app.
 */
export const loadApp: AppLoader = (info) => {
  loading ??= (async () => {
    const [status, settings] = await Promise.all([fetchStatus(info).catch(() => undefined), fetchSettings(info).catch(() => undefined)]);
    const extras = localHostExtras(status?.protected === true, info);
    // The vault chat's OpenRouter sign-in returns through the engine, not to this window (api/oauth.ts).
    setExternalSignIn((buildUrl) => externalSignIn(info, buildUrl));
    // Files dragged from a Linux file manager arrive as addresses: the engine reads them for the vault's drop zones.
    setDroppedFileReader(async (uriList) => (await filesFromUriList(info, uriList)).files);
    // The app manages the chat's model. `null`: none is set up (or the engine did not say yet), and the chat shows its set-up panel; App re-reads and re-declares.
    setHostModel(settings ? modelDeclaration(info, settings.models) : null, openModelSettings);
    declareDesktopHost(info.origin, extras);
    const [{ App, LIBS }, { installReactor }] = await Promise.all([import("./App.js"), import("./reactor.js")]);
    return { App, client: installReactor(info, LIBS, extras.bearer), ...(extras.bearer ? { bearer: extras.bearer } : {}) };
  })();
  return loading;
};

/**
 * The stored theme (reactor-browser's `ph:theme`, dark by default — written by
 * index.html before first paint) mirrored onto <html> as `data-bai-theme`, so
 * the vault app's tokens resolve for the shell exactly as inside the app.
 */
function useThemeRoot(): void {
  initTheme();
  const { theme } = useTheme();
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.baiTheme = theme;
    root.style.colorScheme = theme;
  }, [theme]);
}

function EngineScreen({ title, detail, kind }: { title: string; detail: string; kind: "status" | "alert" }) {
  return (
    <main className="kv-engine" data-kind={kind} role={kind}>
      <h1 className="kv-engine-title">{title}</h1>
      <p className="kv-engine-detail">{detail}</p>
    </main>
  );
}

/** First thing on screen: the engine's state, then the vault app once the engine is ready. */
export function Boot({
  watch = watchSidecar,
  watchLog = watchSidecarLog,
  load = loadApp,
  onEngineRestarted = () => window.location.reload(),
}: {
  watch?: StatusWatcher;
  /** The engine's output lines while it starts (the landing's start-up stages). */
  watchLog?: LogWatcher;
  load?: AppLoader;
  /** The engine came back after a restart (the protection switch): the whole app is re-booted for the engine it now is — one path, shell and browser alike (spec §4.4). */
  onEngineRestarted?: () => void;
}) {
  useThemeRoot();
  useState(goHomeIfAsked); // once, before the first route is read
  useEffect(() => installExternalLinksForTauri(), []);
  // Tell the shell the page loaded and IPC works (its smoke check waits for this; harmless otherwise).
  useEffect(() => {
    invokeIfTauri("host_loaded").catch(() => {});
  }, []);
  const [status, setStatus] = useState<SidecarStatus>({ state: "starting" });
  const [app, setApp] = useState<LoadedApp | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => watch(setStatus), [watch]);
  // The start-up stages: every engine line advances them; a (re)start begins them afresh.
  const [progress, setProgress] = useState<Progress>({ reached: -1, latest: null });
  const starting = status.state === "starting" || status.state === "restarting";
  useEffect(() => {
    if (!starting) return;
    setProgress({ reached: -1, latest: null });
    return watchLog((line) => setProgress((p) => advance(p, line)));
  }, [starting, watchLog]);
  // A reload only on a real transition back to "ready" after the engine had been ready once
  // (never on a re-render while ready — the default callback is a fresh function each render).
  const previous = useRef<SidecarStatus["state"] | null>(null);
  const everReady = useRef(false);
  const restarted = useRef(onEngineRestarted);
  restarted.current = onEngineRestarted;
  useEffect(() => {
    const was = previous.current;
    previous.current = status.state;
    if (status.state !== "ready") return;
    if (was !== null && was !== "ready" && everReady.current) restarted.current();
    everReady.current = true;
  }, [status.state]);
  useEffect(() => {
    if (status.state !== "ready" || app) return;
    let alive = true;
    load(status.info)
      .then((loaded) => alive && setApp(loaded))
      .catch((error: unknown) => alive && setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      alive = false;
    };
  }, [status, app, load]);

  // The landing's frame — header, "Vaults", status strip — is on screen from the first paint;
  // the engine's state lives in the strip, so nothing jumps when the vaults arrive.
  if (status.state === "exited" || status.state === "failed" || status.state === "restarting" || status.state === "gave_up" || status.state === "stopping") {
    return <Landing engine={status} onRetry={isTauri() ? () => void invokeIfTauri("retry_engine") : undefined} />;
  }
  if (failure) return <EngineScreen kind="alert" title="The vault app could not load" detail={failure} />;
  if (status.state === "ready" && app) {
    const App = app.App;
    return <App info={status.info} client={app.client} bearer={app.bearer} />;
  }
  const preparing = status.state === "starting" && status.preparing === true;
  return <Landing engine={{ state: "starting", preparing, stage: `${currentStageLabel(progress, preparing)}…` }} progress={progress} />;
}
