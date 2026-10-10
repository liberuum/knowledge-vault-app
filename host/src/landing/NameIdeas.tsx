import { NAME_IDEAS } from "./vault-name.js";
import "./name-ideas.css";

/**
 * Names to start from (Six Minds, Decision: a blank name is a small blank page); one click fills the field, which
 * stays editable. The same on every form that makes a vault: the landing's, the Add a vault dialog, the setup guide.
 */
export function NameIdeas({ value, onPick, disabled }: { value: string; onPick: (name: string) => void; disabled?: boolean }) {
  return (
    <div className="kv-name-ideas" role="group" aria-label="Name ideas">
      <span className="kv-name-ideas-label">Ideas:</span>
      {NAME_IDEAS.map((idea) => (
        <button key={idea} type="button" className="kv-name-idea" aria-pressed={value === idea} onClick={() => onPick(idea)} disabled={disabled}>
          {idea}
        </button>
      ))}
    </div>
  );
}
