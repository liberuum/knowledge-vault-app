// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultGraphSample } from "../api/graph.js";
import { Landing, type LandingApi } from "../screens/Landing.js";

const info = { origin: "http://127.0.0.1:4301", graphqlUrl: "http://127.0.0.1:4301/graphql", controlOrigin: "http://127.0.0.1:4302", controlToken: "t" };
const sample: VaultGraphSample = {
  noteCount: 371, linkCount: 1208, mocCount: 9,
  nodes: [{ id: "a", kind: "moc", status: "MOC" }, { id: "b", kind: "note", status: "CANONICAL" }, { id: "c", kind: "note", status: "DRAFT" }],
  edges: [["a", "b"], ["b", "c"]],
};
function api(over: Partial<LandingApi> = {}): LandingApi {
  return {
    fetchVaults: vi.fn(async () => []),
    createVault: vi.fn(async (_i, name: string) => ({ id: "v-new", slug: "s", name, noteCount: 0 })),
    renameVault: vi.fn(async (_i, id: string, name: string) => ({ id, slug: "s", name })),
    deleteVault: vi.fn(async () => {}),
    fetchRemoteVaults: vi.fn(async () => []),
    checkRemote: vi.fn(async (_i, url: string, drive: string | undefined) => ({ id: "c589", slug: drive ?? "pk", name: "powerhouse-knowledge", switchboardUrl: new URL(url).origin, access: "write" as const })),
    addRemote: vi.fn(async (_i, url: string, drive: string | undefined) => ({ kind: "remote" as const, id: "c589", slug: drive ?? "pk", name: "powerhouse-knowledge", switchboardUrl: new URL(url).origin, addedAt: "2026-10-06T12:00:00Z" })),
    removeRemote: vi.fn(async () => {}),
    fetchGraph: vi.fn(async () => sample),
    fetchFullGraph: vi.fn(async () => ({ nodes: sample.nodes, edges: sample.edges, noteCount: 371, linkCount: 1208 })),
    fetchVersion: vi.fn(async () => "0.1.0"),
    loadLayout: vi.fn(async () => null),
    ...over,
  };
}
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
}
// Testing Library cleans up automatically only under vitest globals; do it explicitly, or renders pile up across tests.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Landing", () => {
  it("first run, signed out: 'Sign in' in the hint does what the header's Sign in does", async () => {
    const onIdentity = vi.fn();
    render(<Landing engine={{ state: "ready" }} info={info} api={api()} onIdentity={onIdentity} storage={memoryStorage()} />);
    expect(await screen.findByText("Create your first vault")).toBeTruthy();
    expect(within(await screen.findByRole("region", { name: "Getting started" })).getByText("0 of 5 done")).toBeTruthy();
    const hint = screen.getByText(/Already have a vault on a server/);
    expect(hint.textContent).toBe("Already have a vault on a server? Sign in, then connect it from here.");
    fireEvent.click(within(hint).getByRole("button", { name: "Sign in" }));
    expect(onIdentity).toHaveBeenCalledTimes(1);
  });
  it("first run: the create form is the single target and Enter creates and opens the vault", async () => {
    const a = api();
    const onOpen = vi.fn();
    render(<Landing engine={{ state: "ready" }} info={info} api={a} onOpen={onOpen} storage={memoryStorage()} />);
    expect(await screen.findByText("Create your first vault")).toBeTruthy();
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "  Research   notes " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: "Research notes" })));
    expect(a.createVault).toHaveBeenCalledWith(info, "Research notes");
  });

  it("lists vaults as tiles, the most recently opened one leading, with a sentence of real numbers", async () => {
    const storage = memoryStorage();
    storage.setItem("kv.recents", JSON.stringify({ v2: "2026-10-06T10:00:00Z" }));
    const a = api({ fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 3 }, { id: "v2", slug: "b", name: "Team wiki", noteCount: 300 }]) });
    render(<Landing engine={{ state: "ready" }} info={info} api={a} storage={storage} />);
    const lead = await screen.findByRole("button", { name: "Open Team wiki" });
    expect(lead.closest(".kv-tile")!.getAttribute("data-lead")).toBe("true"); // the tile carries the lead flag; the button is its open area
    expect(screen.getByRole("button", { name: "Open Alpha" }).closest(".kv-tile")!.getAttribute("data-lead")).toBe("false");
    expect(await screen.findAllByText(/371 notes and 1,208 links, /)).toHaveLength(2);
    expect(screen.getByText(/1,208 links, opened /)).toBeTruthy(); // Team wiki was opened
    expect(screen.getByText(/1,208 links, not opened yet\./)).toBeTruthy(); // Alpha never was
    expect(a.fetchGraph).toHaveBeenCalledWith(info.origin, "v2", 48, undefined); // local vaults: no bearer
    expect(a.fetchGraph).toHaveBeenCalledWith(info.origin, "v1", 28, undefined);
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(await screen.findByText("0.1.0")).toBeTruthy();
  });

  it("'New vault' reveals the inline form; Escape puts it away", async () => {
    const a = api({ fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 0 }]) });
    render(<Landing engine={{ state: "ready" }} info={info} api={a} storage={memoryStorage()} />);
    fireEvent.click(await screen.findByRole("button", { name: "New vault" }));
    const input = screen.getByLabelText("Name");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect remote vault" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows the engine starting, and an exit with its code, in the same frame without touching the engine", () => {
    const a = api();
    const { rerender } = render(<Landing engine={{ state: "starting" }} api={a} storage={memoryStorage()} />);
    expect(screen.getByText("Starting the engine…")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Vaults" })).toBeTruthy();
    rerender(<Landing engine={{ state: "exited", code: 1 }} api={a} storage={memoryStorage()} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("The engine stopped")).toBeTruthy();
    expect(screen.getByText(/Exit code 1/)).toBeTruthy();
    rerender(<Landing engine={{ state: "failed", detail: "no ipc" }} api={a} storage={memoryStorage()} />);
    expect(screen.getByText("The app could not reach the engine")).toBeTruthy();
    expect(screen.getByText(/no ipc/)).toBeTruthy();
    expect(a.fetchVaults).not.toHaveBeenCalled();
  });

  it("names the supervisor's states in the strip: restarting with its attempt, a crash loop with the last lines, a refusal with its reason", () => {
    const a = api();
    const { rerender } = render(<Landing engine={{ state: "restarting", attempt: 2, delayMs: 4000 }} api={a} storage={memoryStorage()} />);
    expect(screen.getByText("Restarting the engine…")).toBeTruthy();
    expect(screen.getByText(/Attempt 2 of 3/)).toBeTruthy();
    rerender(<Landing engine={{ state: "gave_up", code: 1, logTail: ["boom: the store is locked"], fatal: null }} api={a} storage={memoryStorage()} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("The engine keeps stopping")).toBeTruthy();
    expect(screen.getByText("boom: the store is locked")).toBeTruthy();
    rerender(<Landing engine={{ state: "exited", code: 78, fatal: { reason: "store-too-new", message: "This store was last opened by a newer Knowledge Vault." } }} api={a} storage={memoryStorage()} />);
    expect(screen.getByText("The engine refused to start")).toBeTruthy();
    expect(screen.getByText(/last opened by a newer Knowledge Vault/)).toBeTruthy();
    rerender(<Landing engine={{ state: "stopping" }} api={a} storage={memoryStorage()} />);
    expect(screen.getByText("Stopping the engine…")).toBeTruthy();
    expect(a.fetchVaults).not.toHaveBeenCalled();
  });

  it("offers Try again when the engine keeps stopping, and shows its last lines without credentials", () => {
    const onRetry = vi.fn();
    render(<Landing engine={{ state: "gave_up", code: 1, logTail: ["Authorization: Bearer abc.def", "boom"], fatal: null }} api={api()} storage={memoryStorage()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.queryByText(/abc\.def/)).toBeNull();
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("renames a vault from its ⋯ menu and deletes one only after its name is typed", async () => {
    const a = api({ fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 3 }, { id: "v2", slug: "b", name: "Beta", noteCount: 0 }]) });
    render(<Landing engine={{ state: "ready" }} info={info} api={a} storage={memoryStorage()} />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const nameInput = screen.getByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "Alpha prime" } });
    fireEvent.submit(nameInput.closest("form")!);
    await waitFor(() => expect(a.renameVault).toHaveBeenCalledWith(info, "v1", "Alpha prime"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Alpha prime" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "More actions for Beta" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirm = screen.getByLabelText("Type the vault’s name to confirm");
    const del = screen.getByRole("button", { name: "Delete vault" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.change(confirm, { target: { value: "Beta" } });
    fireEvent.submit(confirm.closest("form")!);
    await waitFor(() => expect(a.deleteVault).toHaveBeenCalledWith(info, "v2"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open Beta" })).toBeNull());
  });

  it("connects a remote vault only when signed in: check, then add, then a tile named for its server", async () => {
    const a = api({ fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 3 }]) });
    const signedOut = { authenticated: false, appDid: "did:key:z", renownUrl: "https://www.renown.id", pending: null };
    const { rerender } = render(<Landing engine={{ state: "ready" }} info={info} identity={signedOut} api={a} storage={memoryStorage()} />);
    const connect = (await screen.findByRole("button", { name: "Connect remote vault" })) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    rerender(<Landing engine={{ state: "ready" }} info={info} identity={{ ...signedOut, authenticated: true, address: "0xabc" }} api={a} storage={memoryStorage()} />);
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    fireEvent.change(screen.getByLabelText("Vault server (Switchboard URL)"), { target: { value: "https://switchboard.knowledge-vault.vetra.io/graphql" } });
    fireEvent.change(screen.getByLabelText("Drive id or slug"), { target: { value: "powerhouse-knowledge" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/you can read and write/)).toBeTruthy();
    expect(a.checkRemote).toHaveBeenCalledWith(info, "https://switchboard.knowledge-vault.vetra.io/graphql", "powerhouse-knowledge");
    fireEvent.click(screen.getByRole("button", { name: "Add vault" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open powerhouse-knowledge" })).toBeTruthy());
    expect(screen.getByText("On switchboard.knowledge-vault.vetra.io")).toBeTruthy();
    expect(a.fetchGraph).toHaveBeenCalledWith("https://switchboard.knowledge-vault.vetra.io", "c589", expect.any(Number), undefined);
  });

  it("draws the whole graph when the vault's saved layout covers it, and the sample otherwise", async () => {
    const positions = new Map([["a", { x: 0, y: 0 }], ["b", { x: 10, y: 0 }], ["c", { x: 5, y: 8 }]]);
    const a = api({
      fetchVaults: vi.fn(async () => [{ id: "laid", slug: "l", name: "Laid out", noteCount: 3 }, { id: "fresh", slug: "f", name: "Fresh", noteCount: 3 }]),
      loadLayout: vi.fn(async (id: string) => (id === "laid" ? positions : null)),
    });
    const { container } = render(<Landing engine={{ state: "ready" }} info={info} api={a} storage={memoryStorage()} />);
    await waitFor(() => expect(container.querySelector(".kv-minimap")).toBeTruthy());
    expect(a.fetchFullGraph).toHaveBeenCalledTimes(1);
    expect(a.fetchFullGraph).toHaveBeenCalledWith(info.origin, "laid", undefined);
    const freshTile = screen.getByRole("button", { name: "Open Fresh" }).closest(".kv-tile")!;
    expect(freshTile.querySelector(".kv-constellation")).toBeTruthy();
    expect(freshTile.querySelector(".kv-minimap")).toBeNull();
  });
});

describe("Landing — a protected local engine", () => {
  it("gives the local tiles' graph requests the user's bearer, as it does for remote vaults", async () => {
    const a = api({ fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 3 }]) });
    // authorizedFetch binds the global fetch when it is created (at render), so the spy goes in first.
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    render(<Landing engine={{ state: "ready" }} info={info} api={a} storage={memoryStorage()} localBearer={async () => "jwt"} />);
    await waitFor(() => expect(a.fetchGraph).toHaveBeenCalled());
    const fetchImpl = (a.fetchGraph as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![3] as typeof fetch | undefined;
    expect(typeof fetchImpl).toBe("function");
    await fetchImpl!("http://127.0.0.1:4301/graphql/knowledgeGraph", { method: "POST" });
    expect(new Headers(spy.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer jwt");
  });
});
