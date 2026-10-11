/**
 * Leaving a vault on a server switches the window back to the local engine.
 * The vault app inside the screen closes after the screen's own cleanup and
 * puts back the client it found when it opened (the server's), so the switch
 * back has to run after it, or every later read asks the server: a local vault
 * opened next is "not found" there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const slots = vi.hoisted(() => ({ client: vi.fn(), cache: vi.fn() }));
vi.mock("@powerhousedao/reactor-browser", () => ({
  DocumentCache: class {
    constructor(readonly client: unknown) {}
  },
  GraphQLReactorClient: class {
    constructor(readonly options: { url: string }) {}
  },
  ensurePHEventHandlers: vi.fn(),
  setDefaultDrivesUrl: vi.fn(),
  setDocumentCache: slots.cache,
  setReactorClient: slots.client,
  setPHToast: vi.fn(),
  setReactorClientModule: vi.fn(),
  setSelectedNode: vi.fn(),
  setSwitchboardUrl: vi.fn(),
  setVetraPackageManager: vi.fn(),
  StaticPackageManager: class {},
}));
vi.mock("./remote-client-module.js", () => ({ remoteClientModule: vi.fn(() => ({})) }));
vi.mock("./shell/history-guard.js", () => ({ setHistoryEditorRestorer: vi.fn() }));
vi.mock("./components/HostToasts.js", () => ({ hostToasts: { toast: vi.fn() } }));

const { activate, activateAfterCleanup } = await import("./reactor.js");

const LOCAL = "http://127.0.0.1:4201";
const SERVER = "https://switchboard.example.org";
/** The Switchboard the window's reads go to: the last client put in the slot. */
const current = () => (slots.client.mock.calls.at(-1)?.[0] as { options: { url: string } }).options.url;
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("activateAfterCleanup", () => {
  afterEach(() => vi.clearAllMocks());

  it("ends on the local engine after the closing vault app put the server's client back", async () => {
    const server = activate({ origin: SERVER });
    activateAfterCleanup({ origin: LOCAL }); // the remote screen's cleanup
    slots.client(server); // the vault app's restore, in the same round of cleanups
    expect(current()).toBe(`${SERVER}/graphql`);
    await settle();
    expect(current()).toBe(`${LOCAL}/graphql`);
    expect((slots.cache.mock.calls.at(-1)?.[0] as { client: { options: { url: string } } }).client.options.url).toBe(`${LOCAL}/graphql`);
  });

  it("does nothing when another target was activated before it ran (React's development remount)", async () => {
    activate({ origin: SERVER });
    activateAfterCleanup({ origin: LOCAL });
    activate({ origin: SERVER }); // the remount
    await settle();
    expect(current()).toBe(`${SERVER}/graphql`);
  });
});
