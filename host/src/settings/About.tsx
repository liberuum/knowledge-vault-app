import { useEffect, useState } from "react";
import type { SettingsApi } from "../screens/Settings.js";
import type { SidecarInfo } from "../sidecar.js";
import type { EngineStatus } from "../vaults.js";
import { checkForUpdate, type UpdateInfo } from "../update-check.js";
import { UPDATE_FEED } from "../update-feed.js";

export function AboutSection({ info, api, feed = UPDATE_FEED }: { info: SidecarInfo; api: SettingsApi; feed?: string }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    let alive = true;
    api.fetchStatus(info).then((s) => alive && setStatus(s)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, info]);
  useEffect(() => {
    if (!feed || !status) return;
    let alive = true;
    void checkForUpdate(feed, status.appVersion, fetch, window.localStorage).then((u) => alive && setUpdate(u));
    return () => {
      alive = false;
    };
  }, [feed, status]);
  return (
    <div className="kv-settings-body">
      <p className="kv-settings-lead">Knowledge Vault runs the Powerhouse Knowledge Vault on your own computer: your notes, their graph and the pipeline, with nothing leaving the machine unless you connect something.</p>
      <dl className="kv-facts">
        <dt>App</dt><dd>{status?.appVersion ?? "…"}</dd>
        <dt>Powerhouse stack</dt><dd>{status?.stackVersion ?? "…"}</dd>
        <dt>Vault package</dt><dd>{status?.vaultPackageVersion ?? "…"}</dd>
      </dl>
      {!feed && <p className="kv-quiet">Update checks are off until the app has a release feed.</p>}
      {feed && update && (
        <p role="status" className="kv-settings-lead">
          Version {update.latest} is available. <a href={update.url} target="_blank" rel="noreferrer">Download it</a> — your vaults stay where they are, and a backup is made before the new version opens them.
        </p>
      )}
      {feed && status && !update && <p className="kv-quiet">This is the latest version.</p>}
      <p className="kv-hint">
        New to the app, or helping someone get started?{" "}
        <button type="button" className="kv-link" onClick={() => { window.location.hash = "#/welcome"; }}>Open the setup guide</button>
      </p>
    </div>
  );
}
