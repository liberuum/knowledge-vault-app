import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ModelPicker } from "./ModelPicker.js";
import { useDebounced } from "./use-debounced.js";
import { LocalModel } from "./LocalModel.js";
import { ProviderChoice, signInFirst, type ApiService, type Choice } from "./ProviderChoice.js";
import { ChatGptChoice } from "./ChatGptChoice.js";
import { answerChatKeyOffer, chatKeyOffer } from "./chat-key-offer.js";
import { signInWithOpenRouter } from "../api/openrouter.js";
import { announceModelsChanged } from "../model-declaration.js";
import type { SettingsApi } from "../screens/Settings.js";
import type { SidecarInfo } from "../sidecar.js";
import { discoverLocalModels, type AppSettings, type ModelSettings, type SettingsPatch } from "../vaults.js";

type Selection = { choice: Choice; service: ApiService; customEndpoint: string };

/** The card a saved model setting belongs to: where the form starts, and what it shows again after each save. */
function selectionOf(models: ModelSettings): Selection {
  switch (models.provider) {
    case "local":
      return { choice: "local", service: "openai", customEndpoint: "" };
    case "chatgpt":
      return { choice: "chatgpt", service: "openai", customEndpoint: "" };
    case "openrouter":
      return { choice: "openrouter", service: "openai", customEndpoint: "" };
    case "openai":
    case "anthropic":
    case "gemini":
    case "xai":
      return { choice: "apikey", service: models.provider, customEndpoint: "" };
    default:
      return { choice: "apikey", service: "custom", customEndpoint: models.endpoint };
  }
}

/** What Save sends for a card. The key goes only when one was entered: the engine keeps the saved one otherwise. */
function savePatch(choice: Exclude<Choice, "local" | "chatgpt">, service: ApiService, customEndpoint: string, model: string, apiKey: string): NonNullable<SettingsPatch["models"]> {
  const key = apiKey ? { apiKey } : {};
  if (choice === "openrouter") return { provider: "openrouter", model, ...key };
  if (service === "custom") return { endpoint: customEndpoint, model, ...key };
  return { provider: service, model, ...key };
}

/**
 * The one AI model the chat and the pipeline use: on this computer, OpenRouter, or an API key for a named
 * service. The key is kept by the engine, never shown again — and belongs to the provider it was saved for.
 */
