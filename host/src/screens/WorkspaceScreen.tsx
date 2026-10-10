import {
  setDrives,
  setSelectedDrive,
  setSelectedNode,
  useAppModuleById,
  useDocumentCache,
  useSelectedDocumentId,
  useSelectedDriveSafe,
  type GraphQLReactorClient,
} from "@powerhousedao/reactor-browser";
import { Suspense, useEffect, useRef, useState } from "react";
import { DocumentEditorContainer } from "../components/DocumentEditorContainer.js";
import { ProblemCard } from "../components/ProblemCard.js";
import { VaultLoader } from "../components/VaultLoader.js";
import { AppBar } from "../shell/AppBar.js";
import { PipelineChip } from "../components/PipelineChip.js";
import { describeProblem, type ProblemContext } from "../problem.js";
import { followDrive } from "./follow-drive.js";
import { fillConnection } from "../api/connections.js";
import type { SidecarInfo } from "../sidecar.js";

type Drives = NonNullable<Parameters<typeof setDrives>[0]>;
type DriveDoc = Drives[number];

export type WorkspaceApp = "knowledge-vault" | "workflow-studio";

/** The sign-in, as the error card needs it: who, and the ways to (re-)sign in. */
export type WorkspaceAuth = {
  signedIn: boolean;
  address?: string;
  /** Changes when the sign-in changes; a screen that failed then tries again by itself. */
  key: string;
  /** A sign-in is waiting for the browser. */
  signingIn: boolean;
  signIn: () => void;
  /** Sign out, then in again: the only way to a fresh sign-in while the app still holds one. */
  reSignIn: () => void;
};

/** One quiet retry before the card shows: a Renown hiccup or a network blip usually passes. */
const AUTO_RETRY_MS = 1500;

/**
 * Full view for one drive: a vault (the Knowledge Vault app) or the Workflows
 * drive (Workflow Studio). The app bar is the only shell chrome left on screen.
 * A drive that cannot open shows a card that says why and offers the way back (spec §9).
 */
