import type { SidecarInfo } from "../sidecar.js";
import type { LocalProbe, ModelCatalog } from "../vaults.js";
import { deleteVault, fetchConverter, fetchSettings, fetchStatus, fetchVaults, installConverterComponent, removeConverterComponent, renameVault, restartConverter, saveSettings, type AppSettings, type ConverterComponent, type ConverterStatus, type DriveRef, type EngineStatus, type SettingsPatch, type VaultSummary, fetchProtection, setProtection, validateModels, fetchModelCatalog, probeLocalModels } from "../vaults.js";
import { exportVault, fetchBackups, fetchLogTail, requestBackup, requestDeleteAll, requestRestore, type ActionResult, type BackupInfo, type ExportResult, type LocalProtection } from "../vaults.js";
import { AppBar } from "../shell/AppBar.js";
import { SETTINGS_SECTIONS, type SettingsSection } from "../shell/router.js";
import { AboutSection } from "../settings/About.js";
import { AppearanceSection } from "../settings/Appearance.js";
import { ConversionSection } from "../settings/Conversion.js";
import { DiagnosticsSection } from "../settings/Diagnostics.js";
import { IdentitySection } from "../settings/Identity.js";
import type { IdentityController } from "../state/use-identity.js";
import { ModelsSection } from "../settings/Models.js";
import { VaultsSection } from "../settings/Vaults.js";
import { WorkflowsSection } from "../settings/Workflows.js";

export type SettingsApi = {
  fetchVaults: (info: SidecarInfo) => Promise<VaultSummary[]>;
  renameVault: (info: SidecarInfo, id: string, name: string) => Promise<DriveRef>;
  deleteVault: (info: SidecarInfo, id: string) => Promise<void>;
  fetchSettings: (info: SidecarInfo) => Promise<AppSettings>;
  saveSettings: (info: SidecarInfo, patch: SettingsPatch) => Promise<AppSettings>;
  fetchStatus: (info: SidecarInfo) => Promise<EngineStatus>;
  fetchProtection: (info: SidecarInfo) => Promise<LocalProtection>;
  setProtection: (info: SidecarInfo, wanted: boolean) => Promise<LocalProtection & { restarting: boolean }>;
  validateModels: (info: SidecarInfo) => Promise<{ ok: boolean; detail: string; warning?: string }>;
  fetchModelCatalog: (info: SidecarInfo, endpoint?: string) => Promise<ModelCatalog>;
  probeLocalModels: (info: SidecarInfo, endpoint: string) => Promise<LocalProbe>;
  fetchConverter: (info: SidecarInfo) => Promise<ConverterStatus>;
  restartConverter: (info: SidecarInfo) => Promise<ConverterStatus>;
  installConverter: (info: SidecarInfo, component: ConverterComponent) => Promise<ConverterStatus>;
  removeConverter: (info: SidecarInfo, component: ConverterComponent) => Promise<ConverterStatus>;
  /** Spec §9: maintenance — each action runs at the engine's next start. */
  fetchBackups: (info: SidecarInfo) => Promise<{ backups: BackupInfo[]; lastAction: ActionResult | null }>;
  requestBackup: (info: SidecarInfo) => Promise<{ restarting: boolean }>;
  requestRestore: (info: SidecarInfo, name: string) => Promise<{ restarting: boolean }>;
  requestDeleteAll: (info: SidecarInfo, includeBackups: boolean) => Promise<{ restarting: boolean }>;
  exportVault: (info: SidecarInfo, id: string) => Promise<ExportResult>;
  fetchLogTail: (info: SidecarInfo) => Promise<string[]>;
};
export const realSettingsApi: SettingsApi = {
  fetchProtection,
  setProtection,
  validateModels,
  fetchModelCatalog,
  probeLocalModels,
  fetchVaults,
  renameVault,
  deleteVault,
  fetchSettings,
  saveSettings,
  fetchStatus,
  fetchConverter,
  restartConverter,
  installConverter: installConverterComponent,
  removeConverter: removeConverterComponent,
  fetchBackups,
  requestBackup,
  requestRestore,
  requestDeleteAll,
  exportVault,
  fetchLogTail,
};

const LABELS: Record<SettingsSection, string> = {
  vaults: "Vaults",
  appearance: "Appearance",
  models: "Models",
  conversion: "Conversion",
  workflows: "Workflows",
  diagnostics: "Diagnostics",
  about: "About",
  identity: "Identity",
};

type Props = {
  info: SidecarInfo;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
  onOpenWorkflows: () => void;
  api?: SettingsApi;
  identity: IdentityController;
};

/** Settings as a full page: the sections list is where a sidebar belongs — here the sections are peers. */
export function Settings({ info, section, onSection, onBack, onOpenWorkflows, api = realSettingsApi, identity }: Props) {
  return (
    <div className="kv-vault-screen">
      <AppBar title="Settings" onBack={onBack} />
      <div className="kv-settings">
        <nav className="kv-settings-nav" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s} type="button" className="kv-settings-link" aria-current={s === section ? "page" : undefined} onClick={() => onSection(s)}>
              {LABELS[s]}
            </button>
          ))}
        </nav>
        <section className="kv-settings-panel" aria-labelledby="settings-section-heading">
          <h2 id="settings-section-heading" className="kv-settings-heading">{LABELS[section]}</h2>
          {section === "vaults" && <VaultsSection info={info} api={api} identity={identity} />}
          {section === "appearance" && <AppearanceSection info={info} api={api} />}
          {section === "models" && <ModelsSection info={info} api={api} />}
          {section === "conversion" && <ConversionSection info={info} api={api} />}
          {section === "workflows" && <WorkflowsSection onOpen={onOpenWorkflows} />}
          {section === "diagnostics" && <DiagnosticsSection info={info} api={api} />}
          {section === "about" && <AboutSection info={info} api={api} />}
          {section === "identity" && <IdentitySection identity={identity} />}
        </section>
      </div>
    </div>
  );
}
