import { useRef, type KeyboardEvent, type ReactNode } from "react";

export type Choice = "local" | "chatgpt" | "openrouter" | "apikey";
export type ApiService = "openai" | "anthropic" | "gemini" | "xai" | "custom";

const CHOICES: ReadonlyArray<{ id: Choice; title: string; line: string }> = [
  { id: "local", title: "On this computer", line: "A model running here: free, private, no key." },
  { id: "openrouter", title: "OpenRouter", line: "One account, hundreds of models, pay as you go." },
  { id: "apikey", title: "API key", line: "OpenAI, Anthropic, Google Gemini, xAI or another service." },
  // Sign-in with a person's own AI plan comes last: a row of the providers' buttons (more to come), and the card
  // of the one chosen.
  { id: "chatgpt", title: "ChatGPT", line: "Use your ChatGPT Plus or Pro plan: just sign in, no key." },
];

/** The services behind the "API key" card: where each one's keys come from, and what its keys look like. */
const SERVICES: ReadonlyArray<{ id: ApiService; name: string; keyPage?: string; keyLooksLike: string }> = [
  { id: "openai", name: "OpenAI", keyPage: "https://platform.openai.com/api-keys", keyLooksLike: "sk-…" },
  { id: "anthropic", name: "Anthropic", keyPage: "https://console.anthropic.com/settings/keys", keyLooksLike: "sk-ant-…" },
  { id: "gemini", name: "Google Gemini", keyPage: "https://aistudio.google.com/apikey", keyLooksLike: "AIza…" },
  { id: "xai", name: "xAI", keyPage: "https://console.x.ai", keyLooksLike: "xai-…" },
  { id: "custom", name: "Another service", keyLooksLike: "Paste a key, if the service needs one" },
];

/** With no key saved or pasted yet, signing in is the one thing to do on the OpenRouter card; Save waits. */
export const signInFirst = (hasKey: boolean, apiKey: string): boolean => !hasKey && !apiKey.trim();

/** Which card an arrow key leads to from card `index` of `count` (the ends wrap round), or null for any other key. */
function cardAfterKey(key: string, index: number, count: number): number | null {
  const last = count - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return index === last ? 0 : index + 1;
  if (key === "ArrowUp" || key === "ArrowLeft") return index === 0 ? last : index - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  return null;
}

type Props = {
  choice: Choice;
  onChoice: (c: Choice) => void;
  service: ApiService;
  onService: (s: ApiService) => void;
  customEndpoint: string;
  onCustomEndpoint: (v: string) => void;
  apiKey: string;
  onApiKey: (v: string) => void;
  /** A key for the chosen provider is saved in the engine: leaving the field empty keeps it. */
  hasKey: boolean;
  onOpenRouterSignIn: () => void;
  signingIn: boolean;
  /** The existing `<LocalModel …/>`. */
  localBlock: ReactNode;
  /** The ChatGPT card's body (`<ChatGptChoice …/>`); without it the card is not offered. */
  chatgptBlock?: ReactNode;
  /** The form is busy saving. */
  disabled?: boolean;
  /** Drops the saved key; the button sits beside the key field while one is saved. */
  onRemoveKey?: () => void;
};

/**
 * Settings › Models: where the AI model comes from, as three radio cards — a model on this computer, OpenRouter,
 * an API key for a named service. The chosen card opens to what it needs; the others stay one line.
 * Arrow keys move between the cards and choose as they go; only the chosen card is a tab stop.
 */
export function ProviderChoice(props: Props) {
  const { choice, onChoice } = props;
  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  // ChatGPT is a card only once chosen. Until then it is one button, "Continue with ChatGPT": the button says what it
  // is, and signing in (or, already signed in, pressing it) chooses it. So the arrow keys move between the cards only.
  const chatgptAsButton = props.chatgptBlock !== undefined && choice !== "chatgpt";
  const offered = CHOICES.filter((c) => c.id !== "chatgpt" || (props.chatgptBlock !== undefined && !chatgptAsButton));

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const to = cardAfterKey(e.key, index, offered.length);
    const next = to === null ? undefined : offered[to];
    if (to === null || !next) return;
    e.preventDefault();
    if (to !== index) onChoice(next.id);
    cards.current[to]?.focus();
  }

  return (
    <div className="kv-providers" role="radiogroup" aria-label="AI model provider">
      {CHOICES.map((c) => {
        const index = offered.indexOf(c);
        if (index === -1) return null;
        const checked = c.id === choice;
        return (
          <div key={c.id} className="kv-provider" data-selected={checked}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className="kv-provider-head"
              ref={(el) => {
                cards.current[index] = el;
              }}
              onClick={() => {
                if (!checked) onChoice(c.id);
              }}
              onKeyDown={(e) => onKeyDown(e, index)}
            >
              <span className="kv-provider-mark" aria-hidden="true" />
              <span className="kv-provider-title">{c.title}</span>{" "}
              <span className="kv-provider-line">{c.line}</span>
            </button>
            {checked && (
              <div className="kv-provider-body">
                {c.id === "local" && props.localBlock}
                {c.id === "chatgpt" && props.chatgptBlock}
                {c.id === "openrouter" && <OpenRouterCard {...props} />}
                {c.id === "apikey" && <ApiKeyCard {...props} />}
              </div>
            )}
          </div>
        );
      })}
      {chatgptAsButton && (
        // The providers' own sign-in buttons, side by side (ChatGPT for now).
        <div className="kv-provider-plain">{props.chatgptBlock}</div>
      )}
    </div>
  );
}

