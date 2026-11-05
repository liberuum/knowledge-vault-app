// Plan 6: launch the built app from a clean, throwaway home with KV_SMOKE=1 — the shell exits 0 once
// its bundled engine is ready and its own host page answers (stopping the engine on the way out).
// Reports the installer sizes, the time to ready and the peak memory of the whole process tree.
//   node scripts/smoke-app.mjs [path-to-AppImage]
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bundle = resolve("src-tauri", "target", "release", "bundle");
const newest = (dir, ext) => {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
};
// Linux: the AppImage. macOS: the executable inside the .app bundle.
const macApp = process.platform === "darwin" ? newest(join(bundle, "macos"), ".app") : undefined;
const appImage = process.argv[2] ?? (macApp ? join(macApp, "Contents", "MacOS", "knowledge-vault-app") : newest(join(bundle, "appimage"), ".AppImage"));
if (!appImage || !existsSync(appImage)) {
  console.error("[smoke] no built app found — run `bun run build:app` first");
  process.exit(1);
}
const mb = (p) => (statSync(p).size / 1e6).toFixed(0);
const installer = macApp ? newest(join(bundle, "dmg"), ".dmg") : appImage;
const deb = newest(join(bundle, "deb"), ".deb");
if (installer) console.log(`[smoke] ${installer.split("/").pop()}: ${mb(installer)} MB${deb ? `; ${deb.split("/").pop()}: ${mb(deb)} MB` : ""}`);

const home = mkdtempSync(join(tmpdir(), "kv-smoke-"));
// The AppImage unpacks itself into $TMPDIR in extract-and-run mode (a full copy, about 1 GB): inside the
// throwaway home it goes with it. Any unpacked copy that still lands in the system temp dir during this
// run is removed at the end too — only ones that were not there before.
const appTmp = join(home, "tmp");
mkdirSync(appTmp, { recursive: true });
const extractedBefore = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("appimage_extracted_")));
const env = {
  PATH: "/usr/bin:/bin",
  HOME: home,
  TMPDIR: appTmp,
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  KV_SMOKE: "1",
  APPIMAGE_EXTRACT_AND_RUN: "1", // no FUSE needed
};
for (const k of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[k]) env[k] = process.env[k];
// The app's deadline (smoke.rs: 90 s unless KV_SMOKE_SECS says otherwise); this script kills it a minute later.
const smokeSecs = Number(process.env.KV_SMOKE_SECS) > 0 ? Number(process.env.KV_SMOKE_SECS) : 90;
env.KV_SMOKE_SECS = String(smokeSecs);
// WebKit and GLib switches pass through, to try a renderer or a sandbox setting, or to turn on their logging
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (k.startsWith("WEBKIT_") || k === "G_MESSAGES_DEBUG")) env[k] = v;

const started = Date.now();
const child = spawn(appImage, [], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

// macOS: a window that never loads its page showed nothing else in this check's output (0.2.6, runs 5 and 6). When
// the app has not passed 25 s before its deadline, what it is doing goes to smoke-diagnostics/, which the release
// uploads when the check fails: a screenshot, its threads (spindump as root, else sample, which the hardened runtime
// may refuse) and the processes; after the exit, the system log of the app and WebKit, and crash reports.
const diagDir = resolve("smoke-diagnostics");
const sh = (cmd, args, timeout = 60_000) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return `${cmd} failed: ${e.message}\n${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
};
let caught = false;
function catchMacWindow(pid) {
  if (child.exitCode !== null || /\[smoke\] (ok|failed)/.test(out)) return;
  caught = true;
  rmSync(diagDir, { recursive: true, force: true });
  mkdirSync(diagDir, { recursive: true });
  sh("screencapture", ["-x", join(diagDir, "screen.png")]);
  const threads = join(diagDir, "app-threads.txt");
  sh("sudo", ["-n", "spindump", String(pid), "3", "10", "-file", threads], 120_000);
  if (!existsSync(threads)) sh("sample", [String(pid), "3", "-file", threads]);
  const ps = sh("ps", ["-axo", "pid,ppid,stat,%cpu,%mem,rss,etime,command"]);
  writeFileSync(join(diagDir, "ps.txt"), ps);
  const mine = ps.split("\n").filter((l, i) => i === 0 || /knowledge-vault-app|com\.apple\.WebKit|kv-node|converter/i.test(l));
  console.log(`[smoke] not passed after ${((Date.now() - started) / 1000).toFixed(0)} s; the app's and WebKit's processes:\n${mine.map((l) => l.slice(0, 200)).join("\n")}`);
}
const watcher = process.platform === "darwin" ? setTimeout(() => catchMacWindow(child.pid), Math.max(10, smokeSecs - 25) * 1000) : undefined;

/** After a failed run on macOS: the app's and WebKit's system log, crash reports, and the main thread's stack. */
function reportMacWindow() {
  if (!caught) return;
  const minutes = Math.ceil((Date.now() - started) / 60_000) + 1;
  const log = sh("log", ["show", "--style", "compact", "--last", `${minutes}m`, "--predicate", 'process == "knowledge-vault-app" OR process BEGINSWITH "com.apple.WebKit"'], 180_000);
  writeFileSync(join(diagDir, "system.log"), log);
  const reports = join(process.env.HOME ?? "", "Library", "Logs", "DiagnosticReports");
  const crashes = existsSync(reports) ? readdirSync(reports).filter((f) => /WebKit|knowledge|kv-node/i.test(f) && statSync(join(reports, f)).mtimeMs >= started) : [];
  for (const f of crashes) copyFileSync(join(reports, f), join(diagDir, f));
  const threads = existsSync(join(diagDir, "app-threads.txt")) ? readFileSync(join(diagDir, "app-threads.txt"), "utf8") : "";
  const at = threads.indexOf("main-thread");
  const stack = at >= 0 ? threads.slice(threads.lastIndexOf("\n", at) + 1).split("\n").slice(0, 45) : threads.split("\n").slice(0, 12);
  console.log(`[smoke] the app's main thread:\n${stack.map((l) => l.slice(0, 200)).join("\n") || "(no stack captured)"}`);
  const notable = log.split("\n").filter((l) => /error|fail|denied|crash|terminat|sandbox|invalid|refus|timed? ?out|blocked/i.test(l));
  console.log(`[smoke] notable lines in the app's and WebKit's system log (${notable.length}; the last 40):\n${notable.slice(-40).map((l) => l.slice(0, 240)).join("\n")}`);
  console.log(`[smoke] diagnostics in ${diagDir}: ${readdirSync(diagDir).join(", ")}`);
}

