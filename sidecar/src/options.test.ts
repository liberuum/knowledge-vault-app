import { callerOverEnv, switchboardConfigSchema } from "@powerhousedao/switchboard/config";
import { switchboardConfigFromEnv } from "@powerhousedao/switchboard/config/env";
import { describe, expect, it } from "vitest";
import { readSidecarConfig, switchboardEnv } from "./config.js";
import { engineEnvironment } from "./environment.js";
import { engineConfig, packageSpecs, switchboardOptions } from "./options.js";

const cfg = readSidecarConfig({
  KV_DATA_DIR: "/tmp/Knowledge Vault äö/data",
  KV_PORT: "4301",
  KV_CONTROL_PORT: "4302",
  KV_CONTROL_TOKEN: "t",
});

const PACKAGE_DIRS = [
  "/app/sidecar/node_modules/@powerhousedao/knowledge-note",
  "/app/sidecar/node_modules/@powerhousedao/workflow",
];

describe("switchboardOptions", () => {
  it("loads the vault and workflow packages by directory (never by name from cwd), with the config file named explicitly", () => {
    const { config, deps } = switchboardOptions(cfg, "/app/sidecar/powerhouse.config.json", PACKAGE_DIRS);
    expect(config.packages.list).toEqual(PACKAGE_DIRS);
    expect(config.packages.disableLocal).toBe(true);
    expect(config.server).toEqual({ port: 4301, strictPort: true, dev: false });
    expect(config.configFile).toBe("/app/sidecar/powerhouse.config.json");
    expect(config.features).toEqual({ mcp: true, workflows: true });
    expect(config.remoteDrives).toEqual([]);
    expect(deps).toEqual({ fatalErrorShutdown: true });
    // Workflow Studio's Registry tab: off by default (config.ts), on when KV_REGISTRY_URL names a registry.
    expect("registryUrl" in config.packages).toBe(false);
    expect(switchboardOptions({ ...cfg, registryUrl: "https://registry.vetra.io" }, "/c.json", PACKAGE_DIRS).config.packages.registryUrl).toBe("https://registry.vetra.io");
  });
  it("keeps the engine's identity keypair under the data dir's secrets, never beside the code", () => {
    const { config } = switchboardOptions(cfg, "/app/sidecar/powerhouse.config.json", PACKAGE_DIRS, "https://www.renown.id");
    expect(config.identity).toEqual({ keypairPath: "/tmp/Knowledge Vault äö/data/secrets/app.keypair.json", baseUrl: "https://www.renown.id" });
  });
  it("signs as the user when protected: the SDK's delegated keypair, required to exist (spec §4.4)", () => {
    const protectedCfg = readSidecarConfig({ KV_DATA_DIR: "/data", KV_PORT: "4301", KV_CONTROL_PORT: "4302", KV_CONTROL_TOKEN: "t", KV_PROTECTED: "1", KV_ADMIN_ADDRESS: "0xabc" });
    const { config } = switchboardOptions(protectedCfg, "/app/sidecar/powerhouse.config.json", PACKAGE_DIRS, "https://www.renown.id");
    expect(config.identity).toEqual({ keypairPath: "/data/secrets/user.keypair.json", requireExisting: true, baseUrl: "https://www.renown.id" });
  });
});

