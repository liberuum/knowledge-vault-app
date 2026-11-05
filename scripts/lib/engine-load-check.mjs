import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/**
 * The engine's command line. `--import` takes a module specifier, not a path: on Windows a bare
 * `C:\…\loader.mjs` reads as a URL with the scheme `c:` (ERR_UNSUPPORTED_ESM_URL_SCHEME, which stopped the
 * 0.2.6 Windows build), so the loader goes in as a file: URL on every OS.
 */
export function engineArgs(loader) {
  return ["--import", pathToFileURL(loader).href, join("dist", "main.js")];
}

/**
 * The throwaway store goes once the engine has stopped. On Windows a file the engine's last child process or the
 * antivirus still holds cannot be deleted for a moment (EPERM or EBUSY: the 0.2.6 release build failed on it after a
 * passing check), so the removal is retried for about 10 s, and a folder still there after that is reported with
 * what it holds. It never decides a check.
 */
export function removeScratch(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return true;
  } catch (error) {
    let held = [];
    try {
      held = readdirSync(dir, { recursive: true }).slice(0, 8);
    } catch {
      // the listing is only a clue
    }
    console.warn(`[stage] the load check's scratch folder stays behind (${error.code ?? error.message}): ${dir}${held.length ? `; still holding ${held.join(", ")}` : ""}`);
    return false;
  }
}

/** Stops the engine through its stdin and waits for it to exit: a stop that hangs gets SIGKILL and 5 s more. */
async function stopEngine(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms).unref());
  child.stdin.end(); // KV_STDIN_STOP: the engine stops when its stdin closes
  if (await Promise.race([exited.then(() => true), wait(15_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, wait(5_000)]);
}

export async function engineLoadCheck(stageDir, { node = process.execPath, timeoutMs = 120_000, port = 48401 } = {}) {
  const data = mkdtempSync(join(tmpdir(), "kv-load-check-"));
  const trace = join(data, "loaded.txt");
  const loader = join(data, "loader.mjs");
  writeFileSync(loader, LOADER);
  writeFileSync(trace, "");
  const env = { ...process.env, KV_TRACE_OUT: trace, KV_STDIN_STOP: "1", KV_DATA_DIR: data, KV_PORT: String(port), KV_CONTROL_PORT: String(port + 1), KV_CONTROL_TOKEN: "load-check" };
  const child = spawn(node, engineArgs(loader), { cwd: stageDir, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdin.on("error", () => {}); // an engine already gone closes the pipe under the stop
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
    await stopEngine(child);
  }
  const loaded = readFileSync(trace, "utf8").split("\n").filter(Boolean);
  const v = verdict(loaded, join(stageDir, "node_modules"), output);
  removeScratch(data);
  const signIn = typeof loginUrl === "string" && /^https:\/\/.+\/console\?session=/.test(loginUrl);
  return { ready, signIn, loadedModules: loaded.length, ...v, ok: ready && signIn && v.dropped.length === 0 && v.missing.length === 0, output };
}
