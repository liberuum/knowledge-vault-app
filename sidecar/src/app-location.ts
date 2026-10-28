import type { StackRelation } from "./store-guard.js";

/**
 * Where the shell found the app running (KV_APP_LOCATION, src-tauri/src/app_location.rs). Sent on
 * macOS only, and only when the app is not in Applications: on the disk image an update opens, in a
 * copy macOS made to run it where it was downloaded ("translocated"), or in Downloads.
 */
export type AppLocation = "disk-image" | "translocated" | "downloads";

const LOCATIONS: readonly AppLocation[] = ["disk-image", "translocated", "downloads"];

export function readAppLocation(env: Record<string, string | undefined>): AppLocation | undefined {
  const value = env.KV_APP_LOCATION;
  return LOCATIONS.find((l) => l === value);
}

/**
 * Upgrading the store from such a place is what strands people: the Dock keeps opening the old copy
 * in Applications, which then refuses the upgraded store (store-too-new). Only that start is refused —
 * a store this version already opened, or a new one, is not at risk.
 */
export function mustMoveFirst(location: AppLocation | undefined, relation: StackRelation): boolean {
  return location !== undefined && relation === "upgrade";
}

const FROM: Record<AppLocation, string> = {
  "disk-image": "from the disk image",
  translocated: "from where it was downloaded",
  downloads: "from the Downloads folder",
};

export const MOVE_FIRST_MESSAGE = (location: AppLocation): string =>
  `This version upgrades your vaults, and it is running ${FROM[location]} rather than from Applications. Your Dock would keep opening the older copy, which can't read upgraded vaults. Move it to Applications first; it opens again from there.`;