// The Switchboard reads no process.env for the keys its config covers (6.2.3-dev.85), so every setting the
// sidecar puts in the env has to come through the real mapping into the config it boots with. A key that
// went missing here would boot a protected vault with authentication off, and nothing would say so.
describe("engineConfig", () => {
  const secrets = { workflows: "w".repeat(64), attachmentSigning: "s".repeat(64) };
  const mapping = { switchboardConfigFromEnv, callerOverEnv };
  const boot = (c: ReturnType<typeof readSidecarConfig>) =>
    switchboardConfigSchema.parse(engineConfig(engineEnvironment({}, switchboardEnv(c, secrets)), switchboardOptions(c, "/app/sidecar/powerhouse.config.json", PACKAGE_DIRS).config, mapping));

  it("boots a protected vault with authentication, its storage and its secrets from the env", () => {
    const c = readSidecarConfig({ KV_DATA_DIR: "/data", KV_PORT: "4301", KV_CONTROL_PORT: "4302", KV_CONTROL_TOKEN: "t", KV_PROTECTED: "1", KV_ADMIN_ADDRESS: "0xabc", KV_LOG_LEVEL: "debug" });
    const config = boot(c);
    expect(config.auth).toMatchObject({
      enabled: true,
      requireAuthenticatedCaller: true,
      requireAuthenticatedCallerExemptPaths: ["/health"],
      defaultProtection: true,
      documentPermissions: { enabled: true },
      admins: ["0xabc"],
    });
    expect(config.storage.reactor.url).toBe("/data/reactor");
    expect(config.storage.readModel.url).toBe("/data/read-model");
    expect(config.attachments.urlSigningSecret).toBe(secrets.attachmentSigning);
    expect(config.server).toMatchObject({ port: 4301, strictPort: true, dev: false, publicUrl: "http://127.0.0.1:4301" });
    expect(config.features).toMatchObject({ mcp: true, workflows: true });
    expect(config.logLevel).toBe("debug");
    // The sidecar's own layer survives the merge.
    expect(config.packages.list).toEqual(PACKAGE_DIRS);
    expect(config.packages.disableLocal).toBe(true);
    expect(config.identity).toMatchObject({ keypairPath: "/data/secrets/user.keypair.json", requireExisting: true });
    expect(config.configFile).toBe("/app/sidecar/powerhouse.config.json");
  });

  it("boots an open vault with authentication off", () => {
    const config = boot(cfg);
    expect(config.auth).toMatchObject({ enabled: false, requireAuthenticatedCaller: false, defaultProtection: false, documentPermissions: { enabled: false } });
  });

  it("passes PH_PGLITE_FSYNC through when the sidecar was started with it", () => {
    const before = process.env.PH_PGLITE_FSYNC;
    process.env.PH_PGLITE_FSYNC = "0";
    try {
      expect(boot(cfg).storage.pglite.fsync).toBe(false);
    } finally {
      if (before === undefined) delete process.env.PH_PGLITE_FSYNC;
      else process.env.PH_PGLITE_FSYNC = before;
    }
  });
});

describe("packageSpecs", () => {
  it("passes the package directories as they are on Linux and macOS", () => {
    const dirs = ["/opt/kv/sidecar/node_modules/@powerhousedao/knowledge-note"];
    expect(packageSpecs(dirs, "/home/me/.local/share/kv/vault", "linux")).toEqual(dirs);
    expect(packageSpecs(dirs, "/Users/me/Library/kv/vault", "darwin")).toEqual(dirs);
  });

  it("on Windows drops the drive and uses forward slashes, so both upstream loaders take it as a path", () => {
    const dirs = [
      String.raw`C:\Users\me\AppData\Local\kv\engine\0.1.0-1\sidecar\node_modules\@powerhousedao\knowledge-note`,
      String.raw`C:\Users\me\AppData\Local\kv\engine\0.1.0-1\sidecar\node_modules\@powerhousedao\workflow`,
    ];
    const specs = packageSpecs(dirs, String.raw`C:\Users\me\AppData\Roaming\kv\vault`, "win32");
    expect(specs).toEqual([
      "/Users/me/AppData/Local/kv/engine/0.1.0-1/sidecar/node_modules/@powerhousedao/knowledge-note",
      "/Users/me/AppData/Local/kv/engine/0.1.0-1/sidecar/node_modules/@powerhousedao/workflow",
    ]);
  });

  it("on Windows keeps the drive when the engine is on another drive than its working folder", () => {
    const dir = String.raw`D:\Apps\kv\sidecar\node_modules\pkg`;
    expect(packageSpecs([dir], String.raw`C:\Users\me\vault`, "win32")).toEqual([dir]);
  });
});
