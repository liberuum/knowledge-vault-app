import { useEffect, useMemo, useState } from "react";
import { createTokenProvider } from "../api/identity.js";
import type { RemoteVault } from "../api/remote.js";
import { declareDesktopHost, type HostIdentity } from "../bootstrap.js";
import { activate } from "../reactor.js";
import type { SidecarInfo } from "../sidecar.js";
import { AppBar } from "../shell/AppBar.js";
import { VaultLoader } from "../components/VaultLoader.js";
import { WorkspaceScreen, type WorkspaceAuth } from "./WorkspaceScreen.js";
import { useRemoteHealth } from "../state/use-remote-health.js";

/**
 * A vault on another Switchboard, in client mode (spec §5.5): the mounted app
 * talks to that server with the user's bearer (minted by the engine), and the
 * vault package follows the re-declared host origin. Leaving restores the
 * local engine as the active target.
 */
export function RemoteWorkspaceScreen({
  info,
  vault,
  identity,
  auth,
  onBack,
  onSettings,
  probeFetch,
  probeMs,
}: {
  info: SidecarInfo;
  vault: RemoteVault;
  identity: HostIdentity | undefined;
  /** The sign-in, for the error card's actions (sign in, sign in again). */
  auth?: WorkspaceAuth;
  onBack: () => void;
  onSettings?: () => void;
  /** For tests: the reachability probe's fetch and interval. */
  probeFetch?: typeof fetch;
  probeMs?: number;
}) {
  // Spec §9: client mode keeps nothing locally, so an unreachable server is said, not hidden.
  const reach = useRemoteHealth(vault.switchboardUrl, probeMs, probeFetch);
  const host = (() => {
    try {
      return new URL(vault.switchboardUrl).host;
    } catch {
      return vault.switchboardUrl;
    }
  })();
  const offline = reach === "offline" && (
    <div className="kv-engine-banner" role="status">
      <span className="kv-dot" aria-hidden="true" />
      You're offline — this vault lives on {host} and needs a connection.
    </div>
  );
  const tokenProvider = useMemo(() => createTokenProvider(info), [info]);
  // A changed sign-in invalidates the cached token: it was minted under the previous one.
  const authKey = auth?.key;
  useEffect(() => {
    tokenProvider.invalidate();
  }, [tokenProvider, authKey]);
  const [client, setClient] = useState<ReturnType<typeof activate> | null>(null);
  // Activation is keyed on the target only; the declaration follows the identity as well, so a
  // sign-in landing after mount re-declares without ever flipping the client to the local engine.
  useEffect(() => {
    setClient(activate({ origin: vault.switchboardUrl, tokenProvider }));
    return () => {
      activate({ origin: info.origin });
    };
  }, [info.origin, vault.switchboardUrl, tokenProvider]);
  useEffect(() => {
    declareDesktopHost(vault.switchboardUrl, { bearer: tokenProvider, identity });
    return () => {
      declareDesktopHost(info.origin, { identity });
    };
  }, [info.origin, vault.switchboardUrl, tokenProvider, identity]);
  if (!client) {
    return (
      <div className="kv-vault-screen">
        <AppBar title={vault.name} onBack={onBack} onSettings={onSettings} />
        {offline}
        <VaultLoader label={`Opening ${vault.name}…`} detail={`from ${host}`} slow={`Still waiting for ${host} to answer.`} />
      </div>
    );
  }
  return (
    <>
      {offline}
      <WorkspaceScreen
        client={client}
        driveId={vault.id}
        appId="knowledge-vault"
        fallbackTitle={vault.name}
        onBack={onBack}
        onSettings={onSettings}
        remoteHost={host}
        beforeRetry={() => tokenProvider.invalidate()}
        {...(auth ? { auth } : {})}
      />
    </>
  );
}
