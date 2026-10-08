import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cancelChatGptSignIn, CHATGPT_USAGE_URL, fetchChatGptStatus, signOutOfChatGpt, startChatGptSignIn, type ChatGptStatus } from "../api/chatgpt.js";
import { openInBrowser } from "../api/oauth.js";
import type { SidecarInfo } from "../sidecar.js";

/**
 * "Continue with ChatGPT": the user's ChatGPT plan as the app's AI model, through OpenAI's Sign in with ChatGPT
 * for open-source and locally hosted apps. The engine builds the sign-in link and keeps the tokens; this section
 * opens the link in the system browser, follows the engine's status, and offers sign-out. Self-contained: the
 * screen that shows it decides where (onboarding, Settings › Models) and what to do once signed in (`onStatus`).
 *
 * Wording and button follow OpenAI's guidelines (developers.openai.com/siwc/ui-ux-guidelines and /siwc/website):
 * the "Continue with ChatGPT" label in one of the approved formats (black or white, with the ChatGPT mark),
 * "Use your ChatGPT plan", a one-time "You're using your ChatGPT plan", "Using ChatGPT plan" with "Manage usage",
 * and "Usage limit reached" pointing to ChatGPT settings.
 */
export type ChatGptApi = {
  status: (info: SidecarInfo) => Promise<ChatGptStatus>;
  start: (info: SidecarInfo, options: { newAccount?: boolean; allowPlanUsage?: boolean }) => Promise<{ url: string }>;
  cancel: (info: SidecarInfo) => Promise<unknown>;
  signOut: (info: SidecarInfo) => Promise<{ revoked: boolean }>;
  /** Opens the sign-in link in the system browser; the engine never opens a browser itself. */
  open: (url: string) => Promise<void>;
};
export const realChatGptApi: ChatGptApi = {
  status: (info) => fetchChatGptStatus(info),
  start: (info, options) => startChatGptSignIn(info, options),
  cancel: (info) => cancelChatGptSignIn(info),
  signOut: (info) => signOutOfChatGpt(info),
  open: openInBrowser,
};

