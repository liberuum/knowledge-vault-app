import type { ReactNode } from "react";

/** A reassurance that sits under a decision (Six Minds, Emotion): a small lock, then the promise. */
export function LockNote({ children }: { children: ReactNode }) {
  return (
    <p className="kv-onb-assure">
      <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      <span>{children}</span>
    </p>
  );
}