// Peak resident memory of the app and everything it started (Linux /proc).
let peak = 0;
const tree = (pid) => {
  const kids = [];
  for (const p of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try {
      if (readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" ")[1] === String(pid)) kids.push(Number(p));
    } catch {}
  }
  return [pid, ...kids.flatMap(tree)];
};
const sampler = setInterval(() => {
  if (process.platform !== "linux") return; // /proc only
  let kb = 0;
  for (const p of tree(child.pid)) {
    try {
      kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p}/status`, "utf8"))?.[1] ?? 0);
    } catch {}
  }
  peak = Math.max(peak, kb);
}, 500);
const killer = setTimeout(() => child.kill("SIGKILL"), (smokeSecs + 60) * 1000);
child.on("exit", (code) => {
  clearInterval(sampler);
  clearTimeout(killer);
  clearTimeout(watcher);
  const verdict = /\[smoke\] (ok|failed)[^\n]*/.exec(out)?.[0];
  console.log(verdict ?? "[smoke] no verdict from the app");
  if (!verdict && Date.now() - started < 10_000) console.log("[smoke] it exited at once — if Knowledge Vault (or `bun run dev`'s window) is already open, the new launch handed over to it (one instance at a time): close it and run again");
  console.log(`[smoke] exit ${code} after ${((Date.now() - started) / 1000).toFixed(1)} s${process.platform === "linux" ? `; peak memory ${(peak / 1024).toFixed(0)} MB` : ""}`);
  const store = process.platform === "darwin" ? join(home, "Library", "Application Support", "io.github.liberuum.knowledge-vault-app", "vault") : join(env.XDG_DATA_HOME, "io.github.liberuum.knowledge-vault-app", "vault");
  console.log(`[smoke] engine store created: ${existsSync(join(store, "reactor"))}`);
  if (code !== 0) {
    const lines = out.split("\n");
    // the app's own output (WebKit, GTK, GLib, the shell) apart from the engine's, which would push it out of view
    const app = lines.filter((l) => l.trim() && !l.startsWith("[sidecar]") && !l.startsWith("[converter]") && !l.startsWith("[smoke]"));
    console.log(`[smoke] the app's own output (${app.length} lines, last 60):\n${app.slice(-60).join("\n")}`);
    console.log(`[smoke] the engine's last lines:\n${lines.filter((l) => l.startsWith("[sidecar]")).slice(-15).join("\n")}`);
    reportMacWindow();
  }
  rmSync(home, { recursive: true, force: true });
  for (const f of readdirSync(tmpdir()).filter((f) => f.startsWith("appimage_extracted_") && !extractedBefore.has(f))) {
    rmSync(join(tmpdir(), f), { recursive: true, force: true });
    console.log(`[smoke] removed the unpacked copy ${f}`);
  }
  process.exit(code === 0 && verdict?.includes("ok") ? 0 : 1);
});
