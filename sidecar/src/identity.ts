import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renownLogin } from "./renown-login.js";

/**
 * The user's identity, held by the engine (spec §4.4, §5.4): a Renown session
 * bound to a keypair under secrets/. Sign-in runs Renown's browser flow — the engine builds
 * the link and polls, the window opens it in the system browser, the user signs with their wallet — and
 * bearer tokens for remote vaults are minted locally from that keypair, the way
 * `ph access-token` does. The webview never holds a key.
 */
export type IdentityStatus = {
  authenticated: boolean;
  address?: string;
  did?: string;
  /** The engine's own key, which the credential delegates to. */
  appDid: string;
  /** The credential is past its expirationDate: signed out for every purpose until the user signs in again. */
  expired: boolean;
  authenticatedAt?: string;
  renownUrl: string;
  /** A sign-in in progress: the URL to show if the browser did not open. */
  pending: { url?: string; startedAt: string } | null;
  lastError?: string;
};
export type AccessToken = { token: string; expiresAt: string; address: string; did: string };

/** The SDK instance: `user.credential` is the W3C credential the sign-in delegated to the keypair; it expires. */
type RenownLike = { logout(): Promise<void>; user?: { credential?: { expirationDate?: string } } };
export const EXPIRED_MESSAGE = "Your sign-in expired. Sign in again.";
function isExpired(renown: RenownLike, now: () => number = Date.now): boolean {
  const exp = renown.user?.credential?.expirationDate;
  if (!exp) return false;
  const at = Date.parse(exp);
  return Number.isFinite(at) && at <= now();
}
export type LoginOptions = {
  renownUrl: string;
  timeoutMs?: number;
  onLoginUrl?: (url: string, sessionId: string) => void;
  onBrowserOpenFailed?: (url: string) => void;
  signal?: AbortSignal;
};
/** The SDK surface this module uses, injectable so the flow is testable without a browser. */
export type IdentityDeps = {
  build: () => Promise<RenownLike>;
  browserLogin: (renown: RenownLike, options: LoginOptions) => Promise<{ user: { address: string; did: string }; cliDid: string }>;
  getAuthStatus: (renown: RenownLike) => { authenticated: boolean; address?: string; userDid?: string; cliDid: string; authenticatedAt?: Date; baseUrl: string };
  generateAccessToken: (renown: RenownLike, options?: { expiresIn?: number; aud?: string }) => Promise<{ token: string; did: string; address: string; expiresIn: number }>;
};

export const DEFAULT_RENOWN_URL = "https://www.renown.id";
const URL_WAIT_MS = 10_000;

/** The real SDK, with the key and session files under secrets/. */
export async function defaultIdentityDeps(secretsDir: string, renownUrl: string): Promise<IdentityDeps> {
  const sdk = await import("@renown/sdk/node");
  return {
    build: async () =>
      (await new sdk.RenownBuilder("knowledge-vault-app", {
        storagePath: join(secretsDir, "user.renown.json"),
        keyPath: join(secretsDir, "user.keypair.json"),
        baseUrl: renownUrl,
        // Offline-first: no network on startup; the Switchboard verifies the credential on every request anyway.
        revalidate: "never",
      }).build()) as unknown as RenownLike,
    // Not the SDK's browserLogin: that opens the browser from the engine, and on Windows the link
    // loses its parameters on the way (renown-login.ts). The window opens the reported link instead.
    browserLogin: (renown, options) => renownLogin(renown as never, options),
    getAuthStatus: (renown) => sdk.getAuthStatus(renown as never),
    generateAccessToken: (renown, options) => sdk.generateAccessToken(renown as never, options),
  };
}

type PendingLogin = { url?: string; startedAt: string; controller: AbortController; urlReady: Promise<string | undefined> };

export function createIdentity(deps: IdentityDeps, opts: { renownUrl: string; secretsDir: string; loginTimeoutMs?: number }) {
  let renown: Promise<RenownLike> | undefined;
  const get = () => (renown ??= deps.build());
  let pending: PendingLogin | null = null;
  let lastError: string | undefined;

  // The SDK writes its files world-readable; they are secrets.
  const tighten = () => {
    for (const name of ["user.keypair.json", "user.renown.json"]) {
      const file = join(opts.secretsDir, name);
      if (existsSync(file)) {
        try {
          chmodSync(file, 0o600);
        } catch {
          // read-only or foreign file system: nothing to tighten
        }
      }
    }
  };

  return {
    async status(): Promise<IdentityStatus> {
      const r = await get();
      const s = deps.getAuthStatus(r);
      const expired = s.authenticated && isExpired(r);
      tighten();
      return {
        authenticated: s.authenticated && !expired,
        expired,
        address: s.address,
        did: s.userDid,
        appDid: s.cliDid,
        authenticatedAt: s.authenticatedAt?.toISOString(),
        renownUrl: s.baseUrl,
        pending: pending ? { url: pending.url, startedAt: pending.startedAt } : null,
        lastError,
      };
    },

    /** Starts the browser flow (idempotent while one is pending) and returns the login URL as soon as it is known. */
    async startLogin(): Promise<{ url?: string; alreadyAuthenticated: boolean }> {
      const r = await get();
      if (deps.getAuthStatus(r).authenticated && !isExpired(r)) return { alreadyAuthenticated: true };
      if (pending) return { url: await pending.urlReady, alreadyAuthenticated: false };
      const controller = new AbortController();
      let resolveUrl!: (url: string | undefined) => void;
      const urlReady = new Promise<string | undefined>((resolve) => {
        resolveUrl = resolve;
      });
      const entry: PendingLogin = { startedAt: new Date().toISOString(), controller, urlReady };
      pending = entry;
      lastError = undefined;
      void deps
        .browserLogin(r, {
          renownUrl: opts.renownUrl,
          timeoutMs: opts.loginTimeoutMs,
          signal: controller.signal,
          onLoginUrl: (url) => {
            entry.url = url;
            resolveUrl(url);
          },
        })
        .then(() => tighten())
        .catch((error: unknown) => {
          lastError = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          if (pending === entry) pending = null;
          resolveUrl(entry.url);
        });
      const url = await Promise.race([urlReady, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), URL_WAIT_MS))]);
      return { url, alreadyAuthenticated: false };
    },

    cancelLogin(): void {
      pending?.controller.abort();
    },

    async logout(): Promise<void> {
      await (await get()).logout();
      lastError = undefined;
    },

    /** A bearer for a Switchboard, minted locally; no audience (a verifier rejects an audience it was not configured for). */
    async token(expiresIn = 3600): Promise<AccessToken> {
      const r = await get();
      if (isExpired(r)) throw new Error(EXPIRED_MESSAGE);
      const t = await deps.generateAccessToken(r, { expiresIn });
      return { token: t.token, expiresAt: new Date(Date.now() + t.expiresIn * 1000).toISOString(), address: t.address, did: t.did };
    },
  };
}
export type Identity = ReturnType<typeof createIdentity>;
