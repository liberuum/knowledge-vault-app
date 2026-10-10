import { useEffect, useState } from "react";
import { LoadingLine } from "../components/VaultLoader.js";
import { GettingStarted, type VaultView } from "../landing/GettingStarted.js";
import { readRecents, sortByRecency } from "../landing/recents.js";
import { modelReady } from "../onboarding/onboarding-state.js";
import type { SettingsApi } from "../screens/Settings.js";
import type { SidecarInfo } from "../sidecar.js";
import type { VaultSummary } from "../vaults.js";
import { plainError } from "../problem.js";

/** Settings › Getting started: the front page's list, always here, so what is left can be seen and the list brought back. */
export function GettingStartedSection({
  info,
  api,
  onOpenView,
  onNewVault,
  onModels,
  onWorkflows,
  onGuide,
}: {
  info: SidecarInfo;
  api: SettingsApi;
  onOpenView: (vault: VaultSummary, view: VaultView) => void;
  onNewVault: () => void;
  onModels: () => void;
  onWorkflows: () => void;
  onGuide: () => void;
}) {
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storage = typeof localStorage === "undefined" ? undefined : localStorage;

  useEffect(() => {
    let alive = true;
    Promise.all([api.fetchVaults(info), api.fetchSettings(info)])
      .then(([list, settings]) => {
        if (!alive) return;
        setVaults(sortByRecency(list, readRecents(storage)));
        setReady(modelReady(settings.models));
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [api, info, storage]);

  return (
    <div className="kv-settings-body">
      <p className="kv-settings-lead">The steps that make Knowledge Vault useful, ticked as you do them. Close the list on the front page any time; it stays here.</p>
      {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
      {vaults === null || ready === null ? (
        !error && <LoadingLine>Checking your steps…</LoadingLine>
      ) : (
        <GettingStarted info={info} vaults={vaults} modelReady={ready} storage={storage} onModels={onModels} onNewVault={onNewVault} onOpenView={onOpenView} onWorkflows={onWorkflows} onGuide={onGuide} variant="settings" />
      )}
    </div>
  );
}
