import type { SidecarInfo } from "../sidecar.js";
import { control } from "../vaults.js";

/**
 * Sign in with ChatGPT — the engine's /chatgpt/* routes (sidecar/src/chatgpt/session.ts). The engine holds the
 * tokens; the page gets the status below and the sign-in link to open in the system browser, never a token.
 */
export type ChatGptStatus = {
  signedIn: boolean;
  /** The user allowed Knowledge Vault to use their ChatGPT plan (`chatgpt.tokens.use.direct`). */
  planUsage: boolean;
  account?: { email?: string; name?: string; plan?: string };
  scopes: string[];
  expiresAt?: string;
  /** Signed out, with an account registered on this computer: "Continue with ChatGPT" signs in to it again. */
  savedAccount?: { email?: string };
  /** A sign-in in progress: the link to show if the browser did not open. */
  pending: { url: string; startedAt: string } | null;
  /** The sign-in that just finished registered the app for this account (show "You're using your ChatGPT plan" once). */
  firstSignIn?: boolean;
  /** ChatGPT answered "usage limit reached" since the last request that succeeded. */
  usageLimit?: { at: string };
  lastError?: string;
};
export type ChatGptModel = { id: string; name: string };

/** ChatGPT › Settings › Usage: the user's plan usage, and this app's limit and access. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export const fetchChatGptStatus = (info: SidecarInfo, f: typeof fetch = fetch) => control<ChatGptStatus>(info, "/chatgpt/status", { method: "GET" }, f);

/**
 * The sign-in link for the window to open. `newAccount` registers the app for another ChatGPT account (only when
 * signed out); `allowPlanUsage` asks again for permission to use the plan, after the user declined it.
 */
export const startChatGptSignIn = (info: SidecarInfo, options: { newAccount?: boolean; allowPlanUsage?: boolean } = {}, f: typeof fetch = fetch) =>
  control<{ url: string }>(info, "/chatgpt/login", { method: "POST", body: JSON.stringify(options) }, f);

export const cancelChatGptSignIn = (info: SidecarInfo, f: typeof fetch = fetch) => control<{ cancelled: true }>(info, "/chatgpt/cancel", { method: "POST" }, f);

/** `revoked: false` — signed out here, but ChatGPT did not confirm: the user can disconnect the app in ChatGPT settings. */
export const signOutOfChatGpt = (info: SidecarInfo, f: typeof fetch = fetch) => control<{ signedOut: true; revoked: boolean }>(info, "/chatgpt/logout", { method: "POST" }, f);

/** The signed-in account's models, in ChatGPT's order. */
export const fetchChatGptModels = async (info: SidecarInfo, f: typeof fetch = fetch): Promise<ChatGptModel[]> =>
  (await control<{ models: ChatGptModel[] }>(info, "/chatgpt/models", { method: "GET" }, f)).models.map(({ id, name }) => ({ id, name }));

/** Make the ChatGPT plan the app's AI model (Settings › Models), with one of the account's models. */
export const chooseChatGptPlan = (info: SidecarInfo, model: string, f: typeof fetch = fetch) =>
  control<unknown>(info, "/settings", { method: "PUT", body: JSON.stringify({ models: { provider: "chatgpt", model } }) }, f);
