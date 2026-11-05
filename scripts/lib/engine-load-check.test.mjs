import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { engineArgs, engineLoadCheck, packageOf, removeScratch, verdict } from "./engine-load-check.mjs";

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
  // Folders absolute on the OS the test runs on (/stage/... here, D:\stage\... on a Windows runner), and their files as
  // the loader reports them: a file:///stage/... URL has no drive letter, and Windows cannot read it as a path.
  const nm = resolve("/stage/sidecar/node_modules");
  const loaded = (...parts) => pathToFileURL(join(nm, ...parts)).href;
  it("names the package a loaded file belongs to, scoped or not, and nothing outside node_modules", () => {
    expect(packageOf(loaded("viem", "_esm", "index.js"), nm)).toBe("viem");
    expect(packageOf(loaded("@renown", "sdk", "dist", "node.js"), nm)).toBe("@renown/sdk");
    expect(packageOf(loaded("@wagmi", "connectors", "dist", "x.js"), nm)).toBe("@wagmi/connectors");
    expect(packageOf(pathToFileURL(resolve("/stage/sidecar/dist/main.js")).href, nm)).toBeNull();
    // percent-encoded spaces in the path; a Windows drive path only on Windows (fileURLToPath is the OS's)
    const spaced = resolve("/stage/Knowledge Vault/node_modules");
    const spacedUrl = pathToFileURL(join(spaced, "viem", "index.js")).href;
    expect(spacedUrl).toContain("Knowledge%20Vault");
    expect(packageOf(spacedUrl, spaced)).toBe("viem");
    if (process.platform === "win32") expect(packageOf("file:///C:/Program%20Files/Knowledge%20Vault/sidecar/node_modules/viem/index.js", "C:\\Program Files\\Knowledge Vault\\sidecar\\node_modules")).toBe("viem");
    expect(packageOf("not a url", nm)).toBeNull();
  });
  it("fails on a loaded wallet package or a missing module, and not on the onnxruntime-node fallback the engine expects", () => {
    const ok = verdict([loaded("@renown", "sdk", "dist", "node.js"), loaded("viem", "index.js")], nm, "[Embedder] onnxruntime-node not found (Cannot find package 'onnxruntime-node'), falling back to wasm\n");
    expect(ok).toEqual({ dropped: [], missing: [] });
    const bad = verdict([loaded("wagmi", "dist", "index.js"), loaded("@privy-io", "react-auth", "dist", "i.js")], nm, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@reown/appkit'\n");
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
  it("removes its scratch folder, files and all", () => {
    const dir = mkdtempSync(join(tmpdir(), "kv-scratch-"));
    mkdirSync(join(dir, "reactor"));
    writeFileSync(join(dir, "reactor", "PG_VERSION"), "17");
    expect(removeScratch(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
  // A read-only folder keeps its files on Linux and macOS (not for root): what a file still open does on Windows.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports a scratch folder it cannot remove, with what it holds, and does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "kv-scratch-"));
    const held = join(dir, "converter");
    mkdirSync(held);
    writeFileSync(join(held, "binding.node"), "");
    chmodSync(held, 0o555);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(removeScratch(dir)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0];
      expect(message).toContain("stays behind");
      expect(message).toContain(dir);
      expect(message).toContain(join("converter", "binding.node"));
    } finally {
      warn.mockRestore();
      chmodSync(held, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
