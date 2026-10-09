import { spawn as nodeSpawn } from "node:child_process";
import { clearHelperPid, stopOrphanedHelper, writeHelperPid } from "./orphans.js";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { installBinding, installedBinding, removeBinding, type BindingManifest, type InstallProgress } from "./converter/install.js";
import { installModels, modelsInstalled, removeModels, type ModelsProgress } from "./converter/models.js";
import { platformTriple, type PlatformTriple } from "./converter/platform.js";
import { engineEnvironment } from "./environment.js";
import type { ConversionSettings } from "./settings.js";

/**
 * The conversion helper (Plan 4): the user's docling service, vendored into
 * sidecar/converter/, run by this process's own node as a child on a free
 * loopback port. It starts with nothing installed (text PDFs, Markdown, plain
 * text) and grows as the binding and models are installed (Stage B). The
 * engine is pointed at it — or at another server, or at nothing — through the
 * vault package's runtime setter, so switching needs no engine restart.
 *
 * Supervision is deliberately small: one automatic restart; a second death
 * inside the window leaves the helper `down` with its exit code and clears the
 * engine's URL, so health says "no converter" rather than timing out.
 */
export type ConverterState = "off" | "starting" | "ready" | "down";

export type ConverterStatus = {
  mode: ConversionSettings["mode"];
  /** The local helper's state; `off` also while another server or nothing is used. */
  state: ConverterState;
  /** What the engine is pointed at right now: the helper, the remote server, or nothing. */
  url: string | null;
  localUrl: string | null;
  pid: number | null;
  exitCode: number | null;
  restarts: number;
  logPath: string;
  /** The active service's own health answer, when it could be reached. */
  health: Record<string, unknown> | null;
  error: string | null;
  /** Stage B: what is installed in app-data, and what this machine could install. */
  installed: {
    binding: { installed: boolean; version: string | null; supported: boolean; platform: PlatformTriple | null; reason: string | null };
    models: { installed: boolean; supported: boolean; reason: string | null };
  };
  /** The install in progress, or the last one until the next starts. */
  job: InstallJob | null;
};

