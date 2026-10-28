import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_WALLET_PACKAGES } from "./prune.mjs";

/**
 * The staged engine, started once on a throwaway data folder and asked for a sign-in link — the one
 * thing prune.mjs reasons about when it drops the browser wallet stack — while every module it loads
 * is recorded. The verdict: it reached ready, it built the renown.id link, it loaded no module from a
 * package that is dropped, and it reported no missing module. Run by stage-sidecar after the prune on
 * the OS that stages (the pruned tree is the same on every target but for the natives).
 */
export const LOADER = `
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
const out = process.env.KV_TRACE_OUT;
registerHooks({ load(url, context, next) { if (out && url.startsWith("file:")) appendFileSync(out, url + "\\n"); return next(url, context); } });
`;

/** The top-level package a loaded file belongs to, or null outside node_modules. */
export function packageOf(fileUrl, nodeModules) {
  let path;
  try {
    path = fileURLToPath(fileUrl);
  } catch {
    return null;
  }
  const rel = relative(nodeModules, path);
  if (!rel || rel.startsWith("..")) return null;
  const rest = rel.split(sep);
  return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
}

/** Dropped packages among the loaded files, and the missing-module lines in the engine's output. */
export function verdict(loadedUrls, nodeModules, output) {
  const dropped = [...new Set(loadedUrls.map((u) => packageOf(u, nodeModules)).filter((p) => p && BROWSER_WALLET_PACKAGES.test(p)))];
  const missing = output.split("\n").filter((l) => /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (package|module)/.test(l) && !/onnxruntime-node/.test(l));
  return { dropped, missing };
}

export async function engineLoadCheck(stageDir, { node = process.execPath, timeoutMs = 120_000, port = 48401 } = {}) {
  const data = mkdtempSync(join(tmpdir(), "kv-load-check-"));
  const trace = join(data, "loaded.txt");
  const loader = join(data, "loader.mjs");
  writeFileSync(loader, LOADER);
  writeFileSync(trace, "");
  const env = { ...process.env, KV_TRACE_OUT: trace, KV_STDIN_STOP: "1", KV_DATA_DIR: data, KV_PORT: String(port), KV_CONTROL_PORT: String(port + 1), KV_CONTROL_TOKEN: "load-check" };
  const child = spawn(node, ["--import", loader, join("dist", "main.js")], { cwd: stageDir, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const control = `http://127.0.0.1:${port + 1}`;
  const headers = { authorization: "Bearer load-check" };
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  let loginUrl;
  try {
    while (Date.now() < deadline && !/"event":"(ready|fatal)"/.test(output)) await new Promise((r) => setTimeout(r, 250));
    ready = /"event":"ready"/.test(output);
    if (ready) {
      const res = await fetch(`${control}/auth/login`, { method: "POST", headers });
      loginUrl = (await res.json()).url;
      await fetch(`${control}/auth/cancel`, { method: "POST", headers });
      await new Promise((r) => setTimeout(r, 1000)); // the trace file is appended as modules load
    }
  } finally {
    child.stdin.end(); // KV_STDIN_STOP: the engine stops when its stdin closes
    await new Promise((r) => { child.once("exit", r); setTimeout(() => { child.kill("SIGKILL"); r(); }, 15_000); });
  }
  const loaded = readFileSync(trace, "utf8").split("\n").filter(Boolean);
  const v = verdict(loaded, join(stageDir, "node_modules"), output);
  rmSync(data, { recursive: true, force: true });
  const signIn = typeof loginUrl === "string" && /^https:\/\/.+\/console\?session=/.test(loginUrl);
  return { ready, signIn, loadedModules: loaded.length, ...v, ok: ready && signIn && v.dropped.length === 0 && v.missing.length === 0, output };
}
