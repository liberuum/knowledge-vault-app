import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchFullGraph, fetchVaultGraph, type FullGraph, type VaultGraphSample } from "../api/graph.js";
import { createTokenProvider, type IdentityStatus } from "../api/identity.js";
import { addRemoteVault, authorizedFetch, discoverRemoteVaults, fetchRemoteVaults, removeRemoteVault, type RemoteDiscovery, type RemoteVault } from "../api/remote.js";
import type { SidecarInfo } from "../sidecar.js";
import { createVault, deleteVault, fetchSettings, fetchStatus, fetchVaults, renameVault, type DriveRef, type ModelSettings, type VaultSummary } from "../vaults.js";
import { GettingStarted, type VaultView } from "../landing/GettingStarted.js";
import { remember } from "../landing/getting-started.js";
import { modelReady as isModelReady } from "../onboarding/onboarding-state.js";
import { ConnectRemoteDialog } from "../landing/ConnectRemoteDialog.js";
import { DeleteVaultDialog } from "../landing/DeleteVaultDialog.js";
import { NewVaultForm } from "../landing/NewVaultForm.js";
import { readRecents, rememberOpened, sortByRecency, type Recents } from "../landing/recents.js";
import { RenameVaultDialog } from "../landing/RenameVaultDialog.js";
import { loadSavedLayout, type XY } from "../landing/saved-layout.js";
import { StatusStrip, type EngineState } from "../landing/StatusStrip.js";
import { StartupProgress } from "../landing/StartupProgress.js";
import type { Progress } from "../landing/startup-stages.js";
import { SkeletonTile, VaultTile } from "../landing/VaultTile.js";
import { VaultMenu } from "../landing/VaultMenu.js";
import { Dialog } from "../shell/Dialog.js";
import { Header } from "../shell/Header.js";
import { plainError } from "../problem.js";

export type LandingApi = {
  fetchVaults: (info: SidecarInfo) => Promise<VaultSummary[]>;
  createVault: (info: SidecarInfo, name: string) => Promise<VaultSummary>;
  renameVault: (info: SidecarInfo, id: string, name: string) => Promise<DriveRef>;
  deleteVault: (info: SidecarInfo, id: string) => Promise<void>;
  fetchRemoteVaults: (info: SidecarInfo) => Promise<RemoteVault[]>;
  discoverRemote: (info: SidecarInfo, url: string) => Promise<RemoteDiscovery>;
  addRemote: (info: SidecarInfo, url: string, drive: string | undefined) => Promise<RemoteVault>;
  removeRemote: (info: SidecarInfo, id: string) => Promise<void>;
  fetchGraph: (origin: string, driveId: string, maxNodes: number, fetchImpl?: typeof fetch) => Promise<VaultGraphSample>;
  /** The whole graph for a tile with a saved layout — asked for once per vault and graph size per session. */
  fetchFullGraph: (origin: string, driveId: string, fetchImpl?: typeof fetch) => Promise<FullGraph>;
  fetchVersion: (info: SidecarInfo) => Promise<string>;
  loadLayout: (driveId: string) => Promise<Map<string, XY> | null>;
  /** The user's bearer for remote servers; built per engine when not injected. */
  tokenProvider?: (info: SidecarInfo) => () => Promise<string | undefined>;
  /** The app's model setting, for the getting-started checklist; without it the model step reads as not done. */
  fetchModels?: (info: SidecarInfo) => Promise<ModelSettings>;
};

export const realLandingApi: LandingApi = {
  fetchVaults,
  createVault,
  renameVault,
  deleteVault,
  fetchRemoteVaults,
  discoverRemote: discoverRemoteVaults,
  addRemote: addRemoteVault,
  removeRemote: removeRemoteVault,
  fetchGraph: (origin, driveId, maxNodes, fetchImpl) => fetchVaultGraph(origin, driveId, { maxNodes }, fetchImpl),
  fetchFullGraph,
  fetchVersion: async (info) => (await fetchStatus(info)).appVersion,
  loadLayout: loadSavedLayout,
  tokenProvider: (info) => createTokenProvider(info),
  fetchModels: async (info) => (await fetchSettings(info)).models,
};

/** Whole graphs already fetched this session, keyed by vault and graph size (a changed count refetches). */
const fullGraphs = new Map<string, FullGraph>();

/** Local and remote vaults share the grid; recency orders both. */
type AnyVault = ({ kind: "local" } & VaultSummary) | RemoteVault;

