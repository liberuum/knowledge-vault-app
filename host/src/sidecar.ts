export type SidecarInfo = { origin: string; graphqlUrl: string; controlOrigin: string; controlToken: string };

/** The engine refused to start and said why (`store-too-new`, `store-in-use`). */
export type FatalInfo = { reason: string; message: string };

/**
 * What the host knows about the engine (spec §9): starting (no readiness line yet), ready,
 * restarting after a crash (attempt n, back in delayMs), gave up after a crash loop or a
 * refusal, exited, or being stopped by the shell.
 */
export type SidecarStatus =
  /** `preparing`: Windows' first launch of a version, the engine archive is being unpacked. */
  | { state: "starting"; preparing?: boolean }
  | { state: "ready"; info: SidecarInfo }
  | { state: "restarting"; attempt: number; delayMs: number | null }
  | { state: "gave_up"; code: number | null; logTail: string[]; fatal: FatalInfo | null }
  | { state: "exited"; code: number | null; fatal?: FatalInfo }
  | { state: "stopping" }
  /** The shell's API could not be reached at all (import, listen or invoke failed). */
  | { state: "failed"; detail: string };

/** The shell's `sidecar_info` answer and its `sidecar:status` payload (src-tauri/src/sidecar.rs `SidecarStatus`). */
export type ShellStatus = {
  state: "starting" | "ready" | "restarting" | "gave_up" | "exited" | "stopping";
  ready: { port: number; controlPort: number; controlToken: string } | null;
  code: number | null;
  attempt?: number;
  delayMs?: number | null;
  fatal?: FatalInfo | null;
  logTail?: string[];
  preparing?: boolean;
};

export function sidecarOrigins(port: number, controlPort: number) {
  const origin = `http://127.0.0.1:${port}`;
  return { origin, graphqlUrl: `${origin}/graphql`, controlOrigin: `http://127.0.0.1:${controlPort}` };
}

export function statusFromShell(raw: ShellStatus): SidecarStatus {
  if (raw.state === "ready" && raw.ready) {
    return { state: "ready", info: { ...sidecarOrigins(raw.ready.port, raw.ready.controlPort), controlToken: raw.ready.controlToken } };
  }
  if (raw.state === "restarting") return { state: "restarting", attempt: raw.attempt ?? 1, delayMs: raw.delayMs ?? null };
  if (raw.state === "gave_up") return { state: "gave_up", code: raw.code ?? null, logTail: raw.logTail ?? [], fatal: raw.fatal ?? null };
  if (raw.state === "exited") return raw.fatal ? { state: "exited", code: raw.code ?? null, fatal: raw.fatal } : { state: "exited", code: raw.code ?? null };
  if (raw.state === "stopping") return { state: "stopping" };
  return raw.preparing ? { state: "starting", preparing: true } : { state: "starting" };
}

export type LogWatcher = (onLine: (line: string) => void) => () => void;

/**
 * Under Tauri: every engine output line the shell forwards while the engine starts
 * (`sidecar:log`), for the landing's start-up stages. In a browser the engine is already up.
 */
export const watchSidecarLog: LogWatcher = (onLine) => {
  if (!inTauri()) return () => {};
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const off = await listen<string>("sidecar:log", (event) => {
      if (!stopped) onLine(event.payload);
    });
    if (stopped) off();
    else unlisten = off;
  })();
  return () => {
    stopped = true;
    unlisten?.();
  };
};

export type StatusWatcher = (onStatus: (status: SidecarStatus) => void) => () => void;

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Under Tauri: every `sidecar:status` the shell emits, plus its current answer
 * (the event may have fired before we listened). In a browser (the dev loop):
 * ready at once, from Vite's env.
 */
export const watchSidecar: StatusWatcher = (onStatus) => {
  if (!inTauri()) {
    const port = Number(import.meta.env.VITE_SIDECAR_PORT ?? 4201);
    const controlPort = Number(import.meta.env.VITE_CONTROL_PORT ?? 4202);
    onStatus({ state: "ready", info: { ...sidecarOrigins(port, controlPort), controlToken: import.meta.env.VITE_CONTROL_TOKEN ?? "dev-token" } });
    return () => {};
  }
  let stopped = false;
  let unlisten: (() => void) | undefined;
  let sawEvent = false;
  void (async () => {
    try {
      const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
      const off = await listen<ShellStatus>("sidecar:status", (event) => {
        sawEvent = true;
        if (!stopped) onStatus(statusFromShell(event.payload));
      });
      if (stopped) {
        off(); // cleaned up while we were subscribing
        return;
      }
      unlisten = off;
      const now = await invoke<ShellStatus>("sidecar_info");
      // An event delivered meanwhile is newer than this snapshot; the snapshot must never win.
      if (!stopped && !sawEvent) onStatus(statusFromShell(now));
    } catch (error) {
      if (!stopped) onStatus({ state: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  })();
  return () => {
    stopped = true;
    unlisten?.();
  };
};
