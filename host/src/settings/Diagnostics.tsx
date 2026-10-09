import { useEffect, useState } from "react";
import type { SettingsApi } from "../screens/Settings.js";
import type { SidecarInfo } from "../sidecar.js";
import type { EngineStatus } from "../vaults.js";
import { redact } from "../redact.js";
import { invokeIfTauri, isTauri } from "../shell/tauri.js";
import { CopyBlock } from "../shell/CopyBlock.js";

/** The engineering view: what runs where, and how to point the CLI, the plugin and agents at this engine. */
/** What "Copy diagnostics" puts on the clipboard: versions, ports, the data folder and the redacted tail — never a credential. */
export function diagnosticsText(status: EngineStatus, tail: string[]): string {
  return JSON.stringify(
    {
      app: status.appVersion,
      stack: status.stackVersion,
      vaultPackage: status.vaultPackageVersion,
      enginePort: status.port,
      controlPort: status.controlPort,
      protected: status.protected,
      dataDir: redact(status.dataDir),
      lastLines: tail.map((l) => redact(l)),
    },
    null,
    2,
  );
}

export function DiagnosticsSection({ info, api }: { info: SidecarInfo; api: SettingsApi }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [tail, setTail] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    api.fetchStatus(info).then((s) => alive && setStatus(s)).catch((e: Error) => alive && setError(e.message));
    api.fetchLogTail(info).then((lines) => alive && setTail(lines)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, info]);
  async function copyDiagnostics() {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(diagnosticsText(status, tail));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="kv-settings-body">
      {error && <p role="alert" className="kv-error">Could not read the engine's status: {error}</p>}
      {status && (
        <>
          <dl className="kv-facts">
            <dt>Engine</dt><dd>Ready on port {status.port}; control on {status.controlPort}</dd>
            <dt>Local vaults</dt><dd>{status.protected ? "Protected — sign-in required" : "Open on this computer"}</dd>
            <dt>Data folder</dt><dd><code>{status.dataDir}</code></dd>
            <dt>Versions</dt><dd>app {status.appVersion} · stack {status.stackVersion} · vault package {status.vaultPackageVersion}</dd>
          </dl>
          <h3 className="kv-settings-subheading">Connect your tools</h3>
          <p className="kv-quiet">The Switchboard CLI, the knowledge plugin and MCP agents work against this engine like against any vault server.</p>
          <CopyBlock label="Switchboard CLI" value={`switchboard init --url ${info.origin}/graphql --name local-vault --use-profile`} />
          <CopyBlock label="MCP" value={`${info.origin}/mcp`} />
          <CopyBlock label="GraphQL" value={info.graphqlUrl} />
          <h3 className="kv-settings-subheading">The engine's last lines</h3>
          {tail.length === 0 ? (
            <p className="kv-quiet">Nothing logged yet — the app records the engine's output when it runs it.</p>
          ) : (
            <pre className="kv-log-tail" aria-label="The engine's last lines">{tail.map((l) => redact(l)).join("\n")}</pre>
          )}
          <div className="kv-form-actions">
            <button type="button" className="kv-button" onClick={() => void copyDiagnostics()}>{copied ? "Copied" : "Copy diagnostics"}</button>
            {isTauri() && <button type="button" className="kv-button" onClick={() => void invokeIfTauri("open_logs")}>Open logs</button>}
            <span className="kv-hint">Versions, ports, the data folder and these lines — credentials removed.</span>
          </div>
        </>
      )}
    </div>
  );
}
