import { useState } from "react";

/** A value to copy (a command, an address): its label, the value, and a Copy button. */
export function CopyBlock({ label, value, onCopied }: { label: string; value: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="kv-code">
      <span className="kv-code-label">{label}</span>
      <code className="kv-code-value">{value}</code>
      <button type="button" className="kv-button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}
