import type { GraphQLReactorClient } from "@powerhousedao/reactor-browser";
import { useEffect, useState } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { fetchWorkflowsDrive, type DriveRef } from "../vaults.js";
import { AppBar } from "../shell/AppBar.js";
import { ProblemCard } from "../components/ProblemCard.js";
import { VaultLoader } from "../components/VaultLoader.js";
import { describeProblem } from "../problem.js";
import { WorkspaceScreen } from "./WorkspaceScreen.js";

/** Workflow Studio, full view, on the Workflows drive the engine keeps (created on first use). */
export function WorkflowsScreen({ info, client, onBack, onSettings }: { info: SidecarInfo; client: GraphQLReactorClient; onBack: () => void; onSettings?: () => void }) {
  const [drive, setDrive] = useState<DriveRef | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchWorkflowsDrive(info)
      .then((d) => {
        if (!alive) return;
        setError(null);
        setDrive(d);
      })
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [info, attempt]);
  if (!drive) {
    return (
      <div className="kv-vault-screen">
        <AppBar title="Workflows" onBack={onBack} onSettings={onSettings} />
        {error !== null ? (
          <ProblemCard problem={describeProblem(error, { what: "Workflow Studio" })} handlers={{ retry: () => setAttempt((n) => n + 1), back: onBack }} />
        ) : (
          <VaultLoader label="Opening Workflow Studio…" slow="This is taking longer than usual." />
        )}
      </div>
    );
  }
  return <WorkspaceScreen client={client} driveId={drive.id} appId="workflow-studio" fallbackTitle="Workflows" engine={info} onBack={onBack} onSettings={onSettings} />;
}