export type ConverterComponent = "binding" | "models";
export type InstallJob = {
  component: ConverterComponent;
  phase: "downloading" | "verifying" | "extracting" | "fetching" | "done" | "failed";
  percent: number | null;
  bytes: number;
  total: number | null;
  message: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** The install/remove primitives, injectable for tests. */
export type Installer = {
  installBinding(onProgress: (p: InstallProgress) => void): Promise<BindingManifest>;
  installModels(onProgress: (p: ModelsProgress) => void): Promise<void>;
  removeBinding(): void;
  removeModels(): void;
  bindingInstalled(): BindingManifest | null;
  modelsInstalled(): boolean;
};

/** Another install is running (the control API answers 409). */
export class ConverterBusyError extends Error {}
/** A component this machine cannot install, or an order it does not allow (400). */
export class ConverterInputError extends Error {}

export type ConverterChild = {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on?(event: "error", listener: (error: Error) => void): unknown;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
};

export type ConverterDeps = {
  dataDir: string;
  /** The vendored service's entry (sidecar/converter/server.ts); node strips its types. */
  entry: string;
  nodePath: string;
  /** What the helper inherits — see converterEnvironment(). */
  env: Record<string, string>;
  /** The vault package's runtime setter (null: no converter). */
  setEngineUrl: (url: string | null) => void;
  spawn?: (cmd: string, args: string[], opts: { env: Record<string, string>; stdio: ["ignore", "pipe", "pipe"] }) => ConverterChild;
  fetchImpl?: typeof fetch;
  pickPort?: () => Promise<number>;
  log?: (line: string) => void;
  now?: () => number;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  restartWindowMs?: number;
  stopTimeoutMs?: number;
  /** Which binding this machine can install; detected when absent. */
  platform?: { triple: PlatformTriple | null; reason: string | null };
  installer?: Installer;
  registry?: string;
  /** For the models' tool check (sh, curl, tar) and the Windows gate; detected when absent. */
  platformName?: NodeJS.Platform;
  toolsMissing?: (names: string[]) => string[];
};

/** The helper inherits the OS/session allowlist only — none of the engine's matrix, none of our KV_* config. */
export function converterEnvironment(inherited: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env = engineEnvironment(inherited, {});
  for (const key of Object.keys(env)) if (key.startsWith("KV_")) delete env[key];
  // macOS: an app opened from Finder gets a PATH without Homebrew's, so its OCR tools (tesseract, qpdf, gs) go unseen.
  if (platform === "darwin" && !(env.PATH ?? "").split(":").includes("/opt/homebrew/bin")) env.PATH = [env.PATH, "/opt/homebrew/bin"].filter(Boolean).join(":");
  return env;
}

export function createConverterManager(deps: ConverterDeps) {
  const spawnImpl: NonNullable<ConverterDeps["spawn"]> =
    deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts) as unknown as ConverterChild);
  // A previous engine that died by SIGKILL left its helper running: stop it before starting ours.
  const orphan = stopOrphanedHelper(deps.dataDir);
  if (orphan !== undefined) console.warn(`[converter] stopped an orphaned helper (pid ${orphan}) left by a previous engine`);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const pickPort = deps.pickPort ?? freePort;
  const log = deps.log ?? ((line: string) => console.log(`[converter] ${line}`));
  const now = deps.now ?? Date.now;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 30_000;
  const readyIntervalMs = deps.readyIntervalMs ?? 200;
  const restartWindowMs = deps.restartWindowMs ?? 30_000;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5_000;
  const logPath = join(deps.dataDir, "logs", "converter.log");
  const converterDir = join(deps.dataDir, "converter");
  const modulesDir = join(converterDir, "node_modules");
  const modelsDir = join(converterDir, "models");
  // Shipped beside this file (src/ in tests, dist/ when built): resolves `docling.rs` to the installed binding inside the helper.
  // A file URL, not a path: `--import` takes a module specifier, and on Windows a bare
  // `C:\…` path is read as a URL with protocol `c:` and refused, so the helper never started
  // there and the intake showed conversion as unavailable.
  const hooksUrl = new URL("./converter-hooks.mjs", import.meta.url).href;
  const platform = deps.platform ?? platformTriple();
  const installer: Installer = deps.installer ?? {
    installBinding: (onProgress) => installBinding({ dir: converterDir, triple: platform.triple ?? "", registry: deps.registry, onProgress }),
    installModels: (onProgress) =>
      installModels({ modelsDir, script: join(dirname(deps.entry), "fetch-models.mjs"), hooks: hooksUrl, modulesDir, nodePath: deps.nodePath, env: deps.env, onProgress }),
    removeBinding: () => removeBinding(converterDir),
    removeModels: () => removeModels(modelsDir),
    bindingInstalled: () => installedBinding(converterDir),
    modelsInstalled: () => modelsInstalled(modelsDir),
  };
  let job: InstallJob | null = null;
  let starting: Promise<void> | null = null;
  const platformName = deps.platformName ?? process.platform;
  const toolsMissing = deps.toolsMissing ?? ((names: string[]) => missingOnPath(names));
  /**
   * Linux and macOS run upstream's pinned shell script, which needs `sh`, `curl` and `tar`; Windows
   * downloads in Node (converter/fetch-node.mjs) and needs nothing else.
   */
  const modelsSupport = (): { supported: boolean; reason: string | null } => {
    if (platformName === "win32") return { supported: true, reason: null };
    const missing = toolsMissing(["sh", "curl", "tar"]);
    return missing.length ? { supported: false, reason: `Installing the PDF models needs ${missing.join(", ")} on this computer.` } : { supported: true, reason: null };
  };

  let mode: ConversionSettings["mode"] = "off";
  let remoteUrl = "";
  let state: ConverterState = "off";
  let child: ConverterChild | null = null;
  let localUrl: string | null = null;
  let exitCode: number | null = null;
  let restarts = 0;
  let lastStartAt = 0;
  let stopping = false;
  let error: string | null = null;
  let logStream: WriteStream | null = null;
  let generation = 0;

  /**
   * One start at a time: a second caller joins the one in flight. If that one
   * was cancelled by a stop() meanwhile and local mode is wanted again, the
   * caller starts afresh instead of inheriting a start that spawned nothing.
   */
  async function start(): Promise<void> {
    for (;;) {
      if (child) return;
      if (starting) {
        await starting.catch(() => undefined);
        if (child || state === "down" || mode !== "local") return;
        continue;
      }
      if (mode !== "local") return;
      const run = startNow().finally(() => {
        starting = null;
      });
      starting = run;
      return run;
    }
  }

  async function startNow(): Promise<void> {
    const gen = ++generation;
    state = "starting";
    error = null;
    exitCode = null;
    const port = await pickPort();
    // A stop() or a mode change while the port was being picked wins: nothing is spawned.
    if (gen !== generation || mode !== "local") {
      if (state === "starting") state = "off";
      return;
    }
    const url = `http://127.0.0.1:${port}`;
    mkdirSync(join(deps.dataDir, "logs"), { recursive: true });
    const proc = spawnImpl(deps.nodePath, ["--import", hooksUrl, deps.entry], {
      env: {
        ...deps.env,
        CONVERTER_MODULES_DIR: modulesDir,
        CONVERT_SERVICE_HOST: "127.0.0.1",
        CONVERT_SERVICE_PORT: String(port),
        DOCLING_RS_HOME: join(deps.dataDir, "converter", "models"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    if (proc.pid) writeHelperPid(deps.dataDir, proc.pid);
    lastStartAt = now();
    appendFileSync(logPath, `--- ${new Date(now()).toISOString()} start pid ${proc.pid ?? "?"} port ${port}\n`);
    logStream ??= createWriteStream(logPath, { flags: "a" });
    proc.stdout?.pipe(logStream, { end: false });
    proc.stderr?.pipe(logStream, { end: false });
    proc.once("exit", (code) => {
      if (gen !== generation) return; // an older child's exit, after a restart or a stop
      onExit(code);
    });
    proc.on?.("error", (spawnError) => {
      if (gen !== generation) return;
      child = null;
      clearHelperPid(deps.dataDir);
      localUrl = null;
      state = "down";
      error = `the converter could not start: ${spawnError.message}`;
      log(error);
      deps.setEngineUrl(null);
    });
    const deadline = now() + readyTimeoutMs;
    while (child === proc) {
      let ok = false;
      try {
        ok = (await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).ok;
      } catch {
        // not listening yet
      }
      if (child !== proc) return; // stopped while we were asking
      if (ok) {
        localUrl = url;
        state = "ready";
        if (mode === "local") deps.setEngineUrl(url);
        log(`ready at ${url} (pid ${proc.pid ?? "?"})`);
        return;
      }
      if (now() >= deadline) {
        error = `the converter did not answer within ${Math.round(readyTimeoutMs / 1000)} s`;
        log(error);
        generation++; // its exit is no longer "unexpected"
        proc.kill("SIGKILL");
        child = null;
        state = "down";
        deps.setEngineUrl(null);
        return;
      }
      await sleep(readyIntervalMs);
    }
  }

  function onExit(code: number | null): void {
    child = null;
    clearHelperPid(deps.dataDir);
    localUrl = null;
    exitCode = code;
    if (stopping) {
      state = "off";
      return;
    }
    if (now() - lastStartAt > restartWindowMs) restarts = 0; // it ran long enough to be forgiven
    if (restarts < 1) {
      restarts += 1;
      log(`exited with code ${code ?? "null"}; restarting once`);
      deps.setEngineUrl(null); // not a dead port while it comes back; start() points the engine again when ready
      void start();
      return;
    }
    state = "down";
    error = `the converter exited with code ${code ?? "null"} twice within ${Math.round(restartWindowMs / 1000)} s`;
    log(error);
    deps.setEngineUrl(null);
  }

  async function stop(): Promise<void> {
    generation++; // a start still picking its port spawns nothing; the current child's exit is ours to handle here
    const proc = child;
    if (!proc) {
      // Nothing spawned yet: let a start that is picking its port notice the bump and finish.
      if (starting) await starting.catch(() => undefined);
      if (state !== "down") state = "off";
      return;
    }
    stopping = true;
    child = null; // the ready poll, if still running, stops at its next look instead of waiting out its deadline
    localUrl = null;
    let exited = false;
    const exit = new Promise<void>((resolve) =>
      proc.once("exit", () => {
        exited = true;
        resolve();
      }),
    );
    proc.kill("SIGTERM");
    const forced = sleep(stopTimeoutMs).then(() => {
      if (!exited) proc.kill("SIGKILL");
    });
    await Promise.race([exit, forced.then(() => exit)]);
    if (starting) await starting.catch(() => undefined);
    stopping = false;
    state = "off";
  }

  async function apply(settings: ConversionSettings): Promise<void> {
    mode = settings.mode;
    remoteUrl = settings.remoteUrl;
    if (mode === "local") {
      restarts = 0;
      if (child) {
        if (state === "ready" && localUrl) deps.setEngineUrl(localUrl);
        return;
      }
      await start();
      return;
    }
    await stop();
    deps.setEngineUrl(mode === "remote" ? remoteUrl || null : null);
  }

  async function restart(): Promise<ConverterStatus> {
    restarts = 0;
    error = null;
    await stop();
    if (mode === "local") await start();
    return status();
  }

  const jobActive = (): boolean => job !== null && job.phase !== "done" && job.phase !== "failed";
  /** The install in progress, to wait on: the automatic installs run one after the other. */
  let running: Promise<void> = Promise.resolve();
  const mb = (bytes: number): string => (bytes / 1_048_576).toFixed(bytes > 100 * 1_048_576 ? 0 : 1);

  /** Start installing a component; the job runs on, `status()` reports it. */
  async function install(component: string): Promise<ConverterStatus> {
    if (component !== "binding" && component !== "models") throw new ConverterInputError("Unknown component.");
    if (jobActive()) throw new ConverterBusyError(`Already installing the ${job!.component}.`);
    if (component === "binding" && !platform.triple) throw new ConverterInputError(platform.reason ?? "No converter binding for this platform.");
    if (component === "models" && !installer.bindingInstalled()) throw new ConverterInputError("Install the converter's binding first — it is what reads and verifies the models.");
    if (component === "models" && !modelsSupport().supported) throw new ConverterInputError(modelsSupport().reason ?? "The models cannot be installed on this computer.");
    const started: InstallJob = {
      component,
      phase: component === "binding" ? "downloading" : "fetching",
      percent: null,
      bytes: 0,
      total: null,
      message: component === "binding" ? "Starting the download…" : "Fetching the models…",
      error: null,
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
    };
    job = started;
    running = runInstall(started);
    return status();
  }

  async function runInstall(current: InstallJob): Promise<void> {
    try {
      if (current.component === "binding") {
        await installer.installBinding((p) => {
          if (job !== current) return;
          if (p.phase === "downloading") {
            current.phase = "downloading";
            current.bytes = p.bytes ?? current.bytes;
            current.total = p.total ?? current.total;
            current.percent = p.total && p.bytes !== undefined ? Math.min(100, Math.round((100 * p.bytes) / p.total)) : null;
            current.message = `Downloading ${p.file ?? "the binding"} — ${current.percent === null ? `${mb(current.bytes)} MB` : `${current.percent} %`}`;
          } else if (p.phase === "verifying" || p.phase === "extracting") {
            current.phase = p.phase;
            current.message = `${p.phase === "verifying" ? "Verifying" : "Unpacking"} ${p.file ?? "the binding"}…`;
          } else if (p.phase === "metadata") {
            current.message = `Looking up ${p.file ?? "the binding"}…`;
          }
        });
        finish(current, "Installed.");
        log("binding installed");
        // The helper probes the binding once per process: restart it so it loads what was just installed.
        if (mode === "local") await restart();
      } else {
        await installer.installModels((p) => {
          if (job !== current) return;
          current.bytes = p.bytes;
          current.message = p.file ? `Fetching ${basename(p.file)} — ${mb(p.bytes)} MB so far` : `Fetching the models — ${mb(p.bytes)} MB so far`;
        });
        finish(current, "Installed.");
        log("models installed");
        if (mode === "local" && child) await restart(); // a warm pipeline without the models on disk would be wrong
      }
    } catch (error) {
      current.phase = "failed";
      current.error = error instanceof Error ? error.message : String(error);
      current.finishedAt = new Date(now()).toISOString();
      log(`install ${current.component} failed: ${current.error}`);
    }
  }

  function finish(current: InstallJob, message: string): void {
    current.phase = "done";
    current.percent = 100;
    current.message = message;
    current.finishedAt = new Date(now()).toISOString();
  }

  /** Remove a component; the helper restarts so it drops what it had loaded (memory included). */
  async function remove(component: string): Promise<ConverterStatus> {
    if (component !== "binding" && component !== "models") throw new ConverterInputError("Unknown component.");
    if (jobActive()) throw new ConverterBusyError(`Already installing the ${job!.component}.`);
    const wasRunning = child !== null;
    if (wasRunning) await stop();
    if (component === "binding") installer.removeBinding();
    else installer.removeModels();
    job = null;
    if (mode === "local" && wasRunning) await start();
    return status();
  }

  /**
   * Install what is missing on its own: the binding, then the models (they need it), so a new
   * vault reads PDFs and Office files without a trip to Settings. Skips a component the user
   * removed, one this machine cannot install, and everything unless conversion runs on this
   * computer. A failure is logged and left for Settings, where Install says why.
   */
  async function autoInstall(removed: ReadonlyArray<"binding" | "models"> = []): Promise<Array<"binding" | "models">> {
    const done: Array<"binding" | "models"> = [];
    if (mode !== "local") return done;
    const attempt = async (component: "binding" | "models"): Promise<void> => {
      if (removed.includes(component)) return;
      if (component === "binding" ? installer.bindingInstalled() !== null : installer.modelsInstalled()) return;
      if (component === "binding" && !platform.triple) return;
      if (component === "models" && (installer.bindingInstalled() === null || !modelsSupport().supported)) return;
      await running; // never two jobs at once
      if (jobActive()) return;
      log(`installing the ${component} on its own (first use)`);
      await install(component);
      await running;
      if (job?.component === component && job.phase === "done") done.push(component);
    };
    try {
      await attempt("binding");
      await attempt("models");
    } catch (error) {
      log(`automatic install stopped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return done;
  }

  async function status(): Promise<ConverterStatus> {
    const url = mode === "local" ? localUrl : mode === "remote" ? remoteUrl || null : null;
    let health: Record<string, unknown> | null = null;
    if (url && (mode === "remote" || state === "ready")) {
      try {
        const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(2_500) });
        health = (await res.json()) as Record<string, unknown>;
      } catch {
        health = null;
      }
    }
    const manifest = installer.bindingInstalled();
    return {
      mode,
      state,
      url,
      localUrl,
      pid: child?.pid ?? null,
      exitCode,
      restarts,
      logPath,
      health,
      error,
      installed: {
        binding: { installed: manifest !== null, version: manifest?.version ?? null, supported: platform.triple !== null, platform: platform.triple, reason: platform.reason },
        models: { installed: installer.modelsInstalled(), ...modelsSupport() },
      },
      job,
    };
  }

  return { apply, start, stop, restart, status, install, remove, autoInstall };
}

export type ConverterManager = ReturnType<typeof createConverterManager>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** Which of these tools are not on PATH (an executable file in a PATH dir; Windows also tries .exe/.cmd/.bat). */
export function missingOnPath(names: string[], pathVar: string = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): string[] {
  const dirs = pathVar.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return names.filter((name) => !dirs.some((dir) => exts.some((ext) => existsSync(join(dir, name + ext)))));
}

/** A free loopback port: bind 0, read it back, release it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}