export function WorkspaceScreen(props: {
  client: GraphQLReactorClient;
  driveId: string;
  appId: WorkspaceApp;
  fallbackTitle?: string;
  onBack: () => void;
  onSettings?: () => void;
  /** The setup guide is still open for this vault: a way back to it. */
  onGuide?: () => void;
  /** A local vault's pipeline chip (spec §4.5): where to send the user for a model, and for the runs. */
  pipeline?: { info: SidecarInfo; onModels: () => void; onRuns: (workflowId?: string) => void };
  /** The local engine, for apps whose documents it can fill in (Studio's Knowledge Vault connections). */
  engine?: SidecarInfo;
  /** The sign-in, for the card's actions; absent where the drive needs none. */
  auth?: WorkspaceAuth;
  /** A remote vault's server (host name), for the card's wording. */
  remoteHost?: string;
  /** Before a retry: drop what may have caused the failure (a remote vault's cached token). */
  beforeRetry?: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [title, setTitle] = useState(props.fallbackTitle ?? "");
  const [error, setError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cache = useDocumentCache();
  // The workspace's lifetime is the drive's: set up and torn down only when the drive changes.
  // (Never on a cache swap — the vault app installs its own cache when it mounts, and tearing
  // down on that would unmount it, remount it, and loop.)
  const follow = useRef<{ last?: string; selected: boolean }>({ selected: false });
  const failed = useRef(false);
  const autoRetried = useRef(false);
  useEffect(() => {
    follow.current = { selected: false };
    failed.current = false;
    autoRetried.current = false;
    return () => {
      setSelectedNode(undefined);
      setSelectedDrive(undefined);
      setDrives([]);
    };
  }, [props.driveId, props.appId]);
  const context: ProblemContext = {
    what: props.appId === "workflow-studio" ? "Workflow Studio" : "this vault",
    ...(props.remoteHost ? { host: props.remoteHost } : {}),
    ...(props.auth ? { signedIn: props.auth.signedIn, ...(props.auth.address ? { address: props.auth.address } : {}) } : {}),
  };
  const contextRef = useRef(context);
  contextRef.current = context;
  const beforeRetry = useRef(props.beforeRetry);
  beforeRetry.current = props.beforeRetry;
  const authKey = props.auth?.key;
  // Following the drive is per cache: a swap re-subscribes, and an unchanged drive is not republished.
  // A retry (a click, the quiet automatic one, or a changed sign-in) asks the server again.
  useEffect(() => {
    if (!cache) return;
    const state = follow.current;
    const refetch = failed.current;
    if (refetch) beforeRetry.current?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = followDrive(
      cache,
      props.driveId,
      props.appId,
      (drive) => {
        failed.current = false;
        setError(null);
        setRetrying(false);
        const withMeta = drive as DriveDoc;
        const stateName = (drive.state as { global?: { name?: string } } | undefined)?.global?.name;
        setTitle(stateName || drive.header.name || props.fallbackTitle || "");
        setDrives([withMeta]);
        if (!state.selected) {
          state.selected = true;
          setSelectedDrive(withMeta); // the object: a string argument is taken as a slug
          setReady(true);
        }
      },
      (e) => {
        failed.current = true;
        const kind = describeProblem(e, contextRef.current).kind;
        if (!autoRetried.current && (kind === "credential-unconfirmed" || kind === "unreachable")) {
          autoRetried.current = true;
          timer = setTimeout(() => setAttempt((n) => n + 1), AUTO_RETRY_MS);
          return;
        }
        setRetrying(false);
        setError(e);
      },
      state,
      refetch,
    );
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [cache, props.driveId, props.appId, props.fallbackTitle, attempt, authKey]);

  const retry = () => {
    setRetrying(true);
    setAttempt((n) => n + 1);
  };
  const problem = error === null ? null : describeProblem(error, context);
  // One wording for the whole wait, from the drive's first answer to the app on screen.
  const opening = {
    label: title ? `Opening ${title}…` : "Opening the vault…",
    detail: props.remoteHost ? `from ${props.remoteHost}` : undefined,
    slow: props.remoteHost ? `Still waiting for ${props.remoteHost} to answer.` : "This is taking longer than usual.",
  };
  const status = retrying ? "Trying again…" : props.auth?.signingIn ? "Finish signing in in your browser; this opens by itself when you're done." : undefined;
  return (
    <div className="kv-vault-screen">
      <AppBar title={title} onBack={props.onBack} onSettings={props.onSettings} onGuide={props.onGuide}>
        {props.pipeline && props.appId === "knowledge-vault" && <PipelineChip info={props.pipeline.info} vaultId={props.driveId} onModels={props.pipeline.onModels} onRuns={props.pipeline.onRuns} />}
      </AppBar>
      {problem ? (
        <ProblemCard
          problem={problem}
          handlers={{
            retry,
            back: props.onBack,
            ...(props.auth ? { signin: props.auth.signIn, resignin: props.auth.reSignIn } : {}),
          }}
          status={status}
          busy={retrying}
        />
      ) : ready ? (
        <AppContainer engine={props.engine} opening={opening} />
      ) : (
        <VaultLoader {...opening} />
      )}
    </div>
  );
}

/** Connect's AppContainer, reduced: the drive app renders, with the selected document's editor as its children. */
function AppContainer({ engine, opening }: { engine?: SidecarInfo; opening: Parameters<typeof VaultLoader>[0] }) {
  const [selectedDrive] = useSelectedDriveSafe();
  const selectedDocumentId = useSelectedDocumentId();
  const app = useAppModuleById(selectedDrive?.header.meta?.preferredEditor);
  if (!selectedDrive) return <VaultLoader {...opening} />;
  if (!app) return <p role="alert">This drive has no app to show it with.</p>;
  const AppComponent = app.Component;
  return (
    <Suspense fallback={<VaultLoader {...opening} />}>
      <div className="kv-app">
        <AppComponent>{selectedDocumentId ? <DocumentEditorContainer {...(engine ? { fillConnection: (id: string, token: boolean) => fillConnection(engine, id, token) } : {})} /> : null}</AppComponent>
      </div>
    </Suspense>
  );
}