const POLL_MS = 2000;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The ChatGPT mark, from OpenAI's sign-in button assets (developers.openai.com/assets/siwc/sign-in-buttons/), in the text colour. */
const LOGO =
  "M11.8102 19.1625C11.2327 19.1625 10.6841 19.0528 10.1643 18.8334C9.64459 18.6139 9.18259 18.3078 8.77834 17.9151C8.33944 18.0653 7.88322 18.1404 7.40967 18.1404C6.63582 18.1404 5.91972 17.9498 5.26137 17.5686C4.60302 17.1875 4.07172 16.6677 3.66747 16.0094C3.27477 15.351 3.07842 14.6176 3.07842 13.8091C3.07842 13.4742 3.12462 13.1103 3.21702 12.7176C2.75502 12.2903 2.39697 11.7994 2.14287 11.245C1.88877 10.679 1.76172 10.09 1.76172 9.47785C1.76172 8.85415 1.89454 8.25355 2.16019 7.67605C2.42584 7.09855 2.79544 6.6019 3.26899 6.1861C3.75409 5.75875 4.31427 5.46422 4.94952 5.30252C5.07657 4.64417 5.34222 4.05512 5.74647 3.53537C6.16227 3.00407 6.67047 2.58827 7.27107 2.28797C7.87167 1.98767 8.51269 1.83752 9.19414 1.83752C9.77164 1.83752 10.3203 1.94725 10.84 2.1667C11.3598 2.38615 11.8218 2.69222 12.226 3.08492C12.6649 2.93477 13.1211 2.8597 13.5947 2.8597C14.3685 2.8597 15.0846 3.05027 15.743 3.43142C16.4013 3.81257 16.9269 4.33232 17.3196 4.99067C17.7238 5.64902 17.9259 6.38245 17.9259 7.19095C17.9259 7.5259 17.8797 7.88973 17.7873 8.28242C18.2493 8.70977 18.6074 9.20643 18.8615 9.77238C19.1156 10.3268 19.2426 10.91 19.2426 11.5222C19.2426 12.1459 19.1098 12.7465 18.8442 13.324C18.5785 13.9015 18.2031 14.4039 17.718 14.8313C17.2445 15.2471 16.6901 15.5358 16.0548 15.6975C15.9278 16.3559 15.6564 16.9449 15.2406 17.4647C14.8363 17.996 14.3339 18.4118 13.7333 18.7121C13.1327 19.0124 12.4917 19.1625 11.8102 19.1625ZM7.53094 16.9969C8.10844 16.9969 8.61087 16.8756 9.03822 16.6331L12.2953 14.762C12.4108 14.6811 12.4686 14.5714 12.4686 14.4328V12.9429L8.27592 15.351C8.02182 15.5012 7.76772 15.5012 7.51362 15.351L4.23919 13.4626C4.23919 13.4973 4.23342 13.5377 4.22187 13.5839C4.22187 13.6301 4.22187 13.6994 4.22187 13.7918C4.22187 14.3808 4.36047 14.9237 4.63767 15.4203C4.92642 15.9054 5.32489 16.2866 5.83309 16.5638C6.34129 16.8525 6.90724 16.9969 7.53094 16.9969ZM7.70419 14.1729C7.77349 14.2076 7.83702 14.2249 7.89477 14.2249C7.95252 14.2249 8.01027 14.2076 8.06802 14.1729L9.36739 13.4279L5.19207 11.0024C4.93797 10.8523 4.81092 10.6271 4.81092 10.3268V6.56725C4.23342 6.82135 3.77142 7.21405 3.42492 7.74535C3.07842 8.2651 2.90517 8.8426 2.90517 9.47785C2.90517 10.0438 3.04954 10.5866 3.33829 11.1064C3.62704 11.6261 4.00242 12.0189 4.46442 12.2845L7.70419 14.1729ZM11.8102 18.0191C12.4224 18.0191 12.9768 17.8805 13.4734 17.6033C13.9701 17.3261 14.3628 16.9449 14.6515 16.4598C14.9403 15.9747 15.0846 15.4319 15.0846 14.8313V11.0891C15.0846 10.9505 15.0269 10.8465 14.9114 10.7772L13.5947 10.0149V14.8486C13.5947 15.1489 13.4676 15.3741 13.2135 15.5243L9.93912 17.4127C10.5051 17.817 11.1288 18.0191 11.8102 18.0191ZM12.4686 11.6781V9.32192L10.5108 8.21312L8.53579 9.32192V11.6781L10.5108 12.7869L12.4686 11.6781ZM7.40967 6.15145C7.40967 5.85115 7.53672 5.62592 7.79082 5.47577L11.0652 3.58735C10.4993 3.1831 9.87559 2.98097 9.19414 2.98097C8.58199 2.98097 8.02759 3.11957 7.53094 3.39677C7.03429 3.67397 6.64159 4.05512 6.35284 4.54022C6.07564 5.02532 5.93704 5.56817 5.93704 6.16878V9.89365C5.93704 10.0323 5.99479 10.142 6.11029 10.2228L7.40967 10.9851V6.15145ZM16.2108 14.4328C16.7883 14.1787 17.2445 13.786 17.5794 13.2547C17.9259 12.7234 18.0992 12.1459 18.0992 11.5222C18.0992 10.9562 17.9548 10.4134 17.6661 9.89365C17.3773 9.3739 17.0019 8.9812 16.5399 8.71555L13.3002 6.84445C13.2309 6.79825 13.1673 6.78092 13.1096 6.79248C13.0518 6.79248 12.9941 6.8098 12.9363 6.84445L11.637 7.5721L15.8296 10.0149C15.9567 10.0842 16.0491 10.1766 16.1068 10.2921C16.1761 10.3961 16.2108 10.5231 16.2108 10.6733V14.4328ZM12.7284 5.6317C12.9825 5.47 13.2366 5.47 13.4907 5.6317L16.7825 7.55477C16.7825 7.47393 16.7825 7.36997 16.7825 7.24292C16.7825 6.68852 16.6439 6.163 16.3667 5.66635C16.101 5.15815 15.7141 4.7539 15.2059 4.4536C14.7093 4.1533 14.1318 4.00315 13.4734 4.00315C12.8959 4.00315 12.3935 4.12442 11.9661 4.36697L8.70904 6.23808C8.59354 6.31892 8.53579 6.42865 8.53579 6.56725V8.0572L12.7284 5.6317Z";

export function ChatGptLogo({ size = 21 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 21 21" aria-hidden="true" focusable="false">
      <path d={LOGO} fill="currentColor" />
    </svg>
  );
}

/**
 * OpenAI's "Continue with ChatGPT" button in an approved format: 45 px high, 12 px corners, 20 px sides, the mark
 * 12 px from a 15 px medium label, 242 px wide — black on the light theme, white on the dark one.
 */
