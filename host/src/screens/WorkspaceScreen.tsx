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
import { AppBar } from "../shell/AppBar.js";
import { PipelineChip } from "../components/PipelineChip.js";
import { followDrive } from "./follow-drive.js";
import { fillConnection } from "../api/connections.js";
import type { SidecarInfo } from "../sidecar.js";

type Drives = NonNullable<Parameters<typeof setDrives>[0]>;
type DriveDoc = Drives[number];

export type WorkspaceApp = "knowledge-vault" | "workflow-studio";

/**
 * Full view for one drive: a vault (the Knowledge Vault app) or the Workflows
 * drive (Workflow Studio). The app bar is the only shell chrome left on screen.
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
}) {
  const [ready, setReady] = useState(false);
  const [title, setTitle] = useState(props.fallbackTitle ?? "");
  const [error, setError] = useState<string | null>(null);
  const cache = useDocumentCache();
  // The workspace's lifetime is the drive's: set up and torn down only when the drive changes.
  // (Never on a cache swap — the vault app installs its own cache when it mounts, and tearing
  // down on that would unmount it, remount it, and loop.)
  const follow = useRef<{ last?: string; selected: boolean }>({ selected: false });
  useEffect(() => {
    follow.current = { selected: false };
    return () => {
      setSelectedNode(undefined);
      setSelectedDrive(undefined);
      setDrives([]);
    };
  }, [props.driveId, props.appId]);
  // Following the drive is per cache: a swap re-subscribes, and an unchanged drive is not republished.
  useEffect(() => {
    if (!cache) return;
    const state = follow.current;
    return followDrive(
      cache,
      props.driveId,
      props.appId,
      (drive) => {
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
      (e) => setError(e.message),
      state,
    );
  }, [cache, props.driveId, props.appId, props.fallbackTitle]);

  return (
    <div className="kv-vault-screen">
      <AppBar title={title} onBack={props.onBack} onSettings={props.onSettings} onGuide={props.onGuide}>
        {props.pipeline && props.appId === "knowledge-vault" && <PipelineChip info={props.pipeline.info} vaultId={props.driveId} onModels={props.pipeline.onModels} onRuns={props.pipeline.onRuns} />}
      </AppBar>
      {error && <p role="alert" className="kv-error kv-main">Could not open this {props.appId === "workflow-studio" ? "workspace" : "vault"}: {error}</p>}
      {ready ? <AppContainer engine={props.engine} /> : !error && <p role="status" className="kv-quiet kv-main">Opening…</p>}
    </div>
  );
}

/** Connect's AppContainer, reduced: the drive app renders, with the selected document's editor as its children. */
function AppContainer({ engine }: { engine?: SidecarInfo }) {
  const [selectedDrive] = useSelectedDriveSafe();
  const selectedDocumentId = useSelectedDocumentId();
  const app = useAppModuleById(selectedDrive?.header.meta?.preferredEditor);
  if (!selectedDrive) return <p role="status">Opening…</p>;
  if (!app) return <p role="alert">This drive has no app to show it with.</p>;
  const AppComponent = app.Component;
  return (
    <Suspense fallback={<p role="status">Loading the app…</p>}>
      <div className="kv-app">
        <AppComponent>{selectedDocumentId ? <DocumentEditorContainer {...(engine ? { fillConnection: (id: string, token: boolean) => fillConnection(engine, id, token) } : {})} /> : null}</AppComponent>
      </div>
    </Suspense>
  );
}
