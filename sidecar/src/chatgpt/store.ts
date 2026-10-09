import { randomUUID } from "node:crypto";
import { renameWithRetry } from "../fs-retry.js";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLAN_SCOPE } from "./constants.js";

/** One ChatGPT account registration on this host: the issued client and the identity its ID token proved. Not secret. */
export type ChatGptRegistration = {
  clientId: string;
  /** The validated ID token's `sub`. */
  subject: string;
  email?: string;
  name?: string;
  /** Only when the ID token carries one (OpenAI's docs for this flow do not promise it). */
  plan?: string;
  registeredAt: string;
};

/** The renewable session of the active registration. Secret: never logged, never sent to the window. */
export type ChatGptTokens = {
  accessToken: string;
  /** Rotating: every refresh replaces it, and the old one stops working. */
  refreshToken: string;
  /** Kept as OpenAI asks, for an `id_token_hint`; not sent anywhere today. */
  idToken: string;
  tokenType: string;
  expiresAt: string;
  /** The granted scopes, from the token response. */
  scopes: string[];
  savedAt: string;
  earliestRefreshAt?: string;
};

export type ChatGptRecord = {
  version: 1;
  /** This install's `ext_agent_host_id`, chosen before its first sign-in and kept for good. Opaque; not a credential. */
  hostId: string;
  /** Every account registered from this host, kept after sign-out: signing in again reuses the account's client. */
  registrations: ChatGptRegistration[];
  /** The registration in use (or last used); `tokens` belong to it. */
  active?: string;
  tokens?: ChatGptTokens;
};

/** `secrets/chatgpt.json` in the data dir, mode 0600 — beside the model key and the other secrets. */
export const chatGptFile = (dataDir: string): string => join(dataDir, "secrets", "chatgpt.json");

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function readChatGpt(dataDir: string): ChatGptRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(chatGptFile(dataDir), "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!isString(r.hostId)) return undefined;
  const registrations = Array.isArray(r.registrations)
    ? (r.registrations as unknown[]).filter((g): g is ChatGptRegistration => !!g && typeof g === "object" && isString((g as ChatGptRegistration).clientId) && isString((g as ChatGptRegistration).subject))
    : [];
  const t = r.tokens && typeof r.tokens === "object" ? (r.tokens as Record<string, unknown>) : undefined;
  const tokens =
    t && isString(t.accessToken) && isString(t.refreshToken) && isString(t.expiresAt) && Array.isArray(t.scopes)
      ? ({ ...t, scopes: (t.scopes as unknown[]).filter(isString) } as ChatGptTokens)
      : undefined;
  return { version: 1, hostId: r.hostId, registrations, ...(isString(r.active) ? { active: r.active } : {}), ...(tokens ? { tokens } : {}) };
}

/** Atomically, owner-only: a crash never leaves half a file, and a rotated refresh token is never lost. */
export function writeChatGpt(dataDir: string, record: ChatGptRecord): void {
  const path = chatGptFile(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameWithRetry(tmp, path); // a failed rename would lose a renewed refresh token
}

/** The record, created with this host's ID the first time anything needs it. */
export function ensureChatGpt(dataDir: string): ChatGptRecord {
  const existing = readChatGpt(dataDir);
  if (existing) return existing;
  const record: ChatGptRecord = { version: 1, hostId: `urn:uuid:${randomUUID()}`, registrations: [] };
  writeChatGpt(dataDir, record);
  return record;
}

/** Signed in, and allowed to use the ChatGPT plan: what Settings reports as `hasKey` for the "chatgpt" provider. */
export function chatGptReady(dataDir: string): boolean {
  const tokens = readChatGpt(dataDir)?.tokens;
  return !!tokens && tokens.scopes.includes(PLAN_SCOPE);
}
