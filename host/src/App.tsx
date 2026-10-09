import { setRenown, type GraphQLReactorClient } from "@powerhousedao/reactor-browser";
import { HostModals } from "./components/HostModals.js";
import { HostToasts } from "./components/HostToasts.js";
import { desktopRenown } from "./shell/desktop-renown.js";
import * as knowledgeNote from "@powerhousedao/knowledge-note";
import * as workflow from "@powerhousedao/workflow";
import type { DocumentModelLib } from "document-model";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIdentity } from "./state/use-identity.js";
import { useReturnHomeAfterSignIn } from "./state/return-home-after-sign-in.js";
import { fetchRemoteVaults, type RemoteVault } from "./api/remote.js";
import { declareDesktopHost, setHostModel } from "./bootstrap.js";
import { MODELS_CHANGED_EVENT, modelDeclaration, openModelSettings } from "./model-declaration.js";
import { Landing } from "./screens/Landing.js";
import { RemoteWorkspaceScreen } from "./screens/RemoteWorkspaceScreen.js";
import { Settings } from "./screens/Settings.js";
import { WorkflowsScreen } from "./screens/WorkflowsScreen.js";
import { WorkspaceScreen } from "./screens/WorkspaceScreen.js";
import { useRoute } from "./shell/router.js";
import { matchShortcut } from "./shell/shortcuts.js";
import type { SidecarInfo } from "./sidecar.js";
import type { TokenProvider } from "./api/identity.js";
import { EngineBanner } from "./components/EngineBanner.js";
import { DownloadNotice } from "./components/DownloadNotice.js";
import { useEngineHealth } from "./state/use-engine-health.js";
import { fetchSettings, type AppSettings } from "./vaults.js";
import { Onboarding } from "./onboarding/Onboarding.js";
import type { OnboardingStep } from "./onboarding/onboarding-state.js";
import { useOnboardingGate } from "./onboarding/use-onboarding-gate.js";
import { setOpenView } from "./onboarding/pending-files.js";
import { guideProgress } from "./onboarding/progress.js";

/** The packages the host mounts; boot.tsx installs the reactor with their document models, once. */
export const LIBS: readonly DocumentModelLib[] = [
  knowledgeNote as unknown as DocumentModelLib,
  workflow as unknown as DocumentModelLib,
];

