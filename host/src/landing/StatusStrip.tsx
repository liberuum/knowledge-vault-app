import { redact } from "../redact.js";
import type { FatalInfo } from "../sidecar.js";

export type EngineState =
  | { state: "starting"; preparing?: boolean; /** The start-up stage under way (startup-stages.ts), for the strip's detail. */ stage?: string }
  | { state: "ready" }
  | { state: "restarting"; attempt: number; delayMs: number | null }
  | { state: "gave_up"; code: number | null; logTail: string[]; fatal: FatalInfo | null }
  | { state: "exited"; code: number | null; fatal?: FatalInfo }
  | { state: "stopping" }
  | { state: "failed"; detail: string };

/** The strip's two lines for each state (spec §9): what happened, then what to do. */
function copy(engine: EngineState): { label: string; detail: string } {
  switch (engine.state) {
    case "starting": {
      const label = "Starting the engine…";
      // The stage under way, unless it would only repeat the label (the very first moments).
      const stage = engine.stage && engine.stage !== label ? engine.stage : undefined;
      return { label, detail: stage ?? (engine.preparing ? "Unpacking the engine (first start of this version)." : "Opening your store.") };
    }
    case "ready":
      return { label: "Ready", detail: "" };
    case "restarting":
      return { label: "Restarting the engine…", detail: `It stopped unexpectedly. Attempt ${engine.attempt} of 3; back in a moment.` };
    case "gave_up":
      return {
        label: "The engine keeps stopping",
        detail: engine.fatal ? engine.fatal.message : "It stopped several times in a row. Its last lines are below. Try again, or quit from the tray and start the app again.",
      };
    case "exited":
      return engine.fatal
        ? { label: "The engine refused to start", detail: engine.fatal.message }
        : { label: "The engine stopped", detail: `Exit code ${engine.code ?? "unknown"}. Restart the app; if it happens again, start it from a terminal to see the engine's output.` };
    case "stopping":
      return { label: "Stopping the engine…", detail: "Saving your store." };
    case "failed":
      return { label: "The app could not reach the engine", detail: `${engine.detail}. Restart the app.` };
  }
}

const TROUBLE = new Set<EngineState["state"]>(["exited", "failed", "gave_up"]);

/** The landing's bottom landmark: the engine's state, the privacy sentence, the version. */
export function StatusStrip({ engine, version, onRetry }: { engine: EngineState; version?: string; /** The shell's "start the engine again" (absent in a browser). */ onRetry?: () => void }) {
  const trouble = TROUBLE.has(engine.state);
  const { label, detail } = copy(engine);
  const tail = engine.state === "gave_up" ? engine.logTail : [];
  return (
    <footer className="kv-strip" data-state={engine.state} role={trouble ? "alert" : "status"}>
      <div className="kv-strip-inner">
        <span className="kv-dot" aria-hidden="true" />
        <span className="kv-strip-state">{label}</span>
        {detail && <span className="kv-strip-detail">{detail}</span>}
        {onRetry && (engine.state === "gave_up" || engine.state === "exited") && (
          <button type="button" className="kv-button" onClick={onRetry}>Try again</button>
        )}
        {!trouble && (
          <span className="kv-strip-privacy">
            Everything stays on this computer unless you connect a remote vault, a model provider or a converter.
          </span>
        )}
        {version && <span className="kv-strip-version">{version}</span>}
      </div>
      {tail.length > 0 && (
        <pre className="kv-strip-tail" aria-label="The engine's last lines">
          {tail.map((line, i) => (
            <span key={i}>{redact(line)}{"\n"}</span>
          ))}
        </pre>
      )}
    </footer>
  );
}
