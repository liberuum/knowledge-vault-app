import { chmodSync, existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSidecarConfig, switchboardEnv } from "./config.js";
import { createControlServer } from "./control.js";
import { converterEnvironment, createConverterManager } from "./converter.js";
import { createIdentity, DEFAULT_RENOWN_URL, defaultIdentityDeps } from "./identity.js";
import { bindLoopbackOnly } from "./loopback.js";
import { checkRemoteVault, parseRemoteVaultInput, readRemoteVaults, RemoteInputError, writeRemoteVaults } from "./remote.js";
import { prepareDataDir } from "./data-dir.js";
import { applyEnvironment, engineEnvironment } from "./environment.js";
import { packageSpecs, switchboardOptions } from "./options.js";
import { fatalLine, readyLine, restartLine, shutdownLine, waitForHealth } from "./ready.js";
import { ensureSecret } from "./secrets.js";
import { singleFlight } from "./single-flight.js";
import { readModelKey, readSettings, readStackVersion, writeSettings, writeStackVersion } from "./settings.js";
import { acquireEngineLock, StoreInUseError } from "./engine-lock.js";
import { readLastAction, runPendingAction, takePending, writeLastAction, writePending } from "./pending.js";
import { cleanPartialBackups, listBackups, recoverInterruptedRestore } from "./backups.js";
import { stopOrphanedHelper } from "./orphans.js";
import { exportVault } from "./export.js";
import { compareStack, TOO_NEW_MESSAGE } from "./store-guard.js";
import { createPipelineManager, mintEngineToken, readPipelines } from "./pipelines.js";
import { fillConnection } from "./connections.js";
import { fetchModelCatalog, probeLocalModels, validateModelEndpoint } from "./models-validate.js";
import { watchParent } from "./parent-watch.js";
import { reapChildren } from "./child-reaper.js";
import { repairQueue, startQueueWatchdog } from "./queue-watchdog.js";

/** When this engine came up: runs that began earlier belong to a previous life of it. */
const ENGINE_STARTED_AT = new Date().toISOString();
import { privateHostAllow, isLocalEndpoint } from "./egress.js";
import type { PipelineTemplate } from "./templates.js";
import { createRequire } from "node:module";
import { createProtectionSwitch } from "./protection.js";
import { authorizedFetch, createEngineTokenProvider } from "./authorized-fetch.js";
import { ensureKyselyMigrationTables } from "./auth-tables.js";
import { createVaultDrive, deleteVaultDrive, ensureWorkflowsDrive, listVaultDrives, NotAVaultError, renameVaultDrive } from "./vaults.js";

// The data-dir storage swap must be registered before the Switchboard (and
// through it @powerhousedao/pglite-fs) is imported — hence the dynamic import below.
// KV_PGLITE_SNAPSHOT_FS=1 keeps the Switchboard's own snapshot filesystem (diagnostics; costs memory).
if (process.env.KV_PGLITE_SNAPSHOT_FS !== "1") register(new URL("./nodefs-hooks.mjs", import.meta.url));

/**
 * The two packages the engine loads, as directories (spec §4.1). The loader
 * resolves a bare name from cwd/node_modules, and the engine runs with cwd =
 * the data dir; a directory needs no cwd and no link into app-data.
 */
const PACKAGE_DIRS = ["@powerhousedao/knowledge-note", "@powerhousedao/workflow"].map((name) =>
  fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)),
);

