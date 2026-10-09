import { useEffect, useRef, useState } from "react";
import { chooseChatGptPlan, fetchChatGptModels, type ChatGptModel, type ChatGptStatus } from "../api/chatgpt.js";
import { announceModelsChanged } from "../model-declaration.js";
import type { SidecarInfo } from "../sidecar.js";
import type { ModelSettings } from "../vaults.js";
import { ChatGptConnect } from "./ChatGptConnect.js";
import { defaultChatGptModel } from "./chatgpt-default.js";

/**
 * The ChatGPT card's body (Settings › Models and the setup guide): Continue with ChatGPT, and once signed in with plan
 * use allowed the app runs on it at once — the default model is chosen, nothing to pick. Settings can change it.
 */
export function ChatGptChoice({
  info,
  current,
  onChosen,
  allowChange = false,
  active = true,
  onActivate,
}: {
  info: SidecarInfo;
  current: ModelSettings | null;
  onChosen: (model: string) => void;
  allowChange?: boolean;
  /** The ChatGPT card is the chosen one: only then does signing in switch the app to ChatGPT. */
  active?: boolean;
  /** A sign-in started from the card's compact button: choose the card. */
  onActivate?: () => void;
}) {
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [models, setModels] = useState<ChatGptModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A model being switched to, and the last one the person switched to here (for the confirmation). */
  const [switching, setSwitching] = useState<string | null>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  const choosing = useRef(false);
  const chosen = useRef(onChosen);
  chosen.current = onChosen;

  const ready = status?.signedIn === true && status.planUsage === true;
  const activate = useRef(onActivate);
  activate.current = onActivate;
  const usingIt = current?.provider === "chatgpt" && current.model.trim() !== "";

  async function choose(model: string, byHand = false) {
    choosing.current = true;
    setError(null);
    if (byHand) setSwitching(model);
    try {
      await chooseChatGptPlan(info, model);
      announceModelsChanged(); // the vault chat runs on it from the next message
      chosen.current(model);
      if (byHand) setSwitched(model);
    } catch (e) {
      setError(`Could not switch to ChatGPT: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      choosing.current = false;
      if (byHand) setSwitching(null);
    }
  }

  // Signed in: list the plan's models, and use the default straight away if the app is not on ChatGPT yet.
  useEffect(() => {
    if (!ready || !active) return;
    let alive = true;
    fetchChatGptModels(info)
      .then((list) => {
        if (!alive) return;
        setModels(list);
        if (usingIt || choosing.current) return;
        const pick = defaultChatGptModel(list);
        if (pick) void choose(pick);
        else setError("Your ChatGPT plan lists no models this app can use.");
      })
      .catch((e: unknown) => alive && setError(`Could not list your plan's models: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      alive = false;
    };
    // `choose` reads the latest props through refs; re-run only when sign-in or the setting changes.
  }, [ready, active, usingIt, info]);

  const name = (id: string) => models?.find((m) => m.id === id)?.name ?? id;
  const canChange = active && ready && allowChange && (models?.length ?? 0) > 1;
  return (
    <div className="kv-chatgpt-choice">
      <ChatGptConnect
        info={info}
        compact={!active}
        onUse={() => activate.current?.()}
        onStatus={(s) => {
          setStatus(s);
          if (s.pending && !active) activate.current?.(); // the compact button started a sign-in: this card is chosen
        }}
      />
      {active && ready && usingIt && current && !canChange && (
        <p role="status" className="kv-form-saved">
          Using {name(current.model)} from your ChatGPT plan.{allowChange ? "" : " You can choose another in Settings › Models."}
        </p>
      )}
      {canChange && current && models && (
        // A plan offers a handful of models: all of them in view, one click to switch (no menu to open).
        <div className="kv-model-choice">
          <p id="chatgpt-model-label" className="kv-model-choice-label">Model</p>
          <div role="group" aria-labelledby="chatgpt-model-label" className="kv-model-pills">
            {models.map((m) => {
              const inUse = usingIt && current.model === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className="kv-model-pill"
                  aria-pressed={inUse}
                  disabled={switching !== null}
                  onClick={() => {
                    if (!inUse) void choose(m.id, true);
                  }}
                >
                  {inUse && (
                    <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12">
                      <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  {m.name}
                </button>
              );
            })}
          </div>
          <p role="status" className="kv-hint kv-model-choice-note">
            {switching
              ? `Switching to ${name(switching)}…`
              : switched && usingIt && current.model === switched
                ? `Switched to ${name(switched)}: the chat and processing use it from now on.`
                : "The chat and processing use the highlighted model."}
          </p>
        </div>
      )}
      {error && <p role="alert" className="kv-error">{error}</p>}
    </div>
  );
}
