import type { SidecarInfo } from "../sidecar.js";
import { control as realControl } from "../vaults.js";

type Deps = {
  control: (info: SidecarInfo, path: string, init: RequestInit) => Promise<unknown>;
  open: (url: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};
const DEADLINE_MS = 10 * 60_000;

/** The system browser: Tauri's opener under the shell, a new tab in a plain browser. */
export async function openInBrowser(url: string): Promise<void> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/**
 * The vault package's `externalSignIn` for the desktop app: the engine's control server hosts
 * a one-shot callback, the provider opens in the system browser, and the code comes back here
 * when the browser lands on the callback. The vault package keeps the PKCE verifier and does the
 * exchange.
 */
export async function externalSignIn(info: SidecarInfo, buildUrl: (callbackUrl: string) => string, deps: Partial<Deps> = {}): Promise<string> {
  const control = deps.control ?? ((i, p, init) => realControl(i, p, init, fetch));
  const open = deps.open ?? openInBrowser;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const { nonce, callbackUrl } = (await control(info, "/oauth/start", { method: "POST" })) as { nonce: string; callbackUrl: string };
  await open(buildUrl(callbackUrl));
  const started = now();
  for (;;) {
    const r = (await control(info, `/oauth/result/${encodeURIComponent(nonce)}`, { method: "GET" })) as { code?: string; pending?: boolean };
    if (r.code) return r.code;
    if (now() - started > DEADLINE_MS) throw new Error("The sign-in did not finish within ten minutes.");
    await sleep(1000);
  }
}