type Props = {
  engine: EngineState;
  /** What the engine has done so far while starting (boot.tsx feeds it from the shell's log events). */
  progress?: Progress;
  /** "Try again" after the engine kept stopping or refused to start (the shell's retry_engine). */
  onRetry?: () => void;
  /** Present once the engine is ready; the landing lists and creates vaults only then. */
  info?: SidecarInfo;
  identity?: IdentityStatus | null;
  onOpen?: (vault: VaultSummary) => void;
  onOpenRemote?: (vault: RemoteVault) => void;
  onIdentity?: () => void;
  onWorkflows?: () => void;
  onSettings?: () => void;
  /** Arrive with the create form open (Ctrl+N); `onNewVaultDone` clears that route flag once the form closes. */
  newVault?: boolean;
  onNewVaultDone?: () => void;
  api?: LandingApi;
  storage?: Storage;
  /** The user's bearer for a protected local engine (spec §4.4); its tiles then fetch as remote ones do. */
  localBearer?: () => Promise<string | undefined>;
  /** Opens the setup guide (spec §5): offered on the first-run screen to anyone who skipped it. */
  onGuide?: () => void;
  /** Settings › Models, from the getting-started checklist. */
  onModels?: () => void;
  /** Opens a vault on one of its views (Sources, Notes, Chat, Graph, Search), from the getting-started list. */
  onOpenView?: (vault: VaultSummary, view: VaultView) => void;
  /** Settings › Getting started: where the list is when closed. */
  onStartSettings?: () => void;
};

/**
 * The front door (spec §5.7): the vaults as constellation tiles, the most
 * recently opened one largest; on first run, the inline create form; the
 * engine's state in a strip at the bottom. Never a workspace.
 */
