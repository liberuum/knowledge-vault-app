import { useCallback, useEffect, useRef, useState } from "react";
import { cancelLogin, fetchAuthStatus, logout, startLogin, type IdentityStatus } from "../api/identity.js";
import type { SidecarInfo } from "../sidecar.js";
import { openInBrowser } from "../api/oauth.js";

export type IdentityApi = {
  fetchAuthStatus: (info: SidecarInfo) => Promise<IdentityStatus>;
  startLogin: (info: SidecarInfo) => Promise<{ url?: string; alreadyAuthenticated: boolean }>;
  cancelLogin: (info: SidecarInfo) => Promise<unknown>;
  logout: (info: SidecarInfo) => Promise<unknown>;
  /** Opens the sign-in link in the system browser; the engine never opens a browser itself. */
  openUrl?: (url: string) => Promise<void>;
};
export const realIdentityApi: IdentityApi = { fetchAuthStatus, startLogin, cancelLogin, logout, openUrl: openInBrowser };

const POLL_MS = 2000;

/** The engine's sign-in state, polled while a browser sign-in is pending. */
export function useIdentity(info: SidecarInfo | undefined, api: IdentityApi = realIdentityApi, pollMs = POLL_MS) {
  const [status, setStatus] = useState<IdentityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!info) return;
    try {
      const s = await api.fetchAuthStatus(info);
      if (alive.current) {
        setStatus(s);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, info]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While the browser flow is pending, ask again every couple of seconds.
  useEffect(() => {
    if (!status?.pending) return;
    const handle = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(handle);
  }, [status?.pending, refresh, pollMs]);

  const signIn = useCallback(async () => {
    if (!info) return;
    setError(null);
    try {
      const started = await api.startLogin(info);
      if (started.url && api.openUrl) await api.openUrl(started.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  }, [api, info, refresh]);
  const cancel = useCallback(async () => {
    if (!info) return;
    await api.cancelLogin(info).catch(() => {});
    await refresh();
  }, [api, info, refresh]);
  const signOut = useCallback(async () => {
    if (!info) return;
    await api.logout(info).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    await refresh();
  }, [api, info, refresh]);

  return { status, error, refresh, signIn, cancel, signOut };
}

/** What the one identity hook instance (owned by App) hands to the screens. */
export type IdentityController = ReturnType<typeof useIdentity>;

/** 0x7A3f…9c4 — enough to recognise, short enough for a chip. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
