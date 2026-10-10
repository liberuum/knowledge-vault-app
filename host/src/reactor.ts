import {
  DocumentCache,
  ensurePHEventHandlers,
  GraphQLReactorClient,
  setDefaultDrivesUrl,
  setDocumentCache,
  setReactorClient,
  setPHToast,
  setReactorClientModule,
  setSelectedNode,
  setSwitchboardUrl,
  setVetraPackageManager,
  StaticPackageManager,
} from "@powerhousedao/reactor-browser";
import type { DocumentModelLib } from "document-model";
import { setHistoryEditorRestorer } from "./shell/history-guard.js";
import { hostToasts } from "./components/HostToasts.js";
import { remoteClientModule } from "./remote-client-module.js";
import type { SidecarInfo } from "./sidecar.js";

export type Target = {
  /** The Switchboard this client talks to, e.g. "http://127.0.0.1:4201" or "https://switchboard.example.com". */
  origin: string;
  /** Per-request bearer; none for an open local engine. */
  tokenProvider?: () => Promise<string | undefined>;
};

let libs: readonly DocumentModelLib[] = [];
const clients = new Map<string, GraphQLReactorClient>();

/**
 * What Connect's boot does for us, minus the in-browser reactor: one
 * Switchboard-backed client per origin (with every document model, so
 * multi-action batches can be signed), a document cache over the active one,
 * and a package manager holding the vault and workflow packages — editors
 * included, which is why GraphQLReactorProvider (models only) is not used here.
 */
export function clientFor(target: Target): GraphQLReactorClient {
  let client = clients.get(target.origin);
  if (!client) {
    client = new GraphQLReactorClient({
      url: `${target.origin}/graphql`,
      documentModels: libs.flatMap((lib) => [...lib.documentModels]),
      ...(target.tokenProvider ? { tokenProvider: target.tokenProvider } : {}),
    });
    clients.set(target.origin, client);
  }
  return client;
}

/** Make `target` the Switchboard the mounted apps talk to. Returns its client. */
export function activate(target: Target): GraphQLReactorClient {
  const client = clientFor(target);
  setReactorClient(client);
  const cache = new DocumentCache(client);
  setDocumentCache(cache);
  // reactor-browser's drive helpers (Workflow Studio's create and delete) call
  // Connect's in-browser reactor; this answers them over the engine's GraphQL API.
  // Its reactorModule stays empty, so sync and registry lookups still see none.
  setReactorClientModule(remoteClientModule(client, libs, (id) => cache.get(id, true)) as unknown as Parameters<typeof setReactorClientModule>[0]);
  setSwitchboardUrl(`${target.origin}/graphql`);
  // Workflow Studio derives its runtime endpoint from the drive's sync channel or, failing
  // that, from the default drives URL — never from the Switchboard URL. There is no sync
  // manager here, so the default drives URL names the active engine.
  setDefaultDrivesUrl(`${target.origin}/d/workflows`);
  return client;
}

/**
 * Once per page: the packages, then the local engine as the active target — with
 * the user's bearer when the engine is protected (bound at creation; after a
 * protection restart the page reloads, so a fresh client is built here again).
 */
export function installReactor(info: SidecarInfo, packages: readonly DocumentModelLib[], tokenProvider?: Target["tokenProvider"]): GraphQLReactorClient {
  ensurePHEventHandlers();
  // Back and forward reopen the editor each history entry had open (shell/history-guard.ts).
  setHistoryEditorRestorer((nodeId) => setSelectedNode(nodeId));
  libs = packages;
  setVetraPackageManager(new StaticPackageManager(packages));
  // Mounted apps report through usePHToast(); Connect provides that service, here the host does.
  setPHToast(hostToasts.toast);
  return activate({ origin: info.origin, ...(tokenProvider ? { tokenProvider } : {}) });
}