export function ContinueWithChatGpt({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="kv-chatgpt-continue" onClick={onClick} disabled={disabled}>
      <ChatGptLogo />
      <span>Continue with ChatGPT</span>
    </button>
  );
}

/** Scoped to this section: the shell's stylesheet stays untouched. */
const STYLE = `
.kv-chatgpt .kv-chatgpt-continue { display: inline-flex; align-items: center; justify-content: center; gap: 12px; box-sizing: border-box; width: 242px; max-width: 100%; height: 45px; padding: 0 20px; border: 0; border-radius: 12px; background: #000; color: #fff; font: 500 15px/18px "Inter Variable", Inter, system-ui, sans-serif; letter-spacing: 0; cursor: pointer; }
[data-bai-theme="dark"] .kv-chatgpt .kv-chatgpt-continue { background: #fff; color: #000; }
.kv-chatgpt .kv-chatgpt-continue:disabled { opacity: 0.6; cursor: default; }
.kv-chatgpt .kv-chatgpt-continue:focus-visible { outline: 2px solid var(--bai-text, #000); outline-offset: 2px; }
.kv-chatgpt .kv-chatgpt-continue svg { flex: none; }
.kv-chatgpt .kv-chatgpt-title { margin: 0; font-weight: 600; }
.kv-chatgpt .kv-chatgpt-text { margin: 0; }
.kv-chatgpt .kv-chatgpt-note { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px 14px; border: 1px solid var(--bai-border); border-radius: 10px; }
.kv-chatgpt .kv-chatgpt-note p { margin: 0; }
`;

