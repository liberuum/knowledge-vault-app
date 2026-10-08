/**
 * Sign in with ChatGPT for open-source and locally hosted apps: the fixed values from OpenAI's docs
 * (https://developers.openai.com/siwc/token-sharing-open-source, read 2026-10-09). The endpoints
 * are the ones https://auth.openai.com/.well-known/openid-configuration published that day.
 */
export type ChatGptEndpoints = {
  /** The ID token's `iss`, exactly. */
  issuer: string;
  authorize: string;
  token: string;
  revoke: string;
  jwks: string;
  /** Where inference and the model list go (`POST /responses`, `GET /models`). */
  api: string;
};

export const OPENAI_ENDPOINTS: ChatGptEndpoints = {
  issuer: "https://auth.openai.com",
  authorize: "https://auth.openai.com/api/accounts/authorize",
  token: "https://auth.openai.com/api/accounts/oauth/token",
  revoke: "https://auth.openai.com/api/accounts/oauth/revoke",
  jwks: "https://auth.openai.com/.well-known/jwks.json",
  api: "https://api.openai.com/v1",
};

/** The `resource` of every authorize, code-exchange and refresh request. */
export const RESOURCE = "https://api.openai.com/v1";
/** The scope that lets the app spend the user's ChatGPT plan; a sign-in without it is kept, but cannot run requests. */
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** Identity scopes, then the plan-usage scopes. */
export const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE] as const;
/** The first-sign-in entry point that registers the app for this account; never saved, never used to exchange a code. */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/** `agent_name_hint`: the app's actual name, the same on every installation. */
export const AGENT_NAME = "Knowledge Vault";
/**
 * Where the browser comes back, on the control server at 127.0.0.1 (never localhost). OpenAI matches the scheme,
 * host and path of the address registered at the first sign-in exactly — only the port may change — so this path
 * must never change. It is OpenAI's own example path.
 */
export const CALLBACK_PATH = "/auth/callback";
/** ChatGPT › Settings › Usage: plan usage, this app's limit, and its access to the plan. */
export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";
