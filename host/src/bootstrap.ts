/**
 * The slot `editors/shared/host-config.ts` in the vault package reads at call
 * time. The host writes it directly — it loads before the package — and
 * dispatches the package's change event so its hooks re-read it.
 */
import { takeIntakeFiles, takeOpenView } from "./onboarding/pending-files.js";

export const HOST_SLOT = "__knowledgeVaultHost";
export const HOST_CHANGED_EVENT = "knowledge-vault-host:changed";

export type HostIdentity = { address: string; did?: string; ensName?: string };
export type HostExtras = {
  /** The bearer for this origin, per request; absent for an open local engine. */
  bearer?: () => Promise<string | undefined>;
  /** Who the app is signed in as; absent when nobody is. */
  identity?: HostIdentity;
};

/** Runs a sign-in in the system browser and resolves with the code (the vault chat's OpenRouter connect). */
export type ExternalSignIn = (buildUrl: (callbackUrl: string) => string) => Promise<string>;
let externalSignIn: ExternalSignIn | undefined;
/** Set once at boot; every declaration carries it, whichever screen declares. */
export function setExternalSignIn(fn: ExternalSignIn | undefined): void {
  externalSignIn = fn;
}

/** Reads files a drop carried only by address (WebKitGTK): the engine reads them. Set once at boot. */
export type DroppedFileReader = (uriList: string) => Promise<File[]>;
let droppedFileReader: DroppedFileReader | undefined;
export function setDroppedFileReader(fn: DroppedFileReader | undefined): void {
  droppedFileReader = fn;
}

/**
 * The model the vault chat runs on: the app's, reached through the engine's gateway. `null` means the app manages
 * the model and none is set up (the chat shows its set-up panel); absent means the chat keeps its own connections.
 */
export type HostModel = { baseUrl: string; model: string; label: string; headers?: () => Record<string, string> };
let hostModel: HostModel | null | undefined;
let openModelSettings: (() => void) | undefined;
/** Set by App from the engine's settings; every declaration carries it, whichever screen declares. Takes effect with the next declaration. */
export function setHostModel(model: HostModel | null | undefined, openSettings?: () => void): void {
  hostModel = model;
  openModelSettings = openSettings;
}

export function declareDesktopHost(switchboardOrigin: string, extras: HostExtras = {}): void {
  (globalThis as Record<string, unknown>)[HOST_SLOT] = {
    kind: "desktop",
    switchboardOrigin,
    ...(extras.bearer ? { bearer: extras.bearer } : {}),
    ...(extras.identity ? { identity: { ...extras.identity } } : {}),
    ...(externalSignIn ? { externalSignIn } : {}),
    ...(hostModel !== undefined ? { model: hostModel } : {}),
    ...(openModelSettings ? { openModelSettings } : {}),
    // Files the setup guide collected: the vault takes them into its intake when it opens.
    takeIntakeFiles,
    // The view a vault opens on, when the guide's overview sent the person somewhere specific.
    takeOpenView,
    ...(droppedFileReader ? { readDroppedFiles: droppedFileReader } : {}),
  };
  if (typeof globalThis.dispatchEvent === "function" && typeof Event === "function") globalThis.dispatchEvent(new Event(HOST_CHANGED_EVENT));
}
