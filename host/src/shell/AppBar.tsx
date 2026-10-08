import type { ReactNode } from "react";
import { GearIcon } from "./icons.js";

/** Inside a workspace or Settings: the one landmark that never moves — back to the vaults, the title, the gear. `children` (the pipeline chip) sit right, before the gear. */
export function AppBar({ title, onBack, onSettings, onGuide, children }: { title: string; onBack: () => void; onSettings?: () => void; /** Back to the setup guide while it is still open for this vault. */ onGuide?: () => void; children?: ReactNode }) {
  return (
    <nav className="kv-appbar" aria-label="App">
      <button type="button" onClick={onBack}>← Vaults</button>
      <span className="kv-appbar-title">{title}</span>
      <span className="kv-appbar-spacer" aria-hidden="true" />
      {onGuide && (
        <button type="button" className="kv-appbar-guide" onClick={onGuide} title="Back to the setup guide">
          Setup guide
        </button>
      )}
      {children}
      {onSettings && (
        <button type="button" className="kv-icon-button kv-appbar-gear" aria-label="Settings" title="Settings" onClick={onSettings}>
          <GearIcon />
        </button>
      )}
    </nav>
  );
}
