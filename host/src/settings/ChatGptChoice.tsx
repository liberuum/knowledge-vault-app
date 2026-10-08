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
  const choosing = useRef(false);
  const chosen = useRef(onChosen);
  chosen.current = onChosen;

  const ready = status?.signedIn === true && status.planUsage === true;
  const activate = useRef(onActivate);
  activate.current = onActivate;
  const usingIt = current?.provider === "chatgpt" && current.model.trim() !== "";

  async function choose(model: string) {
    choosing.current = true;
    setError(null);
    try {
      await chooseChatGptPlan(info, model);
      announceModelsChanged(); // the vault chat runs on it from the next message
      chosen.current(model);
    } catch (e) {
      setError(`Could not switch to ChatGPT: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      choosing.current = false;
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
  return (
    <div className="kv-chatgpt-choice">
      <ChatGptConnect
        info={info}
        compact={!active}
        onStatus={(s) => {
          setStatus(s);
          if (s.pending && !active) activate.current?.(); // the compact button started a sign-in: this card is chosen
        }}
      />
      {active && ready && usingIt && current && (
        <p role="status" className="kv-form-saved">
          Using {name(current.model)} from your ChatGPT plan.{allowChange ? "" : " You can choose another in Settings › Models."}
        </p>
      )}
      {active && ready && allowChange && models && models.length > 1 && current && (
        <>
          <label htmlFor="chatgpt-model">Model</label>
          <select id="chatgpt-model" value={usingIt ? current.model : ""} onChange={(e) => void choose(e.target.value)}>
            {!usingIt && <option value="">Choose a model</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </>
      )}
      {error && <p role="alert" className="kv-error">{error}</p>}
    </div>
  );
}