function OpenRouterCard({ apiKey, onApiKey, hasKey, onOpenRouterSignIn, signingIn, disabled, onRemoveKey }: Props) {
  return (
    <>
      <div className="kv-provider-signin">
        <button
          type="button"
          className={signInFirst(hasKey, apiKey) ? "kv-button kv-button-primary" : "kv-button"}
          onClick={onOpenRouterSignIn}
          disabled={disabled || signingIn}
        >
          {signingIn ? "Waiting for the browser…" : "Sign in with OpenRouter"}
        </button>
        <span className="kv-provider-or">or paste a key</span>
      </div>
      {signingIn && <p className="kv-hint" role="status">Finish signing in on the page that opened in your browser, then come back here.</p>}
      <KeyField apiKey={apiKey} onApiKey={onApiKey} hasKey={hasKey} looksLike="sk-or-…" disabled={disabled} onRemoveKey={onRemoveKey} />
    </>
  );
}

function ApiKeyCard({ service, onService, customEndpoint, onCustomEndpoint, apiKey, onApiKey, hasKey, disabled, onRemoveKey }: Props) {
  const current = SERVICES.find((s) => s.id === service) ?? SERVICES[0]!;
  return (
    <>
      <label htmlFor="models-service">Service</label>
      <div className="kv-form-inline">
        <select
          id="models-service"
          value={current.id}
          onChange={(e) => {
            const next = SERVICES.find((s) => s.id === e.target.value);
            if (next) onService(next.id);
          }}
          aria-describedby={current.id === "gemini" ? "models-service-note" : undefined}
          disabled={disabled}
        >
          {SERVICES.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        {current.keyPage && (
          <a className="kv-provider-keylink" href={current.keyPage} target="_blank" rel="noreferrer" title="Opens in your browser">Get a key</a>
        )}
      </div>
      {current.id === "gemini" && <p id="models-service-note" className="kv-hint">Free tier: Google uses what you send to improve its products.</p>}
      {current.id === "custom" && (
        <>
          <label htmlFor="models-endpoint">Address</label>
          <input
            id="models-endpoint"
            value={customEndpoint}
            onChange={(e) => onCustomEndpoint(e.target.value)}
            placeholder="https://api.example.com/v1"
            aria-describedby="models-endpoint-hint"
            disabled={disabled}
          />
          <p id="models-endpoint-hint" className="kv-hint">For a service that follows the OpenAI API. The address usually ends in /v1.</p>
        </>
      )}
      <KeyField apiKey={apiKey} onApiKey={onApiKey} hasKey={hasKey} looksLike={current.keyLooksLike} disabled={disabled} onRemoveKey={onRemoveKey} />
    </>
  );
}

/** The key, kept by the engine and never shown again: empty means "keep the saved one". */
function KeyField({ apiKey, onApiKey, hasKey, looksLike, disabled, onRemoveKey }: { apiKey: string; onApiKey: (v: string) => void; hasKey: boolean; looksLike: string; disabled?: boolean; onRemoveKey?: () => void }) {
  return (
    <>
      <label htmlFor="models-key">API key</label>
      <div className="kv-form-inline">
        <input
          id="models-key"
          type="password"
          value={apiKey}
          onChange={(e) => onApiKey(e.target.value)}
          placeholder={hasKey ? "Saved — leave empty to keep it" : looksLike}
          autoComplete="off"
          aria-describedby="models-key-hint"
          disabled={disabled}
        />
        {hasKey && onRemoveKey && (
          <button type="button" className="kv-button kv-button-danger-quiet" onClick={onRemoveKey} disabled={disabled}>Remove key</button>
        )}
      </div>
      <p id="models-key-hint" className="kv-hint">The key is stored by the engine on this computer (file mode 0600) and is never shown again.</p>
    </>
  );
}