/** The version in a package directory's manifest, for About and Diagnostics. */
function packageVersion(dir: string): string {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
/** The pipeline template the vault package ships (spec §7.5); a package that predates it yields none. */
function loadPipelineTemplate(): PipelineTemplate | undefined {
  try {
    return createRequire(import.meta.url)("@powerhousedao/knowledge-note/pieces/knowledge-vault/templates/pipeline.json") as PipelineTemplate;
  } catch {
    return undefined;
  }
}
const STACK_VERSION = packageVersion(fileURLToPath(new URL("../node_modules/@powerhousedao/switchboard", import.meta.url)));
const VAULT_PACKAGE_VERSION = packageVersion(PACKAGE_DIRS[0]!);

/** Exit code for a refusal the engine explains on stdout (`fatal` line): the supervisor shows it and does not respawn. */
const EXIT_FATAL = 78;
/** Prints the fatal line, then exits once it has left the process (stdout to a pipe is asynchronous on Windows). */
function fatalExit(reason: string, message: string): Promise<never> {
  console.error(`[sidecar] ${message}`);
  return new Promise(() => process.stdout.write(fatalLine(reason, message) + "\n", () => process.exit(EXIT_FATAL)));
}
/** The last `n` lines of a log file; none when it does not exist yet. */
function tailLines(path: string, n: number): string[] {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const cfg = readSidecarConfig(process.env);
  cfg.dataDir = resolve(cfg.dataDir); // relative values (the dev loop's) resolve against cwd = sidecar/
  // Everything the engine creates — PGlite files, logs, the SDK's .ph — is private to the user.
  process.umask(0o077);
  prepareDataDir(cfg.dataDir);

  // Spec §9 — before anything opens the store, in this order:
  // (1) one engine per data dir; another live engine is a refusal, a dead one's lock is replaced.
  let releaseLock: () => void;
  try {
    releaseLock = acquireEngineLock(cfg.dataDir, process.pid);
  } catch (error) {
    if (error instanceof StoreInUseError) return fatalExit("store-in-use", error.message);
    throw error;
  }
  process.on("exit", () => releaseLock());
  // (2) a restore cut short (a crash, a power cut) is rolled back: the user's store comes back whole.
  const recovered = recoverInterruptedRestore(cfg.dataDir);
  if (recovered) {
    const detail = `The restore of ${recovered.name} was interrupted; your vaults were put back as they were.`;
    console.warn(`[sidecar] ${detail}`);
    writeLastAction(cfg.dataDir, { action: "restore", ok: false, detail, at: new Date().toISOString() });
  }
  // (3) a converter helper left by a killed engine is stopped before a delete-all can lose its record.
  const orphan = stopOrphanedHelper(cfg.dataDir);
  if (orphan !== undefined) console.warn(`[sidecar] stopped an orphaned converter helper (pid ${orphan})`);
  // (4) a backup, restore or delete-all the user asked for runs now, with the store closed.
  const pending = takePending(cfg.dataDir);
  if (pending) {
    const result = runPendingAction(cfg.dataDir, pending, STACK_VERSION, { storeStack: readStackVersion(cfg.dataDir) });
    console.log(`[sidecar] ${pending.action}: ${result.ok ? "done" : "refused"} — ${result.detail}`);
    if (pending.action === "delete-all" && result.ok) {
      prepareDataDir(cfg.dataDir); // the store is fresh again: its folders are recreated (the lock was kept)
      // The supervisor read the protection setting before this ran; the delete-all reset it (and the
      // sign-in). A protected engine restarts so it is spawned open, as the fresh store is.
      if (cfg.protected) {
        console.log("[sidecar] the delete-all reset protection; restarting so the engine opens as a fresh store");
        return new Promise<void>(() => process.stdout.write(restartLine("protection") + "\n", () => process.exit(0)));
      }
    }
  }
  // (5) an interrupted backup is not a backup.
  for (const name of cleanPartialBackups(cfg.dataDir)) console.warn(`[sidecar] removed an incomplete backup: ${name}`);
  // (6) the stack guard: never open a store written by a newer stack; back up before opening one written by an older stack.
  console.log("[sidecar] checking the store"); // a landing start-up stage (host/src/landing/startup-stages.ts)
  const recordedStack = readStackVersion(cfg.dataDir);
  if (STACK_VERSION === "unknown") {
    console.warn("[sidecar] the Switchboard's version is unknown — the store guard is skipped");
  } else {
    const relation = compareStack(STACK_VERSION, recordedStack);
    if (relation === "downgrade") return fatalExit("store-too-new", TOO_NEW_MESSAGE(recordedStack!, STACK_VERSION));
    if (relation === "upgrade") {
      // Labelled with the stack that wrote the store, so the restore guard reads it right.
      const result = runPendingAction(cfg.dataDir, { action: "backup" }, recordedStack!);
      console.log(`[sidecar] upgrading the store from stack ${recordedStack} to ${STACK_VERSION}: backup ${result.ok ? "made" : "refused"} — ${result.detail}`);
      // Spec §9: a migration runs only after that backup. Without one, the store stays as it is.
      if (!result.ok) {
        return fatalExit(
          "backup-failed",
          `Knowledge Vault backs your vaults up before it upgrades them (stack ${recordedStack} → ${STACK_VERSION}), and could not: ${result.detail} Free some space, then try again.`,
        );
      }
    }
  }
  const engineSecrets = {
    workflows: ensureSecret(join(cfg.dataDir, "secrets", "workflows.key")),
    attachmentSigning: ensureSecret(join(cfg.dataDir, "secrets", "attachment-url-signing.key")),
  };
  const configFile = fileURLToPath(new URL("../powerhouse.config.json", import.meta.url));
  // cwd = the data dir, so anything written relative to cwd (the Renown SDK's
  // `./.ph`, the registry cache) lands in app-data, never beside the code.
  process.chdir(cfg.dataDir);
  // The user's identity lives in the engine (spec §4.6). It is created before the
  // engine so that open mode can attribute anonymous callers to the engine's own key.
  const renownUrl = process.env.KV_RENOWN_URL || DEFAULT_RENOWN_URL;
  const secretsDir = join(cfg.dataDir, "secrets");
  const identity = createIdentity(await defaultIdentityDeps(secretsDir, renownUrl), { renownUrl, secretsDir });
  const appDid = await identity.status().then(
    (s) => s.appDid,
    () => "local",
  );
  // Spec §4.2: the engine's environment is the matrix plus an OS/session allowlist. Nothing else is inherited.
  // A model server on the local network needs an egress entry (the runtime refuses private addresses otherwise).
  const lanModelServer = privateHostAllow(readSettings(cfg.dataDir).models.endpoint);
  applyEnvironment(process.env, engineEnvironment(process.env, switchboardEnv(cfg, engineSecrets, appDid, lanModelServer ? [lanModelServer] : [])));

  // A missing package directory would degrade to an engine without the vault (the loader logs a miss and goes on); fail loudly instead.
  for (const dir of PACKAGE_DIRS) {
    if (!existsSync(dir)) throw new Error(`package directory missing: ${dir} (run \`bun install\` in sidecar/)`);
  }
  // Spec §4.4: a store first opened without authentication lacks the auth migrator's tables (auth-tables.ts).
  if (cfg.protected && process.env.KV_PGLITE_SNAPSHOT_FS !== "1") {
    const prepared = await ensureKyselyMigrationTables(join(cfg.dataDir, "read-model"));
    if (prepared.created) console.log("[sidecar] prepared the read-model database for the authorization tables (the store was first opened without authentication)");
  }
  // Spec §4.7: never on the LAN. The Switchboard binds every interface and offers no host option;
  // a listen() for its port that names no host is bound to loopback (see loopback.ts).
  bindLoopbackOnly(cfg.port);
  const { startSwitchboard } = await import("@powerhousedao/switchboard/server");
  const options = switchboardOptions(cfg, configFile, packageSpecs(PACKAGE_DIRS, process.cwd()), renownUrl);
  const switchboard = await startSwitchboard(options);
  // The SDK writes the keypair world-readable; it is a secret.
  if (existsSync(options.identity.keypairPath)) chmodSync(options.identity.keypairPath, 0o600);
  const origin = `http://127.0.0.1:${switchboard.port}`;
  await waitForHealth(`${origin}/health`, { timeoutMs: 60_000, intervalMs: 250 });
  // (5) the store now belongs to this stack.
  if (STACK_VERSION !== "unknown") writeStackVersion(cfg.dataDir, STACK_VERSION);
  /** Announce a restart and stop; whoever spawned us starts us again at once (spec §4.4, §9). */
  const requestRestart = (reason: string): void => {
    setTimeout(() => {
      process.stdout.write(restartLine(reason) + "\n");
      process.kill(process.pid, "SIGINT");
    }, 200).unref();
  };
  // A protected engine answers only authenticated callers; our own management calls carry the
  // administrator's token. An open engine gets plain fetch — no header, the anonymous owner.
  const engineFetch = cfg.protected ? authorizedFetch(createEngineTokenProvider(identity)) : fetch;

  // Plan 4: the conversion helper. The engine is pointed at it through the vault
  // package's runtime setter, published on a well-known global by the convert
  // subgraph's setup — the same process, so no module identity to worry about.
  const convertRegistry = (globalThis as Record<symbol, unknown>)[Symbol.for("@powerhousedao/knowledge-note/convert")] as
    | { setServiceUrl: (url: string | null) => void }
    | undefined;
  if (!convertRegistry) console.warn("[sidecar] the vault package exposes no runtime conversion setter — conversion settings will not reach the engine");
  const converter = createConverterManager({
    dataDir: cfg.dataDir,
    entry: fileURLToPath(new URL("../converter/server.ts", import.meta.url)),
    nodePath: process.execPath,
    env: converterEnvironment(process.env),
    setEngineUrl: (url) => convertRegistry?.setServiceUrl(url),
  });
  void converter
    .apply(readSettings(cfg.dataDir).conversion)
    .catch((error: unknown) => console.error(`[converter] ${error instanceof Error ? error.message : String(error)}`));

  // One create at a time: a React dev double-effect must not make two Workflows drives.
  const workflowsDrive = singleFlight(() => ensureWorkflowsDrive(origin, engineFetch));
  const template = loadPipelineTemplate();
  if (!template) console.warn("[sidecar] the installed vault package ships no pipeline template — vaults will be created without a pipeline");
  const pipelines = createPipelineManager({
    dataDir: cfg.dataDir,
    origin,
    fetchImpl: engineFetch,
    template,
    pieceVersion: VAULT_PACKAGE_VERSION,
    readSettings: () => readSettings(cfg.dataDir),
    readModelKey: () => readModelKey(cfg.dataDir),
    identity: { status: () => identity.status(), token: (expiresIn) => identity.token(expiresIn) },
    workflowsDrive,
    vaultName: async (id) => (await listVaultDrives(origin, engineFetch)).find((v) => v.id === id)?.name ?? "Vault",
    engineProtected: cfg.protected,
  });

  // Studio's Knowledge Vault connections: this engine's address and a token from the sign-in, on request.
  const fillConnectionHere = (connectionId: string, options: { token: boolean }) =>
    fillConnection(
      {
        origin,
        fetchImpl: engineFetch,
        engineToken: () => mintEngineToken({ status: () => identity.status(), token: (expiresIn) => identity.token(expiresIn) }, cfg.protected),
      },
      connectionId,
      options,
    );

  // The port the control server actually binds (it falls back upward when the configured one is busy).
  let boundControlPort = cfg.controlPort;
  const control = createControlServer({
    fillConnection: fillConnectionHere,
    token: cfg.controlToken,
    hostOrigin: cfg.hostOrigin,
    status: () => ({
      ok: true,
      port: switchboard.port,
      controlPort: boundControlPort,
      appVersion: cfg.appVersion,
      protected: cfg.protected,
      adminAddress: cfg.adminAddress ?? null,
      dataDir: cfg.dataDir,
      stackVersion: STACK_VERSION,
      vaultPackageVersion: VAULT_PACKAGE_VERSION,
    }),
    listVaults: () => listVaultDrives(origin, engineFetch),
    createVault: (name) => createVaultDrive(origin, name, engineFetch),
    renameVault: (id, name) => renameVaultDrive(origin, id, name, engineFetch),
    deleteVault: (id) => deleteVaultDrive(origin, id, engineFetch),
    workflowsDrive,
    pipelines,
    repairQueue: (vaultId) => {
      const record = readPipelines(cfg.dataDir)[vaultId];
      if (!record || record.disabled) return Promise.resolve({ requeued: [], dropped: [], skipped: "no pipeline" });
      return repairQueue({ origin, fetchImpl: engineFetch }, vaultId, record.workflowId, { engineStartedAt: ENGINE_STARTED_AT });
    },
    readSettings: () => readSettings(cfg.dataDir),
    writeSettings: (patch) => writeSettings(cfg.dataDir, patch),
    validateModels: () => validateModelEndpoint(readSettings(cfg.dataDir).models.endpoint, readModelKey(cfg.dataDir) ?? ""),
    modelCatalog: (endpoint) => fetchModelCatalog(endpoint ?? readSettings(cfg.dataDir).models.endpoint, readModelKey(cfg.dataDir) ?? ""),
    probeModels: (endpoint) => probeLocalModels(endpoint, (e) => isLocalEndpoint(e) || privateHostAllow(e) !== null),
    // Spec §4.4: the switch writes config.json's `local` section, answers, then the engine shuts down
    // and prints a restart line — whoever spawned it (the shell, the dev loop) starts it again with
    // KV_PROTECTED/KV_ADMIN_ADDRESS read from that section. The Switchboard's auth flags are fixed at
    // start-up, so there is no in-process way to flip them.
    protection: createProtectionSwitch({
      dataDir: cfg.dataDir,
      running: { protected: cfg.protected, adminAddress: cfg.adminAddress ?? null },
      identity: { status: () => identity.status() },
      // After the 202 has gone out: announce the restart and shut down; whoever spawned us
      // starts us again with KV_PROTECTED/KV_ADMIN_ADDRESS read from config.json's local section.
      scheduleRestart: () => requestRestart("protection"),
    }),
    // Spec §9: the action is recorded and runs at the next start, with the store closed.
    maintenance: {
      listBackups: () => listBackups(cfg.dataDir),
      lastAction: () => readLastAction(cfg.dataDir),
      schedule: (action) => {
        writePending(cfg.dataDir, action);
        requestRestart(action.action);
      },
    },
    exportVault: async (id) => {
      if (!(await listVaultDrives(origin, engineFetch)).some((v) => v.id === id)) throw new NotAVaultError("That drive is not a vault.");
      return exportVault({ origin, driveId: id, dataDir: cfg.dataDir, fetchImpl: engineFetch });
    },
    shutdown: () => {
      setTimeout(() => {
        process.stdout.write(shutdownLine() + "\n");
        process.kill(process.pid, "SIGINT");
      }, 200).unref();
    },
    logsTail: () => tailLines(join(cfg.dataDir, "logs", "sidecar.log"), 200),
    debugRoutes: process.env.KV_DEBUG_ROUTES === "1",
    converter: {
      status: () => converter.status(),
      restart: () => converter.restart(),
      install: (component) => converter.install(component),
      remove: (component) => converter.remove(component),
    },
    applyConversion: (settings) => converter.apply(settings),
    auth: {
      status: () => identity.status(),
      startLogin: () => identity.startLogin(),
      cancelLogin: () => identity.cancelLogin(),
      logout: () => identity.logout(),
      token: () => identity.token(),
    },
    remote: {
      list: () => readRemoteVaults(cfg.dataDir),
      check: async (url, drive) => {
        const parsed = parseRemoteVaultInput(url, drive);
        if (!parsed.drive) throw new RemoteInputError("Name the vault: a drive URL (…/d/<slug>) or the drive id or slug.");
        return checkRemoteVault(parsed.origin, parsed.drive, (await identity.token()).token);
      },
      add: async (url, drive) => {
        const parsed = parseRemoteVaultInput(url, drive);
        if (!parsed.drive) throw new RemoteInputError("Name the vault: a drive URL (…/d/<slug>) or the drive id or slug.");
        const checked = await checkRemoteVault(parsed.origin, parsed.drive, (await identity.token()).token);
        const vault = { kind: "remote" as const, id: checked.id, slug: checked.slug, name: checked.name, switchboardUrl: checked.switchboardUrl, addedAt: new Date().toISOString() };
        writeRemoteVaults(cfg.dataDir, [...readRemoteVaults(cfg.dataDir).filter((v) => v.id !== vault.id), vault]);
        return vault;
      },
      remove: (id) => writeRemoteVaults(cfg.dataDir, readRemoteVaults(cfg.dataDir).filter((v) => v.id !== id)),
    },
  });
  const controlPort = await control.listen(cfg.controlPort);
  boundControlPort = controlPort;
  process.stdout.write(readyLine(switchboard.port, controlPort) + "\n");

  // Tasks a failed run left held, or whose source was deleted, would wait forever (queue-watchdog.ts).
  startQueueWatchdog({
    deps: { origin, fetchImpl: engineFetch },
    engineStartedAt: ENGINE_STARTED_AT,
    pipelines: () =>
      Object.entries(readPipelines(cfg.dataDir))
        .filter(([, r]) => !r.disabled)
        .map(([vaultId, r]) => ({ vaultId, workflowId: r.workflowId })),
  });

  // The shell and the dev loop set KV_STDIN_STOP=1 and keep our stdin open:
  // closing it (or writing `stop`) asks for a graceful stop, and SIGINT runs
  // the Switchboard's own shutdown (PGlite flush, drained API). Without the
  // flag stdin is ignored, so a launch with a closed stdin keeps running.
  if (process.env.KV_STDIN_STOP === "1") {
    process.stdin.resume();
    process.stdin.on("end", () => process.kill(process.pid, "SIGINT"));
    process.stdin.on("data", (chunk) => {
      if (String(chunk).trim() === "stop") process.kill(process.pid, "SIGINT");
    });
  }
  // And if whoever spawned us dies without closing the pipe, stop all the same (parent-watch.ts).
  if (process.env.KV_STDIN_STOP === "1") {
    watchParent({
      getPpid: () => process.ppid,
      onGone: () => {
        console.error("[sidecar] the shell is gone; stopping");
        process.kill(process.pid, "SIGINT");
      },
    });
  }
  process.on("SIGINT", () => {
    void converter.stop();
    void control.close();
  });
  // Whatever the engine started and is still running ends with it (child-reaper.ts).
  process.on("exit", () => {
    const reaped = reapChildren();
    if (reaped.length) console.error(`[sidecar] ended ${reaped.length} worker(s) left running at exit`);
  });
}

main().catch((error) => {
  console.error(`[sidecar] failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
