/**
 * Renown's browser sign-in, without opening a browser.
 *
 * The SDK's own browserLogin opens the link itself, and on Windows it does so
 * through `cmd /c start`, where `&` separates commands: the link loses its
 * `connect` and `app` parameters and Renown answers "missing the CLI identity".
 * Here the engine only builds the link, reports it and polls; the window opens
 * it with Tauri's opener, which hands the whole URL to the operating system.
 */
export type RenownForLogin = {
  did: string;
  login(did: string): Promise<{ address: string; did: string }>;
};
export type RenownLoginOptions = {
  renownUrl: string;
  timeoutMs?: number;
  onLoginUrl?: (url: string, sessionId: string) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 500;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Sign-in cancelled.");
}

export async function renownLogin(
  renown: RenownForLogin,
  options: RenownLoginOptions,
): Promise<{ user: { address: string; did: string }; cliDid: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const sessionId = crypto.randomUUID();
  const loginUrl = new URL("/console", options.renownUrl);
  loginUrl.searchParams.set("session", sessionId);
  loginUrl.searchParams.set("connect", renown.did);
  loginUrl.searchParams.set("app", renown.did);
  options.onLoginUrl?.(loginUrl.toString(), sessionId);

  const sessionUrl = new URL(`/api/console/session/${sessionId}`, options.renownUrl).toString();
  const started = now();
  while (now() - started < timeoutMs) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      const response = await fetchImpl(sessionUrl, { signal: options.signal });
      if (response.ok) {
        const data = (await response.json()) as { status?: string; did?: string };
        if (data.status === "ready" && data.did) {
          return { user: await renown.login(data.did), cliDid: renown.did };
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal);
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // A network hiccup: keep polling until the deadline.
    }
    await sleep(POLL_INTERVAL_MS);
    if (options.signal?.aborted) throw abortError(options.signal);
  }
  throw new Error("Authentication timed out.");
}
