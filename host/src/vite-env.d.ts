/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SIDECAR_PORT?: string;
  readonly VITE_CONTROL_PORT?: string;
  readonly VITE_CONTROL_TOKEN?: string;
  /** The release feed the update check asks; empty turns the check off (the e2e). */
  readonly VITE_KV_UPDATE_FEED?: string;
}
declare module "*.css";