export function ModelsSection({ info, api }: { info: SidecarInfo; api: SettingsApi }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [choice, setChoice] = useState<Choice>("openrouter");
  const [service, setService] = useState<ApiService>("openai");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; detail: string; warning?: string } | null>(null);
  /** An OpenRouter key the vault chat saved before it ran on the app's model, offered once (chat-key-offer.ts). */
  const [offeredKey, setOfferedKey] = useState<string | null>(null);

  /** Take what the engine answered as the settings, and show the card it belongs to (it may read an address differently than it was typed). */
  const adopt = useCallback((next: AppSettings) => {
    const card = selectionOf(next.models);
    setSettings(next);
    setChoice(card.choice);
    setService(card.service);
    setCustomEndpoint(card.customEndpoint);
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .fetchSettings(info)
      .then((s) => {
        if (!alive) return;
        adopt(s);
        setModel(s.models.model);
        if (typeof localStorage !== "undefined") setOfferedKey(chatKeyOffer(localStorage, s.models));
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [api, info, adopt]);

  // What is saved belongs to one card, and to one service on the API key card: its key, its models and its checks show there only.
  const savedCard = settings ? selectionOf(settings.models) : null;
  const onSaved = savedCard !== null && savedCard.choice === choice && (choice !== "apikey" || savedCard.service === service);
  const keySaved = onSaved && settings?.models.hasKey === true;
  // The saved key lists the saved address's models; Another service follows the address in the form.
  const catalogEndpoint = choice === "apikey" && service === "custom" && customEndpoint.trim() ? customEndpoint.trim() : settings?.models.endpoint;
  // A key just entered lists its service's models before it is saved, so the model is picked from a list, not typed.
  const typedKey = useDebounced(apiKey.trim(), 500);
  const listProvider = choice === "openrouter" ? "openrouter" : service;
  const listsTypedKey = typedKey !== "" && (choice === "openrouter" || (choice === "apikey" && (service !== "custom" || customEndpoint.trim() !== "")));
  const canList = keySaved || listsTypedKey;
  const loadCatalog = useCallback(
    () => (listsTypedKey ? api.fetchModelCatalogFor(info, { provider: listProvider, endpoint: customEndpoint.trim(), apiKey: typedKey }) : api.fetchModelCatalog(info, catalogEndpoint)),
    [api, info, catalogEndpoint, listsTypedKey, listProvider, customEndpoint, typedKey],
  );

  /** The model and the key belong to one service: another card or service starts empty, the saved one shows what was saved. */
  function switchTo(c: Choice, s: ApiService) {
    setChoice(c);
    setService(s);
    clearNotes();
    setApiKey("");
    const same = savedCard !== null && savedCard.choice === c && (c !== "apikey" || savedCard.service === s);
    setModel(same && settings ? settings.models.model : "");
  }

  /** Notes about the last action (Saved, a verdict, an error) belong to the card they were made on. */
  function clearNotes() {
    setSaved(false);
    setVerdict(null);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (choice === "local" || choice === "chatgpt") return; // saved in their cards: Use, or signing in with ChatGPT
    if (choice === "apikey" && service === "custom" && !customEndpoint.trim()) {
      setSaved(false);
      setError("Enter the address of the service."); // an empty address would send the engine back to its default, OpenRouter
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.saveSettings(info, { models: savePatch(choice, service, customEndpoint, model, apiKey) });
      announceModelsChanged(); // the vault chat runs on this model: the app re-declares it
      // The engine normalises what was pasted (a chat-completions URL becomes the API root): the form shows its value.
      adopt(next);
      setModel(next.models.model);
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  async function useLocal(localEndpoint: string, localModel: string) {
    setError(null);
    setSaved(false);
    try {
      const next = await api.saveSettings(info, { models: { endpoint: localEndpoint, model: localModel } });
      announceModelsChanged();
      adopt(next);
      setModel(next.models.model);
      setSaved(true);
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
  /** OpenRouter's own sign-in, in the browser: no key to paste. The key it issues is saved straight away. */
  async function signIn() {
    setSigningIn(true);
    setError(null);
    setSaved(false);
    try {
      const key = await signInWithOpenRouter(info);
      const next = await api.saveSettings(info, { models: { provider: "openrouter", apiKey: key } });
      announceModelsChanged();
      adopt(next);
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setError(`Could not sign in: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSigningIn(false);
    }
  }
  /** The chat's OpenRouter key becomes the app's: the OpenRouter card shows, with the model still to choose. */
  async function useOfferedKey(key: string) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.saveSettings(info, { models: { provider: "openrouter", apiKey: key } });
      announceModelsChanged();
      if (typeof localStorage !== "undefined") answerChatKeyOffer(localStorage, "used");
      setOfferedKey(null);
      adopt(next);
      setModel(next.models.model);
      setSaved(true);
    } catch (err) {
      setError(`Could not use the key: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  function declineOfferedKey() {
    if (typeof localStorage !== "undefined") answerChatKeyOffer(localStorage, "declined");
    setOfferedKey(null);
  }
  async function validate() {
    setBusy(true);
    setVerdict(null);
    try {
      setVerdict(await api.validateModels(info));
    } catch (err) {
      setVerdict({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }
  async function removeKey() {
    setBusy(true);
    setError(null);
    try {
      // The model goes with its key: without one, it cannot be used.
      setSettings(await api.saveSettings(info, { models: { apiKey: "", model: "" } }));
      setModel("");
      announceModelsChanged(); // a hosted model without its key is no longer one the chat can use
    } catch (err) {
      setError(`Could not remove the key: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const canSave = choice !== "local" && choice !== "chatgpt";
  const canValidate = onSaved && settings !== null && (settings.models.hasKey || settings.models.local === true);

  return (
    <div className="kv-settings-body">
      <p className="kv-settings-lead">The chat and the processing pipeline use one AI model. A vault created after this is set up processes its sources on its own.</p>
      {settings === null && !error && <p className="kv-quiet" role="status">Loading…</p>}
      {settings && offeredKey && (
        <div className="kv-offer" role="region" aria-label="Your chat's OpenRouter key">
          <p>
            <strong>The vault chat has an OpenRouter key saved in this app.</strong> Use it for the whole app, so the chat and
            processing both run on OpenRouter? You choose the model next.
          </p>
          <div className="kv-form-actions">
            <button type="button" className="kv-button kv-button-primary" disabled={busy} onClick={() => void useOfferedKey(offeredKey)}>Use it</button>
            <button type="button" className="kv-button" disabled={busy} onClick={declineOfferedKey}>No thanks</button>
          </div>
        </div>
      )}
      {settings && (
        <form className="kv-form" onSubmit={(e) => void submit(e)}>
          <ProviderChoice
            choice={choice}
            onChoice={(c) => switchTo(c, service)}
            service={service}
            onService={(s) => switchTo("apikey", s)}
            customEndpoint={customEndpoint}
            onCustomEndpoint={setCustomEndpoint}
            apiKey={apiKey}
            onApiKey={(v) => {
              setApiKey(v);
              // A model picked from a key just entered goes with that key.
              if (!v.trim() && !keySaved) setModel("");
            }}
            hasKey={keySaved}
            onOpenRouterSignIn={() => void signIn()}
            signingIn={signingIn}
            disabled={busy}
            onRemoveKey={() => void removeKey()}
            chatgptBlock={<ChatGptChoice info={info} current={settings.models} allowChange active={choice === "chatgpt"} onActivate={() => { setChoice("chatgpt"); clearNotes(); }} onChosen={() => void api.fetchSettings(info).then((s) => { adopt(s); setModel(s.models.model); setSaved(true); })} />}
            localBlock={
              <>
                <LocalModel
                  current={{ local: settings.models.local === true, endpoint: settings.models.endpoint, model: settings.models.model }}
                  probe={(e) => api.probeLocalModels(info, e)}
                  discover={() => discoverLocalModels(info)}
                  use={useLocal}
                  disabled={busy}
                />
                {onSaved && settings.models.local === true && <p className="kv-hint">Not needed for a model on this computer.</p>}
              </>
            }
            modelBlock={
              canSave ? (
                <>
                  <label htmlFor="models-model">Model (required for processing)</label>
                  <ModelPicker id="models-model" value={model} onChange={setModel} placeholder={canList ? "Choose a model" : "The model’s name"} disabled={busy} hasKey={canList} load={loadCatalog} reloadKey={catalogEndpoint} pending={apiKey.trim() !== "" && apiKey.trim() !== typedKey} />
                </>
              ) : undefined
            }
          />
          {(canSave || canValidate || saved) && (
            <div className="kv-form-actions">
              {canSave && (
                <button type="submit" className={choice === "openrouter" && signInFirst(keySaved, apiKey) ? "kv-button" : "kv-button kv-button-primary"} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
              )}
              {canValidate && (
                <button type="button" className="kv-button" disabled={busy} onClick={() => void validate()}>Validate</button>
              )}
              {saved && <span className="kv-form-saved" role="status">Saved</span>}
            </div>
          )}
          {verdict && <p role="status" className={verdict.ok ? "kv-form-saved" : "kv-error"}>{verdict.detail}</p>}
          {verdict?.warning && <p className="kv-hint">{verdict.warning}</p>}
          {error && <p role="alert" className="kv-error">{error}</p>}
        </form>
      )}
    </div>
  );
}