export function App({ info, client, bearer }: { info: SidecarInfo; client: GraphQLReactorClient; bearer?: TokenProvider }) {
  const [route, navigate] = useRoute();
  const toVaults = useCallback(() => navigate({ name: "vaults" }), [navigate]);
  const toSettings = useCallback(() => navigate({ name: "settings", section: "vaults" }), [navigate]);
  const toWorkflows = useCallback(() => navigate({ name: "workflows" }), [navigate]);
  const inWorkspace = route.name === "vault" || route.name === "workflows" || route.name === "remote";
  const toIdentity = useCallback(() => navigate({ name: "settings", section: "identity" }), [navigate]);
  const toGuide = useCallback((step: OnboardingStep = "welcome", vault?: string) => navigate({ name: "welcome", step, ...(vault ? { vault } : {}) }), [navigate]);
  // A new install (or one stopped half-way) opens the setup guide from the landing, once per start.
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const gateDecided = useOnboardingGate(info, route.name === "vaults", appSettings, toGuide);
  const identity = useIdentity(info);
  // Spec §9: a crash the supervisor is restarting shows as a banner over whatever is open.
  const health = useEngineHealth(info);
  const hostIdentity = useMemo(
    () => (identity.status?.authenticated && identity.status.address ? { address: identity.status.address, ...(identity.status.did ? { did: identity.status.did } : {}) } : undefined),
    [identity.status?.authenticated, identity.status?.address, identity.status?.did],
  );
  // A sign-in completed on Settings › Identity: back to the landing.
  useReturnHomeAfterSignIn(identity.status?.authenticated, route.name === "settings" && route.section === "identity", toVaults);
  // Coming back to a shell screen re-reads the sign-in state (a flow may have completed meanwhile).
  useEffect(() => {
    if (!inWorkspace) void identity.refresh();
  }, [inWorkspace, route.name, identity.refresh]);
  // The vault package reads who we are from the host declaration (gate, Access view, live feed).
  // A remote workspace declares its own origin and bearer while it is open.
  // A protected local engine (spec §4.4) is declared with the user's bearer, open with none; coming
  // back from a remote vault re-declares the local engine (the remote screen declared its own).
  const inRemote = route.name === "remote";
  // The vault chat uses the app's model (spec §3.1): read it, and again whenever Settings › Models saves.
  // A save only bumps `modelVersion`; it is a dependency of the read below, though its body never uses it —
  // that is what runs the read again, so it stays in the list.
  const [modelVersion, setModelVersion] = useState(0);
  useEffect(() => {
    const bump = () => setModelVersion((n) => n + 1);
    globalThis.addEventListener(MODELS_CHANGED_EVENT, bump);
    return () => globalThis.removeEventListener(MODELS_CHANGED_EVENT, bump);
  }, []);
  useEffect(() => {
    let alive = true;
    void fetchSettings(info)
      .then((s) => {
        if (!alive) return;
        setAppSettings(s);
        setHostModel(modelDeclaration(info, s.models), openModelSettings);
        if (!inRemote) declareDesktopHost(info.origin, { identity: hostIdentity, ...(bearer ? { bearer } : {}) });
      })
      .catch(() => undefined); // the engine not answering is shown elsewhere; the chat keeps its last model
    return () => {
      alive = false;
    };
  }, [info, modelVersion, inRemote, hostIdentity, bearer]);
  useEffect(() => {
    if (inRemote) return; // the remote screen is the sole declarer while it is open
    declareDesktopHost(info.origin, { identity: hostIdentity, ...(bearer ? { bearer } : {}) });
  }, [info.origin, hostIdentity, inRemote, bearer]);

  // Apps that read Connect's ambient Renown session (Workflow Studio's runtime calls take
  // their bearer from it) see the signed-in user, backed by the engine's sign-in.
  useEffect(() => {
    setRenown(hostIdentity ? (desktopRenown(hostIdentity, bearer) as unknown as Parameters<typeof setRenown>[0]) : undefined);
  }, [hostIdentity, bearer]);

  // Shortcuts only on the shell's own screens: a workspace app owns its keys.
  useEffect(() => {
    if (inWorkspace) return;
    const onKey = (e: KeyboardEvent) => {
      const s = matchShortcut(e);
      if (!s) return;
      e.preventDefault();
      if (s === "new-vault") navigate({ name: "vaults", newVault: true });
      else toSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inWorkspace, navigate, toSettings]);

  let screen;
  switch (route.name) {
    case "vault":
      screen = <WorkspaceScreen client={client} driveId={route.id} appId="knowledge-vault" onBack={toVaults} onSettings={toSettings} onGuide={guideProgress()?.vault === route.id ? () => toGuide("notes", route.id) : undefined} pipeline={{ info, onModels: () => navigate({ name: "settings", section: "models" }), onRuns: (workflow?: string) => navigate(workflow ? { name: "workflows", workflow } : { name: "workflows" }) }} />;
      break;
    case "workflows":
      screen = <WorkflowsScreen info={info} client={client} onBack={toVaults} onSettings={toSettings} />;
      break;
    case "remote":
      screen = <RemoteRoute info={info} id={route.id} identity={hostIdentity} onBack={toVaults} onSettings={toSettings} />;
      break;
    case "welcome":
      screen = (
        <Onboarding
          info={info}
          step={route.step ?? "welcome"}
          vaultId={route.vault}
          onStep={toGuide}
          onFinish={(id, view) => {
            if (view) setOpenView(id, view);
            navigate({ name: "vault", id });
          }}
          onVisit={(id, view) => {
            setOpenView(id, view);
            navigate({ name: "vault", id });
          }}
          onRuns={(workflow) => navigate({ name: "workflows", workflow })}
          onLeave={toVaults}
        />
      );
      break;
    case "settings":
      screen = (
        <Settings
          info={info}
          section={route.section}
          onSection={(section) => navigate({ name: "settings", section })}
          onBack={toVaults}
          onOpenWorkflows={toWorkflows}
          identity={identity}
          onOpenView={(v, view) => {
            setOpenView(v.id, view);
            navigate({ name: "vault", id: v.id });
          }}
          onNewVault={() => navigate({ name: "vaults", newVault: true })}
          onGuide={() => toGuide()}
        />
      );
      break;
    default:
      // Until the start-up gate decided, the landing waits: a newcomer goes straight to the guide, no flash.
      screen = !gateDecided ? <div className="kv-landing" aria-busy="true" /> : (
        <Landing
          engine={{ state: "ready" }}
          info={info}
          identity={identity.status}
          onIdentity={toIdentity}
          onOpenRemote={(v) => navigate({ name: "remote", id: v.id })}
          newVault={route.newVault === true}
          onNewVaultDone={toVaults}
          onOpen={(v) => navigate({ name: "vault", id: v.id })}
          onWorkflows={toWorkflows}
          onSettings={toSettings}
          localBearer={bearer}
          onGuide={() => toGuide()}
          onModels={() => navigate({ name: "settings", section: "models" })}
          onStartSettings={() => navigate({ name: "settings", section: "start" })}
          onOpenView={(v, view) => {
            setOpenView(v.id, view);
            navigate({ name: "vault", id: v.id });
          }}
        />
      );
  }
  return (
    <>
      <EngineBanner health={health} />
      {screen}
      <HostModals />
      <HostToasts />
      <DownloadNotice />
    </>
  );
}

/** Looks the remote vault up by id (the list is the engine's), then mounts it. */
function RemoteRoute({ info, id, identity, onBack, onSettings }: { info: SidecarInfo; id: string; identity: { address: string; did?: string } | undefined; onBack: () => void; onSettings: () => void }) {
  const [vault, setVault] = useState<RemoteVault | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetchRemoteVaults(info)
      .then((list) => alive && setVault(list.find((v) => v.id === id) ?? null))
      .catch(() => alive && setVault(null));
    return () => {
      alive = false;
    };
  }, [info, id]);
  if (vault === undefined) return <p role="status" className="kv-quiet kv-main">Opening…</p>;
  if (vault === null) {
    return (
      <div className="kv-main">
        <p role="alert" className="kv-error">This remote vault is no longer in the app's list.</p>
        <button type="button" className="kv-button" onClick={onBack}>← Vaults</button>
      </div>
    );
  }
  return <RemoteWorkspaceScreen info={info} vault={vault} identity={identity} onBack={onBack} onSettings={onSettings} />;
}
