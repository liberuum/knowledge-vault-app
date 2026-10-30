import { join } from "node:path";
import type { SwitchboardConfigInput } from "@powerhousedao/switchboard/config";
import type { SidecarConfig } from "./config.js";
import { DEFAULT_RENOWN_URL } from "./identity.js";

/**
 * What `startSwitchboard(config, deps)` is called with (spec §4.1, §4.4): the engine's own config layer, and
 * the deps that are not settings. Pure, so the shape is testable. `engineConfig` lays this layer over the env's.
 */
export function switchboardOptions(cfg: SidecarConfig, configFile: string, packages: readonly string[], renownUrl: string = DEFAULT_RENOWN_URL) {
  const secrets = join(cfg.dataDir, "secrets");
  const config = {
    configFile,
    server: { port: cfg.port, strictPort: true, dev: false },
    features: { mcp: true, workflows: true },
    packages: {
      // Package directories, not names: the loader resolves names from cwd, and the engine runs with cwd = the data dir.
      list: [...packages],
      disableLocal: true,
      // Only when KV_REGISTRY_URL names one (config.ts says why it is off): Workflow Studio's Registry tab
      // lists its pieces and installs one when picked (into <data dir>/.ph, the engine's cwd).
      ...(cfg.registryUrl ? { registryUrl: cfg.registryUrl } : {}),
    },
    remoteDrives: [] as string[],
    // The engine's signing identity (spec §4.4). Open mode: an app keypair in the data dir's
    // secrets (never beside the code, which is where the default `./.ph` lands). Protected: the
    // user's delegated keypair — the one the Renown sign-in bound to their address — so every
    // local write is signed as them; it must exist, since protection required the sign-in.
    identity: cfg.protected
      ? { keypairPath: join(secrets, "user.keypair.json"), requireExisting: true, baseUrl: renownUrl }
      : { keypairPath: join(secrets, "app.keypair.json"), baseUrl: renownUrl },
  } satisfies SwitchboardConfigInput;
  return { config, deps: { fatalErrorShutdown: true } };
}

/** The two helpers of `@powerhousedao/switchboard/config(/env)`, passed in so this module never loads the stack. */
export interface ConfigMapping {
  switchboardConfigFromEnv(env: Readonly<Record<string, string | undefined>>): SwitchboardConfigInput;
  callerOverEnv(env: SwitchboardConfigInput, caller: SwitchboardConfigInput): SwitchboardConfigInput;
}

/**
 * The config the engine boots with. Since 6.2.3-dev.85 `startSwitchboard` reads no process.env for the keys its
 * config covers, so the env the sidecar sets (config.ts switchboardEnv: auth, storage, the attachment secret, …)
 * is mapped the way the Switchboard's own bin maps it, and the sidecar's layer goes over it: callerOverEnv keeps
 * each key's old precedence between the two. The workflow runtime still reads its own two keys
 * (PH_WORKFLOWS_SECRETS_MASTER_KEY, PH_WORKFLOWS_EGRESS_ALLOW_ADDRESSES) from process.env.
 */
export function engineConfig(env: Readonly<Record<string, string | undefined>>, layer: SwitchboardConfigInput, mapping: ConfigMapping): SwitchboardConfigInput {
  return mapping.callerOverEnv(mapping.switchboardConfigFromEnv(env), layer);
}

/**
 * The packages as the Switchboard is given them. Windows: the directory without its drive letter, with forward
 * slashes (`/Users/…`). Upstream takes a package for a path only when it is absolute (switchboard's isFsPath)
 * or starts with "/" or "." (reactor-api's HTTP routes, resolvePackageName): `C:\…` fails the second check —
 * the engine crashed with "is not a package name and not a path" — and a relative `../…` fails the package
 * manager's loaders. A rooted path is absolute on the current drive, the drive of the engine's working folder;
 * an engine on another drive keeps its drive letter.
 */
export function packageSpecs(dirs: readonly string[], cwd: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return [...dirs];
  const drive = (p: string) => /^([a-zA-Z]):/.exec(p)?.[1]?.toUpperCase();
  return dirs.map((dir) => (drive(dir) !== undefined && drive(dir) === drive(cwd) ? dir.slice(2).replaceAll("\\", "/") : dir));
}
