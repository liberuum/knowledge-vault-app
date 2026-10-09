import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { SidecarInfo } from "../sidecar.js";
import { signInWithOpenRouter } from "../api/openrouter.js";
import { announceModelsChanged } from "../model-declaration.js";
import { DEFAULT_LOCAL_ENDPOINT } from "../settings/LocalModel.js";
import { ModelPicker } from "../settings/ModelPicker.js";
import { useDebounced } from "../settings/use-debounced.js";
import { formatPrice, recommendedModels, type CatalogModel } from "../settings/model-picker.js";
import { ProviderChoice, type ApiService, type Choice } from "../settings/ProviderChoice.js";
import { ChatGptChoice } from "../settings/ChatGptChoice.js";
import {
  discoverLocalModels,
  fetchModelCatalog, fetchModelCatalogFor,
  fetchSettings,
  probeLocalModels,
  saveSettings,
  type AppSettings,
  type DiscoveredModel,
  type DiscoveredServer,
  type LocalDiscovery,
  type LocalProbe,
  type ModelSettings,
  type SettingsPatch,
} from "../vaults.js";
import { checkModel } from "./api.js";
import { modelReady } from "./onboarding-state.js";

/** A model on this computer or the network; `typed` when it came from an address the person entered. */
type Pick = { endpoint: string; model: string; typed?: boolean };
type Found = { server: DiscoveredServer; model: DiscoveredModel };
type Phase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "checking"; model: string; local: boolean }
  | { kind: "ready"; message: string }
  | { kind: "failed"; message: string };

const IDLE: Phase = { kind: "idle" };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const seconds = (ms: number) => (ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000)));

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return endpoint;
  }
}
const onThisComputer = (endpoint: string) => {
  const h = hostOf(endpoint).toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
};

/** The card a saved model setting belongs to. */
function cardOf(m: ModelSettings): { choice: Choice; service: ApiService; customEndpoint: string } {
  if (m.provider === "local") return { choice: "local", service: "openai", customEndpoint: "" };
  if (m.provider === "chatgpt") return { choice: "chatgpt", service: "openai", customEndpoint: "" };
  if (m.provider === "openrouter") return { choice: "openrouter", service: "openai", customEndpoint: "" };
  if (m.provider === "custom") return { choice: "apikey", service: "custom", customEndpoint: m.endpoint };
  return { choice: "apikey", service: m.provider, customEndpoint: "" };
}

/** What Save sends for a hosted card; the key only when one was entered (the engine keeps the saved one). */
function hostedPatch(choice: Exclude<Choice, "local" | "chatgpt">, service: ApiService, customEndpoint: string, model: string, apiKey: string): NonNullable<SettingsPatch["models"]> {
  const key = apiKey.trim() ? { apiKey: apiKey.trim() } : {};
  if (choice === "openrouter") return { provider: "openrouter", model, ...key };
  if (service === "custom") return { endpoint: customEndpoint.trim(), model, ...key };
  return { provider: service, model, ...key };
}

/** A model on this computer in a newcomer's words (Six Minds, Language): no ports or token counts. */
function plainFound(server: DiscoveredServer, model: DiscoveredModel): string {
  const state = model.loaded === false ? "it loads when first used, so the first answer takes longer" : "ready to use";
  const short = model.contextLength !== null && model.contextLength < 16_384 ? " It reads only short texts at once, so long sources will be cut." : "";
  return `In ${server.provider}, ${state}.${short}`;
}

