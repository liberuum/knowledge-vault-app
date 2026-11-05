import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { engineArgs, engineLoadCheck, packageOf, verdict } from "./engine-load-check.mjs";

/** A stand-in engine: the ready line, a control port that answers the sign-in link, and a stop when stdin closes. */
const FAKE_ENGINE = `
import { createServer } from "node:http";
const port = Number(process.env.KV_CONTROL_PORT);
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(req.method === "POST" && req.url === "/auth/login" ? JSON.stringify({ url: "https://renown.id/console?session=load-check" }) : "{}");
});
server.listen(port, "127.0.0.1", () => process.stdout.write(JSON.stringify({ event: "ready", port: Number(process.env.KV_PORT), controlPort: port }) + "\\n"));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

describe("engine load check", () => {
  const nm = "/stage/sidecar/node_modules";
  it("names the package a loaded file belongs to, scoped or not, and nothing outside node_modules", () => {
    expect(packageOf("file:///stage/sidecar/node_modules/viem/_esm/index.js", nm)).toBe("viem");
    expect(packageOf("file:///stage/sidecar/node_modules/@renown/sdk/dist/node.js", nm)).toBe("@renown/sdk");
    expect(packageOf("file:///stage/sidecar/node_modules/@wagmi/connectors/dist/x.js", nm)).toBe("@wagmi/connectors");
    expect(packageOf("file:///stage/sidecar/dist/main.js", nm)).toBeNull();
    // percent-encoded spaces in the path; a Windows drive path only on Windows (fileURLToPath is the OS's)
    expect(packageOf("file:///stage/Knowledge%20Vault/node_modules/viem/index.js", "/stage/Knowledge Vault/node_modules")).toBe("viem");
    if (process.platform === "win32") expect(packageOf("file:///C:/Program%20Files/Knowledge%20Vault/sidecar/node_modules/viem/index.js", "C:\\Program Files\\Knowledge Vault\\sidecar\\node_modules")).toBe("viem");
    expect(packageOf("not a url", nm)).toBeNull();
  });
  it("fails on a loaded wallet package or a missing module, and not on the onnxruntime-node fallback the engine expects", () => {
    const ok = verdict(["file:///stage/sidecar/node_modules/@renown/sdk/dist/node.js", "file:///stage/sidecar/node_modules/viem/index.js"], nm, "[Embedder] onnxruntime-node not found (Cannot find package 'onnxruntime-node'), falling back to wasm\n");
    expect(ok).toEqual({ dropped: [], missing: [] });
    const bad = verdict(["file:///stage/sidecar/node_modules/wagmi/dist/index.js", "file:///stage/sidecar/node_modules/@privy-io/react-auth/dist/i.js"], nm, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@reown/appkit'\n");
    expect(bad.dropped).toEqual(["wagmi", "@privy-io/react-auth"]);
    expect(bad.missing).toHaveLength(1);
  });
  it("hands the loader to --import as a file: URL (on Windows a bare C:\\ path reads as the URL scheme c:)", () => {
    const loader = join(tmpdir(), "kv-load-check-x", "loader.mjs");
    const [flag, specifier, main] = engineArgs(loader);
    expect(flag).toBe("--import");
    expect(specifier.startsWith("file:")).toBe(true);
    expect(fileURLToPath(specifier)).toBe(loader);
    expect(main).toBe(join("dist", "main.js"));
  });
  it("starts an engine under the trace loader and reads its verdict: ready, a sign-in link, its own modules traced", async () => {
    const stage = mkdtempSync(join(tmpdir(), "kv-fake-engine-"));
    try {
      mkdirSync(join(stage, "dist"));
      writeFileSync(join(stage, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(stage, "dist", "main.js"), FAKE_ENGINE);
      const control = await freePort(); // the check talks to port + 1
      const check = await engineLoadCheck(stage, { port: control - 1, timeoutMs: 30_000 });
      expect(check.output).not.toMatch(/ERR_UNSUPPORTED_ESM_URL_SCHEME/);
      expect({ ok: check.ok, ready: check.ready, signIn: check.signIn, dropped: check.dropped, missing: check.missing }).toEqual({ ok: true, ready: true, signIn: true, dropped: [], missing: [] });
      expect(check.loadedModules).toBeGreaterThanOrEqual(1); // dist/main.js, seen by the loader's hook
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }, 40_000);
});
