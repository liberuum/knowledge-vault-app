// Plan 6: launch the built app from a clean, throwaway home with KV_SMOKE=1 — the shell exits 0 once
// its bundled engine is ready and its own host page answers (stopping the engine on the way out).
// Reports the installer sizes, the time to ready and the peak memory of the whole process tree.
//   node scripts/smoke-app.mjs [path-to-AppImage]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
const env = {
  PATH: "/usr/bin:/bin",
  HOME: home,
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  KV_SMOKE: "1",
  APPIMAGE_EXTRACT_AND_RUN: "1", // no FUSE needed
};
for (const k of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[k]) env[k] = process.env[k];

const started = Date.now();
const child = spawn(appImage, [], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

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
const killer = setTimeout(() => child.kill("SIGKILL"), 150_000);
child.on("exit", (code) => {
  clearInterval(sampler);
  clearTimeout(killer);
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
  }
  rmSync(home, { recursive: true, force: true });
  process.exit(code === 0 && verdict?.includes("ok") ? 0 : 1);
});
