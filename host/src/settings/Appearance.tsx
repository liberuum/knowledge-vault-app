import { useTheme } from "@powerhousedao/reactor-browser";
import { useEffect, useState } from "react";
import type { SettingsApi } from "../screens/Settings.js";
import type { SidecarInfo } from "../sidecar.js";
import { plainError } from "../problem.js";

const OPTIONS = [
  { value: "dark", label: "Dark", hint: "The default — the vault's own theme." },
  { value: "light", label: "Light", hint: "" },
  { value: "system", label: "System", hint: "Follows the operating system." },
] as const;

/** Dark / Light / System — written where reactor-browser reads it, so the vault app follows at once. */
export function AppearanceSection({ info, api }: { info: SidecarInfo; api: SettingsApi }) {
  const { theme, isSystem, setTheme } = useTheme();
  const current = isSystem ? "system" : theme;
  // Spec §5.8: closing the window hides it to the tray and the engine keeps serving the CLI and agents.
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.fetchSettings(info).then((s) => alive && setCloseToTray(s.ui?.closeToTray !== false)).catch(() => alive && setCloseToTray(true));
    return () => {
      alive = false;
    };
  }, [api, info]);
  async function toggle(next: boolean) {
    setError(null);
    setCloseToTray(next);
    try {
      const saved = await api.saveSettings(info, { ui: { closeToTray: next } });
      setCloseToTray(saved.ui?.closeToTray !== false);
    } catch (e) {
      setCloseToTray(!next);
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="kv-settings-body">
      <p className="kv-settings-lead">The app and the vaults share one theme.</p>
      <fieldset className="kv-choice-group">
        <legend className="kv-visually-hidden">Theme</legend>
        {OPTIONS.map((o) => (
          <label key={o.value} className="kv-choice" data-selected={current === o.value}>
            <input type="radio" name="theme" value={o.value} checked={current === o.value} onChange={() => setTheme(o.value)} />
            <span className="kv-choice-label">{o.label}</span>
            {o.hint && <span className="kv-choice-hint">{o.hint}</span>}
          </label>
        ))}
      </fieldset>
      <h3 className="kv-settings-subheading">Window</h3>
      <label className="kv-check">
        <input type="checkbox" checked={closeToTray ?? true} disabled={closeToTray === null} onChange={(e) => void toggle(e.target.checked)} />
        Keep the engine running when the window closes
      </label>
      <p className="kv-hint">The app stays in the tray, so the Switchboard CLI, the plugin and agents keep working. Quit from the tray to stop everything.</p>
      {error && <p role="alert" className="kv-error">{plainError(error)}</p>}
    </div>
  );
}