/** The engine's ChatGPT sign-in, polled while a browser sign-in is pending. */
export function ChatGptConnect({ info, api = realChatGptApi, pollMs = POLL_MS, onStatus, compact = false }: { info: SidecarInfo; api?: ChatGptApi; pollMs?: number; onStatus?: (status: ChatGptStatus) => void; /** In a provider card not chosen yet: the button alone (or one line), nothing else. */ compact?: boolean }) {
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [welcome, setWelcome] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const previous = useRef<ChatGptStatus | null>(null);
  /** A sign-in started from here: its end shows the one-time confirmation. */
  const startedHere = useRef(false);
  const reportStatus = useRef(onStatus);
  useEffect(() => {
    reportStatus.current = onStatus;
  }, [onStatus]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.status(info);
      if (!alive.current) return;
      const before = previous.current;
      previous.current = next;
      if (startedHere.current && before?.pending && !next.pending) {
        startedHere.current = false;
        // Only the sign-in that registered the app for this account: OpenAI asks for it once, not at every sign-in.
        if (next.signedIn && next.planUsage && next.firstSignIn) setWelcome(true);
      }
      setStatus(next);
      setError(null);
      reportStatus.current?.(next);
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    }
  }, [api, info]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While the browser sign-in is pending, ask again every couple of seconds.
  useEffect(() => {
    if (!status?.pending) return;
    const handle = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(handle);
  }, [status?.pending, refresh, pollMs]);

  const signIn = useCallback(
    async (options: { newAccount?: boolean; allowPlanUsage?: boolean } = {}) => {
      setError(null);
      setNotice(null);
      setBusy(true);
      try {
        const { url } = await api.start(info, options);
        startedHere.current = true;
        await api.open(url);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
      await refresh();
    },
    [api, info, refresh],
  );
  const cancel = useCallback(async () => {
    startedHere.current = false;
    await api.cancel(info).catch(() => {});
    await refresh();
  }, [api, info, refresh]);
  const signOut = useCallback(async () => {
    setError(null);
    setNotice(null);
    setWelcome(false);
    setBusy(true);
    try {
      const { revoked } = await api.signOut(info);
      if (!revoked) setNotice("Signed out on this computer. ChatGPT did not confirm that the sign-in was revoked: to be sure, disconnect Knowledge Vault in ChatGPT settings.");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
    await refresh();
  }, [api, info, refresh]);

  const frame = (body: ReactNode) => (
    <div className={compact ? "kv-chatgpt kv-chatgpt-compact" : "kv-settings-body kv-chatgpt"}>
      <style>{STYLE}</style>
      {body}
      {!compact && notice && (
        <p role="status" className="kv-hint">
          {notice} <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Open ChatGPT settings</a>
        </p>
      )}
      {!compact && (error ?? status?.lastError) && (
        <p role="alert" className="kv-error">
          {error ?? status?.lastError}
        </p>
      )}
    </div>
  );

  if (!status) return frame(compact ? <ContinueWithChatGpt onClick={() => void signIn()} disabled /> : <p className="kv-quiet" role="status">{error ? "" : "…"}</p>);
  if (compact && status.pending) return frame(<p role="status" className="kv-identity-waiting">Waiting for the browser…</p>);
  if (compact && status.signedIn && status.planUsage) {
    const who = status.account?.email ?? status.account?.name;
    return frame(<p className="kv-hint">Signed in{who ? ` as ${who}` : ""}. Choose this card to use your plan.</p>);
  }
  if (compact) return frame(<ContinueWithChatGpt onClick={() => void signIn()} disabled={busy} />);

  if (status.pending) {
    return frame(
      <div className="kv-identity-card">
        <p className="kv-chatgpt-text">Finish signing in to ChatGPT in your browser, then come back here.</p>
        <p role="status" className="kv-identity-waiting">
          Waiting for the browser…
        </p>
        <p className="kv-hint">
          If it did not open,{" "}
          <a href={status.pending.url} target="_blank" rel="noreferrer">
            open the sign-in page
          </a>
          .
        </p>
        <div className="kv-form-actions">
          <button type="button" className="kv-button" onClick={() => void cancel()}>
            Cancel
          </button>
        </div>
      </div>,
    );
  }

  const who = status.account?.email ?? status.account?.name;
  if (status.signedIn && status.planUsage) {
    return frame(
      <div className="kv-identity-card">
        {welcome && (
          <div role="status" className="kv-chatgpt-note">
            <ChatGptLogo />
            <p className="kv-chatgpt-title">You're using your ChatGPT plan</p>
            <p>Eligible AI requests in Knowledge Vault now use your ChatGPT plan. You can review usage and this app's limit in ChatGPT settings.</p>
            <button type="button" className="kv-button kv-button-primary" onClick={() => setWelcome(false)}>
              Got it
            </button>
          </div>
        )}
        <div className="kv-identity-row">
          <ChatGptLogo size={18} />
          <span>Using ChatGPT plan</span>
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
            Manage usage
          </a>
        </div>
        {who && (
          <p className="kv-hint">
            Signed in as {who}
            {status.account?.plan ? ` (${status.account.plan})` : ""}.
          </p>
        )}
        {status.usageLimit && (
          <div role="alert" className="kv-chatgpt-note">
            <ChatGptLogo size={18} />
            <p className="kv-chatgpt-title">Usage limit reached</p>
            <p>Review your plan or this app's limit in ChatGPT settings.</p>
            <a className="kv-button kv-button-primary" href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
              Manage usage
            </a>
          </div>
        )}
        <div className="kv-form-actions">
          <button type="button" className="kv-button" onClick={() => void signOut()} disabled={busy}>
            Sign out
          </button>
        </div>
      </div>,
    );
  }

  if (status.signedIn) {
    return frame(
      <div className="kv-identity-card">
        <p className="kv-chatgpt-text">
          You're signed in to ChatGPT{who ? ` as ${who}` : ""}, but Knowledge Vault isn't allowed to use your ChatGPT plan, so it can't run AI requests with it.
        </p>
        <ContinueWithChatGpt onClick={() => void signIn({ allowPlanUsage: true })} disabled={busy} />
        <p className="kv-hint">ChatGPT asks again whether Knowledge Vault may use your plan.</p>
        <div className="kv-form-actions">
          <button type="button" className="kv-button" onClick={() => void signOut()} disabled={busy}>
            Sign out
          </button>
        </div>
      </div>,
    );
  }

  return frame(
    <div className="kv-identity-card">
      <p className="kv-chatgpt-title">Use your ChatGPT plan</p>
      <p className="kv-chatgpt-text">
        Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance. No API key needed, and Knowledge Vault itself charges nothing.
      </p>
      <ContinueWithChatGpt onClick={() => void signIn()} disabled={busy} />
      <p className="kv-hint">Your browser opens; the app stays here and picks the sign-in up when you're done.</p>
      {status.savedAccount && (
        <p className="kv-hint">
          {status.savedAccount.email ? `Last signed in as ${status.savedAccount.email}.` : "An account was signed in before."}
          <button type="button" className="kv-link-button" onClick={() => void signIn({ newAccount: true })} disabled={busy}>
            Use a different ChatGPT account
          </button>
        </p>
      )}
    </div>,
  );
}