/** The found model to preselect: a loaded one before one still to load, then the one that reads the most at once. */
function bestFound(d: LocalDiscovery | null): Found | null {
  const all = d?.servers.flatMap((server) => server.models.map((model) => ({ server, model }))) ?? [];
  const score = (f: Found) => (f.model.loaded === true ? 2 : f.model.loaded === null ? 1 : 0) * 1e9 + (f.model.contextLength ?? 0);
  return [...all].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** The default hosted model (review I5): among the ones recommended for processing, the best value — not the dearest. */
function goodValue(models: readonly CatalogModel[]): CatalogModel | undefined {
  const cost = (m: CatalogModel) => (m.promptPrice ?? Infinity) + (m.completionPrice ?? Infinity);
  return [...recommendedModels(models, 8)].sort((a, b) => cost(a) - cost(b))[0];
}

/**
 * Choose the AI (spec §5, step 2): what this computer runs comes first and preselected; OpenRouter and an API key
 * follow. Use saves it and asks the model one tiny question through the engine — "Ready" is a real answer, timed.
 */
export function AiStep({ info, onBack, onContinue }: { info: SidecarInfo; onBack: () => void; onContinue: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [found, setFound] = useState<LocalDiscovery | null>(null);
  const [scanning, setScanning] = useState(true);
  const [choice, setChoice] = useState<Choice>("local");
  const [pick, setPick] = useState<Pick | null>(null);
  const [service, setService] = useState<ApiService>("openai");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [catalog, setCatalog] = useState<readonly CatalogModel[]>([]);
  const [signingIn, setSigningIn] = useState(false);
  const [phase, setPhase] = useState<Phase>(IDLE);
  // Once the person chose (or a model was already set up), the scan no longer moves the choice.
  const settled = useRef(false);

  const applyFound = useCallback((d: LocalDiscovery | null) => {
    const best = bestFound(d);
    const served = (p: Pick) => d?.servers.some((s) => s.endpoint === p.endpoint && s.models.some((m) => m.id === p.model)) ?? false;
    setPick((p) => (p && (p.typed || served(p)) ? p : best ? { endpoint: best.server.endpoint, model: best.model.id } : null));
    // The local card always leads, found or not: it says what runs here, or how to get a model and what size fits.
    // ChatGPT stays the sign-in button below the cards; it becomes the chosen card only once it is signed in.
    if (!settled.current) setChoice("local");
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const d = await discoverLocalModels(info);
      setFound(d);
      applyFound(d);
    } catch {
      setFound(null);
      applyFound(null);
    } finally {
      setScanning(false);
    }
  }, [info, applyFound]);

  // Vision: the cards show as soon as the settings answer; the scan fills the first card when it is done.
  useEffect(() => {
    let alive = true;
    fetchSettings(info)
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        if (modelReady(s.models)) {
          settled.current = true;
          const card = cardOf(s.models);
          setChoice(card.choice);
          setService(card.service);
          setCustomEndpoint(card.customEndpoint);
          if (s.models.local) setPick({ endpoint: s.models.endpoint, model: s.models.model, typed: true });
          else setModel(s.models.model);
          setPhase({ kind: "ready", message: `Using ${s.models.model}.` });
        }
      })
      .catch((e: unknown) => alive && setLoadError(message(e)));
    void scan();
    return () => {
      alive = false;
    };
  }, [info, scan]);

  const saved = settings ? cardOf(settings.models) : null;
  const onSavedCard = saved !== null && saved.choice === choice && (choice !== "apikey" || saved.service === service);
  const keySaved = onSavedCard && settings?.models.hasKey === true;
  const catalogEndpoint = choice === "apikey" && service === "custom" && customEndpoint.trim() ? customEndpoint.trim() : settings?.models.endpoint;
  // A key just entered lists its service's models before it is saved.
  const typedKey = useDebounced(apiKey.trim(), 500);
  const listsTypedKey = typedKey !== "" && (choice === "openrouter" || (choice === "apikey" && (service !== "custom" || customEndpoint.trim() !== "")));
  const canList = keySaved || listsTypedKey;
  const loadCatalog = useCallback(
    () =>
      listsTypedKey
        ? fetchModelCatalogFor(info, { provider: choice === "openrouter" ? "openrouter" : service, endpoint: customEndpoint.trim(), apiKey: typedKey })
        : fetchModelCatalog(info, catalogEndpoint),
    [info, catalogEndpoint, listsTypedKey, choice, service, customEndpoint, typedKey],
  );

  // A key for this card is saved: list what it can use, and choose the best value for processing if nothing is chosen.
  useEffect(() => {
    if (choice === "local" || !canList) return;
    let alive = true;
    loadCatalog()
      .then((c) => {
        if (!alive || !c.ok) return;
        setCatalog(c.models);
        const best = goodValue(c.models)?.id;
        if (best) setModel((m) => m || best);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [choice, canList, loadCatalog]);

  /** A different card keeps no model from another provider. */
  const switchTo = (c: Choice, s: ApiService) => {
    settled.current = true;
    setChoice(c);
    setService(s);
    setPhase(IDLE);
    setApiKey("");
    setCatalog([]);
    const same = saved !== null && saved.choice === c && (c !== "apikey" || saved.service === s);
    setModel(same && settings && !settings.models.local ? settings.models.model : "");
  };

  /** Ask the model saved now for one tiny answer, timed: "Ready" is a real answer. */
  async function check(next: AppSettings) {
    setPhase({ kind: "checking", model: next.models.model, local: next.models.local === true });
    try {
      const verdict = await checkModel(info);
      setPhase(verdict.ok ? { kind: "ready", message: `Ready: ${next.models.model} answered in ${seconds(verdict.ms)} s.` } : { kind: "failed", message: verdict.detail });
    } catch (e) {
      setPhase({ kind: "failed", message: message(e) });
    }
  }

  /** Signed in with ChatGPT and its default model saved by the card: read the setting back, then check it. */
  async function afterChatGpt() {
    settled.current = true;
    try {
      const next = await fetchSettings(info);
      setSettings(next);
      if (modelReady(next.models)) await check(next);
    } catch (e) {
      setPhase({ kind: "failed", message: message(e) });
    }
  }

  async function use(local?: Pick) {
    if (!local && choice === "chatgpt") {
      if (settings?.models.provider !== "chatgpt" || !settings.models.hasKey) return setPhase({ kind: "failed", message: "Continue with ChatGPT first: sign in on the page that opens." });
      return check(settings);
    }
    setPhase({ kind: "saving" });
    try {
      let next: AppSettings;
      if (local || choice === "local") {
        const p = local ?? pick;
        if (!p) return setPhase({ kind: "failed", message: "Choose a model first." });
        next = await saveSettings(info, { models: { endpoint: p.endpoint, model: p.model } });
      } else {
        if (choice === "apikey" && service === "custom" && !customEndpoint.trim()) return setPhase({ kind: "failed", message: "Enter the address of the service." });
        next = await saveSettings(info, { models: hostedPatch(choice as Exclude<Choice, "local" | "chatgpt">, service, customEndpoint, model, apiKey) });
        if (!next.models.model.trim()) {
          // A key, no model yet: the best value the key can use for processing.
          const c = await fetchModelCatalog(info);
          const best = c.ok ? goodValue(c.models)?.id : undefined;
          if (!best) return setPhase({ kind: "failed", message: c.ok ? "Choose a model for processing." : `Could not list the models: ${c.detail}` });
          next = await saveSettings(info, { models: { model: best } });
        }
      }
      announceModelsChanged();
      settled.current = true;
      setSettings(next);
      setApiKey("");
      if (!next.models.local) setModel(next.models.model);
      if (!modelReady(next.models)) {
        return setPhase({ kind: "failed", message: next.models.local ? "Saved, but no model is chosen." : "Saved, but it still needs its key before it can process anything." });
      }
      await check(next);
    } catch (e) {
      setPhase({ kind: "failed", message: `Could not save: ${message(e)}` });
    }
  }

  async function signIn() {
    setSigningIn(true);
    setPhase(IDLE);
    try {
      const key = await signInWithOpenRouter(info);
      const next = await saveSettings(info, { models: { provider: "openrouter", apiKey: key, model: "" } });
      announceModelsChanged();
      settled.current = true;
      setSettings(next);
      setModel(""); // the best value for processing is chosen from the catalog the key unlocks
    } catch (e) {
      setPhase({ kind: "failed", message: `Could not sign in: ${message(e)}` });
    } finally {
      setSigningIn(false);
    }
  }

  const busy = phase.kind === "saving" || phase.kind === "checking";
  const options: Found[] = found?.servers.flatMap((server) => server.models.map((m) => ({ server, model: m }))) ?? [];
  const onChatGpt = settings?.models.provider === "chatgpt" && settings.models.hasKey;
  const canUse =
    choice === "local" ? pick !== null : choice === "chatgpt" ? onChatGpt === true : (keySaved || apiKey.trim() !== "") && (choice !== "apikey" || service !== "custom" || customEndpoint.trim() !== "");
  const useLabel = phase.kind === "saving" ? "Saving…" : phase.kind === "checking" ? "Checking…" : choice === "local" && pick ? `Use ${pick.model}` : choice === "chatgpt" ? "Use ChatGPT" : "Use this AI";
  const chosen = catalog.find((m) => m.id === model);
  const price = chosen ? formatPrice(chosen) : null;
  const payer = choice === "openrouter" ? "OpenRouter" : "the service";
  const privacy =
    choice === "chatgpt"
      ? "Your files stay on this computer; only the text being processed goes to ChatGPT, under your plan."
      : choice !== "local"
      ? "Your files stay on this computer; only the text being processed is sent to the service you choose."
      : pick && !onThisComputer(pick.endpoint)
        ? `Your text goes to the computer at ${hostOf(pick.endpoint)} on your network, and nowhere else.`
        : "Nothing leaves this computer.";

  const localBlock = (
    <div className="kv-onb-local">
      <p className="kv-hint">Slower than an online AI: each source takes a few minutes.</p>
      {scanning && <p role="status" className="kv-quiet">Looking for AI models on this computer…</p>}
      {!scanning && options.length > 0 && (
        <fieldset className="kv-onb-found">
          <legend>Found on this computer</legend>
          {options.map((o) => {
            const checked = pick?.endpoint === o.server.endpoint && pick.model === o.model.id;
            return (
              <label key={`${o.server.endpoint} ${o.model.id}`} className="kv-onb-found-item" data-checked={checked}>
                <input
                  type="radio"
                  name="onb-local-model"
                  checked={checked}
                  onChange={() => {
                    settled.current = true;
                    setPick({ endpoint: o.server.endpoint, model: o.model.id });
                    setPhase(IDLE);
                  }}
                  disabled={busy}
                />
                <span>
                  <strong>{o.model.id}</strong>
                  <span className="kv-hint">{plainFound(o.server, o.model)}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {!scanning && options.length === 0 && (
        <div className="kv-onb-none">
          <p><strong>No AI model is running on this computer.</strong></p>
          {found?.hint && <p className="kv-hint">{found.hint}</p>}
          <p className="kv-hint">
            <a href="https://ollama.com" target="_blank" rel="noreferrer">Ollama</a> and <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">LM Studio</a> are free ways to run one: install one, start a model, then scan again.
          </p>
        </div>
      )}
      {!scanning && (
        <div className="kv-onb-local-more">
          <button type="button" className="kv-button kv-button-quiet" onClick={() => void scan()} disabled={busy}>Scan again</button>
          <details className="kv-onb-details">
            <summary>A server at another address</summary>
            <AddressForm
              info={info}
              disabled={busy}
              onPick={(p) => {
                settled.current = true;
                setPick({ ...p, typed: true });
                setPhase(IDLE);
              }}
            />
          </details>
        </div>
      )}
    </div>
  );

  return (
    <section aria-labelledby="onb-title">
      <h2 id="onb-title" className="kv-onb-title" tabIndex={-1}>Choose the AI that writes your notes</h2>
      <p className="kv-onb-lead">It reads each source and writes the notes, and the vault's chat uses it too. You can change it any time in Settings.</p>
      {loadError && <p role="alert" className="kv-error">{loadError}</p>}
      {settings === null && !loadError && <p role="status" className="kv-quiet">Loading…</p>}
      {settings && (
        <form
          className="kv-onb-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (phase.kind === "ready") onContinue();
            else if (canUse && !busy) void use();
          }}
        >
          <ProviderChoice
            choice={choice}
            onChoice={(c) => switchTo(c, service)}
            service={service}
            onService={(s) => switchTo("apikey", s)}
            customEndpoint={customEndpoint}
            onCustomEndpoint={(v) => {
              setCustomEndpoint(v);
              setPhase(IDLE);
            }}
            apiKey={apiKey}
            onApiKey={(v) => {
              setApiKey(v);
              setPhase(IDLE);
            }}
            hasKey={keySaved}
            onOpenRouterSignIn={() => void signIn()}
            signingIn={signingIn}
            localBlock={localBlock}
            chatgptBlock={<ChatGptChoice info={info} current={settings.models} active={choice === "chatgpt"} onActivate={() => switchTo("chatgpt", service)} onChosen={() => void afterChatGpt()} />}
            disabled={busy}
            modelBlock={choice !== "local" && choice !== "chatgpt" ? (
              <>
                <label htmlFor="onb-model" className="kv-onb-label">Model</label>
                <ModelPicker
                  id="onb-model"
                  value={model}
                  onChange={(v) => {
                    settled.current = true;
                    setModel(v);
                    setPhase(IDLE);
                  }}
                  placeholder={canList ? "Chosen for you" : "Chosen for you once the key is entered"}
                  disabled={busy}
                  hasKey={canList}
                  load={loadCatalog}
                  reloadKey={catalogEndpoint}
                />
                <p className="kv-hint">
                  {price ? `Costs ${price}; you pay ${payer} for what is processed. ` : ""}
                  A model suited to processing, at a good price, is chosen for you; change it only if you prefer another.
                </p>
              </>
            ) : undefined}
          />
          <div className="kv-onb-verdict" aria-live="polite">
            {phase.kind === "checking" && (
              <p role="status" className="kv-quiet">
                Asking {phase.model} for a short answer…{phase.local ? " The first answer can take a minute while the model loads." : ""}
              </p>
            )}
            {phase.kind === "ready" && <p role="status" className="kv-onb-ok">{phase.message}</p>}
            {phase.kind === "failed" && <p role="alert" className="kv-error">{phase.message}</p>}
          </div>
          <p className="kv-hint">{privacy}</p>
          <div className="kv-onb-actions">
            <button type="button" className="kv-button" onClick={onBack} disabled={busy}>Back</button>
            <span className="kv-onb-actions-right">
              {phase.kind === "failed" && settings.models.model.trim() !== "" && (
                <button type="button" className="kv-button kv-button-quiet" onClick={onContinue}>Continue anyway</button>
              )}
              {phase.kind === "ready" ? (
                <button type="submit" className="kv-button kv-button-primary">Continue</button>
              ) : (
                <button type="submit" className="kv-button kv-button-primary" disabled={!canUse || busy}>{useLabel}</button>
              )}
            </span>
          </div>
        </form>
      )}
    </section>
  );
}

/** A model server the scan did not find (another port, or a computer on the local network): its address, then its models. */
function AddressForm({ info, disabled, onPick }: { info: SidecarInfo; disabled: boolean; onPick: (p: Pick) => void }) {
  const [url, setUrl] = useState(DEFAULT_LOCAL_ENDPOINT);
  const [result, setResult] = useState<LocalProbe | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [chosen, setChosen] = useState("");
  async function connect() {
    setConnecting(true);
    setResult(null);
    try {
      const r = await probeLocalModels(info, url.trim());
      setResult(r);
      if (r.ok && r.models[0]) {
        setChosen(r.models[0]);
        onPick({ endpoint: r.endpoint, model: r.models[0] });
      }
    } catch (e) {
      setResult({ ok: false, endpoint: url, detail: message(e) });
    } finally {
      setConnecting(false);
    }
  }
  return (
    <div className="kv-onb-address">
      <label htmlFor="onb-local-url" className="kv-onb-label">Address</label>
      <div className="kv-form-inline">
        <input
          id="onb-local-url"
          className="kv-onb-input"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setResult(null);
          }}
          // Enter here connects; it must not submit the whole step.
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (url.trim() && !connecting) void connect();
          }}
          disabled={disabled || connecting}
        />
        <button type="button" className="kv-button" onClick={() => void connect()} disabled={disabled || connecting || !url.trim()}>{connecting ? "Connecting…" : "Connect"}</button>
      </div>
      <p className="kv-hint">Its OpenAI-compatible API, usually ending in /v1. It can be on this computer, your local network or a VPN such as Tailscale.</p>
      {result && !result.ok && <p className="kv-error">Could not connect: {result.detail}</p>}
      {result?.ok && result.models.length === 1 && <p className="kv-onb-ok">Connected: {result.models[0]} is chosen.</p>}
      {result?.ok && result.models.length > 1 && (
        <>
          <label htmlFor="onb-local-choice" className="kv-onb-label">Model</label>
          <select
            id="onb-local-choice"
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value);
              onPick({ endpoint: result.endpoint, model: e.target.value });
            }}
            disabled={disabled}
          >
            {result.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </>
      )}
    </div>
  );
}