export function Landing({ engine, progress, info, identity, onOpen, onOpenRemote, onIdentity, onWorkflows, onSettings, newVault = false, onNewVaultDone, api = realLandingApi, storage, localBearer, onRetry, onGuide, onModels, onOpenView, onStartSettings }: Props) {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [remotes, setRemotes] = useState<RemoteVault[] | null>(null);
  const [recents, setRecents] = useState<Recents>(() => readRecents(store));
  const [samples, setSamples] = useState<Record<string, VaultGraphSample | null>>({});
  const [layouts, setLayouts] = useState<Record<string, Map<string, XY> | null>>({});
  const [fulls, setFulls] = useState<Record<string, FullGraph | null>>({});
  const [version, setVersion] = useState<string | undefined>();
  const [showForm, setShowForm] = useState(newVault);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<VaultSummary | null>(null);
  const [deleting, setDeleting] = useState<VaultSummary | null>(null);
  const [removing, setRemoving] = useState<RemoteVault | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  /** Whether the app has a usable AI model (the checklist's first step); null until known. */
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const tokenProvider = useMemo(() => (info && api.tokenProvider ? api.tokenProvider(info) : undefined), [api, info]);
  const localFetch = useMemo(() => (localBearer ? authorizedFetch(localBearer) : undefined), [localBearer]);

  useEffect(() => setShowForm(newVault), [newVault]);
  useEffect(() => {
    if (!info || engine.state !== "ready") return;
    if (!api.fetchModels) return setModelReady(false);
    let alive = true;
    api
      .fetchModels(info)
      .then((m) => alive && setModelReady(isModelReady(m)))
      .catch(() => alive && setModelReady(false));
    return () => {
      alive = false;
    };
  }, [api, info, engine.state]);
  const closeForm = () => {
    setShowForm(false);
    if (newVault) onNewVaultDone?.();
  };

  useEffect(() => {
    if (!info) return;
    let alive = true;
    api
      .fetchVaults(info)
      .then((v) => alive && setVaults(v))
      .catch((e: Error) => alive && setError(`Could not load the vaults: ${e.message}`));
    api
      .fetchRemoteVaults(info)
      .then((v) => alive && setRemotes(v))
      .catch(() => alive && setRemotes([]));
    api
      .fetchVersion(info)
      .then((v) => alive && setVersion(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, info]);

  const all = useMemo<AnyVault[]>(() => [...(vaults ?? []).map((v) => ({ kind: "local" as const, ...v })), ...(remotes ?? [])], [vaults, remotes]);
  const ordered = useMemo(() => sortByRecency(all, recents), [all, recents]);

  // Each vault's sample and saved layout are asked for once; results land whenever they arrive
  // (a state update after unmount is harmless, and gating on a stale flag dropped results).
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!info || !vaults) return;
    for (const [i, v] of ordered.entries()) {
      if (requested.current.has(v.id)) continue;
      requested.current.add(v.id);
      const origin = v.kind === "remote" ? v.switchboardUrl : info.origin;
      const fetchImpl = v.kind === "remote" ? (tokenProvider ? authorizedFetch(tokenProvider) : undefined) : localFetch;
      api
        .fetchGraph(origin, v.id, i === 0 ? 48 : 28, fetchImpl)
        .then((s) => setSamples((prev) => ({ ...prev, [v.id]: s })))
        .catch(() => setSamples((prev) => ({ ...prev, [v.id]: null })));
      api
        .loadLayout(v.id)
        .then((l) => setLayouts((prev) => ({ ...prev, [v.id]: l })))
        .catch(() => setLayouts((prev) => ({ ...prev, [v.id]: null })));
    }
  }, [api, info, vaults, ordered, tokenProvider, localFetch]);

  // The whole graph, only for vaults the person has laid out (a saved layout exists) and once the
  // sample told us the graph's size — the cache key — so a vault is downloaded once per session.
  const requestedFull = useRef(new Set<string>());
  useEffect(() => {
    if (!info) return;
    for (const v of ordered) {
      const saved = layouts[v.id];
      const sample = samples[v.id];
      if (!saved || !sample) continue;
      const origin = v.kind === "remote" ? v.switchboardUrl : info.origin;
      const key = `${origin}|${v.id}|${sample.noteCount}|${sample.linkCount}`;
      if (requestedFull.current.has(key)) continue;
      requestedFull.current.add(key);
      const cached = fullGraphs.get(key);
      if (cached) {
        setFulls((prev) => ({ ...prev, [v.id]: cached }));
        continue;
      }
      const fetchImpl = v.kind === "remote" ? (tokenProvider ? authorizedFetch(tokenProvider) : undefined) : localFetch;
      api
        .fetchFullGraph(origin, v.id, fetchImpl)
        .then((g) => {
          fullGraphs.set(key, g);
          setFulls((prev) => ({ ...prev, [v.id]: g }));
        })
        .catch(() => {});
    }
  }, [api, info, ordered, layouts, samples, tokenProvider, localFetch]);

  const open = useCallback(
    (v: AnyVault) => {
      setRecents(rememberOpened(store, v.id));
      if (v.kind === "remote") onOpenRemote?.(v);
      else {
        if (v.noteCount > 0) remember(store, { readNotes: true }); // the checklist's "Read your first notes"
        onOpen?.(v);
      }
    },
    [onOpen, onOpenRemote, store],
  );
  const openView = useCallback(
    (v: VaultSummary, view: VaultView) => {
      setRecents(rememberOpened(store, v.id));
      onOpenView?.(v, view);
    },
    [onOpenView, store],
  );

  async function create(name: string) {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api.createVault(info, name);
      setVaults((prev) => [...(prev ?? []), v]);
      closeForm();
      open({ kind: "local", ...v });
    } catch (e) {
      setError(`Could not create the vault: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function rename(v: VaultSummary, name: string) {
    if (!info) return;
    setBusy(true);
    setDialogError(null);
    try {
      const renamed = await api.renameVault(info, v.id, name);
      setVaults((prev) => (prev ?? []).map((x) => (x.id === v.id ? { ...x, name: renamed.name } : x)));
      setRenaming(null);
    } catch (e) {
      setDialogError(`Could not rename the vault: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function remove(v: VaultSummary) {
    if (!info) return;
    setBusy(true);
    setDialogError(null);
    try {
      await api.deleteVault(info, v.id);
      setVaults((prev) => (prev ?? []).filter((x) => x.id !== v.id));
      setDeleting(null);
    } catch (e) {
      setDialogError(`Could not delete the vault: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function forget(v: RemoteVault) {
    if (!info) return;
    setBusy(true);
    setDialogError(null);
    try {
      await api.removeRemote(info, v.id);
      setRemotes((prev) => (prev ?? []).filter((x) => x.id !== v.id));
      setRemoving(null);
    } catch (e) {
      setDialogError(`Could not remove the vault: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const ready = engine.state === "ready" && !!info;
  const loading = ready && (vaults === null || remotes === null) && !error;
  // First run only once both lists are known: a person with only remote vaults must not see the create form flash.
  const firstRun = ready && vaults !== null && remotes !== null && vaults.length === 0 && remotes.length === 0;
  const signedIn = identity?.authenticated === true;

  return (
    <div className="kv-landing" data-engine={engine.state}>
      <Header identity={ready ? identity : undefined} onIdentity={ready ? onIdentity : undefined} onWorkflows={ready ? onWorkflows : undefined} onSettings={ready ? onSettings : undefined} />
      <main className="kv-main">
        <div className="kv-vaults-row">
          <h2 id="vaults-heading">Vaults</h2>
          {ready && !firstRun && vaults !== null && (
            <div className="kv-actions">
              <button type="button" className="kv-button" onClick={() => setShowForm(true)} disabled={showForm} title="New vault (Ctrl+N)">
                New vault
              </button>
              <button type="button" className="kv-button" onClick={() => setConnecting(true)} title="A vault on a server: open ones need no sign-in">
                Connect remote vault
              </button>
            </div>
          )}
        </div>
        {engine.state === "starting" ? (
          <StartupProgress progress={progress ?? { reached: -1, latest: null }} preparing={engine.preparing === true} />
        ) : (
          !ready && <p className="kv-quiet">Your vaults appear here once the engine is ready.</p>
        )}
        {error && !showForm && !firstRun && <p role="alert" className="kv-error">{plainError(error)}</p>}
        {firstRun && (
          <>
            <NewVaultForm firstRun busy={busy} error={error} onCreate={(n) => void create(n)} />
            <p className="kv-hint">
              Already have a vault on a server?{" "}
              <button type="button" className="kv-link" onClick={() => setConnecting(true)}>Connect a remote vault</button>.
              {!signedIn && onIdentity && (
                <>
                  {" If its server asks who you are, "}
                  <button type="button" className="kv-link" onClick={onIdentity}>sign in</button> first.
                </>
              )}
            </p>
          </>
        )}
        {ready && !firstRun && showForm && <NewVaultForm firstRun={false} busy={busy} error={error} onCreate={(n) => void create(n)} onCancel={closeForm} />}
        {ready && info && vaults !== null && remotes !== null && modelReady !== null && (
          // The steps that make the app useful (design §5), with the setup guide one click away.
          <GettingStarted
            info={info}
            vaults={ordered.filter((v): v is { kind: "local" } & VaultSummary => v.kind === "local")}
            modelReady={modelReady}
            storage={store}
            onModels={onModels}
            onNewVault={() => setShowForm(true)}
            onOpenView={onOpenView ? openView : undefined}
            onWorkflows={onWorkflows}
            onGuide={onGuide}
            onOpenSettings={onStartSettings}
          />
        )}
        {loading && (
          <div className="kv-grid" role="status" aria-label="Loading vaults">
            <SkeletonTile lead />
            <SkeletonTile lead={false} />
            <SkeletonTile lead={false} />
          </div>
        )}
        {ready && ordered.length > 0 && (
          <ul className="kv-grid" aria-labelledby="vaults-heading">
            {ordered.map((v, i) => (
              <li key={v.id} className="kv-grid-cell">
                {v.kind === "remote" ? (
                  <VaultTile
                    vault={{ id: v.id, slug: v.slug, name: v.name, noteCount: samples[v.id]?.noteCount ?? 0 }}
                    remote={{ host: new URL(v.switchboardUrl).host }}
                    lead={i === 0}
                    opened={recents[v.id]}
                    sample={samples[v.id] ?? null}
                    full={fulls[v.id] ?? null}
                    saved={layouts[v.id] ?? null}
                    onOpen={() => open(v)}
                    menu={<VaultMenu name={v.name} onOpen={() => open(v)} onRemove={() => { setDialogError(null); setRemoving(v); }} />}
                  />
                ) : (
                  <VaultTile
                    vault={v}
                    lead={i === 0}
                    opened={recents[v.id]}
                    sample={samples[v.id] ?? null}
                    full={fulls[v.id] ?? null}
                    saved={layouts[v.id] ?? null}
                    onOpen={() => open(v)}
                    menu={<VaultMenu name={v.name} onOpen={() => open(v)} onRename={() => { setDialogError(null); setRenaming(v); }} onDelete={() => { setDialogError(null); setDeleting(v); }} />}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
      <StatusStrip engine={engine} version={version} onRetry={onRetry} />
      {renaming && <RenameVaultDialog name={renaming.name} busy={busy} error={dialogError} onSave={(n) => void rename(renaming, n)} onClose={() => setRenaming(null)} />}
      {deleting && <DeleteVaultDialog name={deleting.name} noteCount={samples[deleting.id]?.noteCount ?? deleting.noteCount} busy={busy} error={dialogError} onConfirm={() => void remove(deleting)} onClose={() => setDeleting(null)} />}
      {removing && (
        <Dialog open title={`Remove “${removing.name}” from this app?`} onClose={() => setRemoving(null)}>
          <div className="kv-dialog-form">
            <p>The vault stays on {new URL(removing.switchboardUrl).host} exactly as it is; only this app forgets it.</p>
            {dialogError && <p role="alert" className="kv-error">{plainError(dialogError)}</p>}
            <div className="kv-dialog-actions">
              <button type="button" className="kv-button" onClick={() => setRemoving(null)} disabled={busy}>Cancel</button>
              <button type="button" className="kv-button kv-button-primary" onClick={() => void forget(removing)} disabled={busy}>{busy ? "Removing…" : "Remove"}</button>
            </div>
          </div>
        </Dialog>
      )}
      {connecting && info && (
        <ConnectRemoteDialog
          api={{ discover: (u) => api.discoverRemote(info, u), add: (u, d) => api.addRemote(info, u, d) }}
          onAdded={(added) => setRemotes((prev) => [...(prev ?? []).filter((x) => !added.some((v) => v.id === x.id)), ...added])}
          onClose={() => setConnecting(false)}
        />
      )}
    </div>
  );
}
