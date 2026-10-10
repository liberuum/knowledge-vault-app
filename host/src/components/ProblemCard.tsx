import { useId } from "react";
import type { Problem, ProblemAction } from "../problem.js";
import "./problem.css";

const LABELS: Record<ProblemAction, string> = { retry: "Try again", signin: "Sign in", resignin: "Sign in again", back: "Back to vaults" };

/**
 * A screen that could not open, said plainly: what happened, what to do, and the buttons that do
 * it. An action shows only when the screen can perform it; the first one shown is the main one.
 */
export function ProblemCard({
  problem,
  handlers,
  status,
  busy = false,
}: {
  problem: Problem;
  handlers: Partial<Record<ProblemAction, () => void>>;
  /** Something under way (a retry, a sign-in in the browser), said under the steps. */
  status?: string;
  /** The buttons wait (a retry is running). */
  busy?: boolean;
}) {
  const id = useId();
  const shown = problem.actions.filter((a) => handlers[a]);
  const tone = problem.kind === "signin-needed" || problem.kind === "signin-refused" ? "accent" : "attention";
  return (
    <section className="kv-problem" data-tone={tone} role="alert" aria-labelledby={`${id}-title`}>
      <span className="kv-problem-icon" aria-hidden="true">
        {tone === "accent" ? (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5.5" />
            <path d="M12 16.5h.01" />
          </svg>
        )}
      </span>
      <div className="kv-problem-content">
        <h2 id={`${id}-title`}>{problem.title}</h2>
        <p className="kv-problem-body">{problem.body}</p>
        {problem.steps.length > 0 && (
          <ol className="kv-problem-steps" aria-label="What to do">
            {problem.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        {status && (
          <p role="status" className="kv-problem-status">
            {status}
          </p>
        )}
        {shown.length > 0 && (
          <div className="kv-problem-actions">
            {shown.map((action, i) => (
              <button key={action} type="button" className={i === 0 ? "kv-button kv-button-primary" : "kv-button"} disabled={busy} onClick={handlers[action]}>
                {LABELS[action]}
              </button>
            ))}
          </div>
        )}
        <details className="kv-problem-details">
          <summary>Technical details</summary>
          <code>{problem.details}</code>
        </details>
      </div>
    </section>
  );
}
