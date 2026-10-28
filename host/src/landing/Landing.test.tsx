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
    discoverRemote: vi.fn(async () => ({ switchboardUrl: "https://switchboard.knowledge-vault.vetra.io", vaults: [{ id: "c589", slug: "powerhouse-knowledge", name: "powerhouse-knowledge", documents: 2863, added: false }] })),
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
    expect(within(await screen.findByRole("region", { name: "Getting started" })).getByText("0 of 8 steps done")).toBeTruthy();
    const hint = screen.getByText(/Already have a vault on a server/);
    expect(hint.textContent).toBe("Already have a vault on a server? Connect a remote vault. If its server asks who you are, sign in first.");
    fireEvent.click(within(hint).getByRole("button", { name: "sign in" }));
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

  it("leads with the vault opened last — its numbers and one Open button — and lists the others as tiles with a sentence of real numbers", async () => {
    const storage = memoryStorage();
    storage.setItem("kv.recents", JSON.stringify({ v2: "2026-10-06T10:00:00Z" }));
    const a = api({ fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 3 }, { id: "v2", slug: "b", name: "Team wiki", noteCount: 300 }]) });
    render(<Landing engine={{ state: "ready" }} info={info} api={a} storage={storage} />);
    const open = await screen.findByRole("button", { name: "Open vault Team wiki" });
    const lead = open.closest(".kv-hero") as HTMLElement;
    expect(within(lead).getByRole("heading", { name: "Team wiki" })).toBeTruthy();
    expect(await within(lead).findByText("1,208")).toBeTruthy(); // links, from the graph sample
    expect(within(lead).getByText("371")).toBeTruthy();
    expect(within(lead).getByText(/^Opened /)).toBeTruthy();
    expect(within(lead).getAllByRole("button").filter((b) => b.className.includes("kv-button-primary"))).toHaveLength(1);
    const others = screen.getByRole("region", { name: "Other vaults" });
    expect(within(others).getByRole("button", { name: "Open Alpha" }).closest(".kv-tile")!.getAttribute("data-lead")).toBe("false");
    expect(await within(others).findByText(/371 notes and 1,208 links, not opened yet\./)).toBeTruthy(); // Alpha never was opened
    expect(a.fetchGraph).toHaveBeenCalledWith(info.origin, "v2", 48, undefined); // local vaults: no bearer
    expect(a.fetchGraph).toHaveBeenCalledWith(info.origin, "v1", 28, undefined);
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(await screen.findByText("0.1.0")).toBeTruthy();
  });

  it("'Add vault' opens one dialog on Create — a name, an idea, Enter — with Connect as the other choice", async () => {
    const onOpen = vi.fn();
    const a = api({ fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 0 }]) });
    render(<Landing engine={{ state: "ready" }} info={info} api={a} onOpen={onOpen} storage={memoryStorage()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add vault" }));
    const dialog = screen.getByRole("dialog", { name: "Add a vault" });
    const create = within(dialog).getByRole("tab", { name: /Create a new vault/ });
    expect(create.getAttribute("aria-selected")).toBe("true");
    // An idea fills the name; the field stays editable.
    fireEvent.click(within(within(dialog).getByRole("group", { name: "Name ideas" })).getByRole("button", { name: "Research" }));
    const name = within(dialog).getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Research");
    // The other choice: a server's address; and back.
    fireEvent.click(within(dialog).getByRole("tab", { name: /Connect one on a server/ }));
    expect(within(dialog).getByLabelText("Server address")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Name")).toBeNull();
    fireEvent.keyDown(within(dialog).getByRole("tab", { name: /Connect one on a server/ }), { key: "ArrowLeft" });
    const again = within(dialog).getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(again, { target: { value: "Reading notes" } });
    fireEvent.submit(again.closest("form")!);
    await waitFor(() => expect(a.createVault).toHaveBeenCalledWith(info, "Reading notes"));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: "Reading notes" })));
  });

  it("closes the Add a vault dialog with Cancel, and opens it on Connect from the first run's hint", async () => {
    const a = api({ fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 0 }]) });
    const { unmount } = render(<Landing engine={{ state: "ready" }} info={info} api={a} storage={memoryStorage()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add vault" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    render(<Landing engine={{ state: "ready" }} info={info} api={api()} storage={memoryStorage()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect a remote vault" }));
    const dialog = screen.getByRole("dialog", { name: "Add a vault" });
    expect(within(dialog).getByRole("tab", { name: /Connect one on a server/ }).getAttribute("aria-selected")).toBe("true");
    // Signed out: said before it is tried, and an open server still needs nothing.
    expect(within(dialog).getByText(/Some servers ask who you are/)).toBeTruthy();
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

  it("names a refusal as a refusal, not a crash loop (the supervisor reports it as gave_up)", () => {
    render(<Landing engine={{ state: "gave_up", code: 78, logTail: [], fatal: { reason: "store-too-new", message: "This store was last opened by a newer Knowledge Vault." } }} api={api()} storage={memoryStorage()} onRetry={vi.fn()} />);
    expect(screen.getByText("The engine refused to start")).toBeTruthy();
    expect(screen.queryByText("The engine keeps stopping")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("on macOS, offers to move the app into Applications before it upgrades the vaults", async () => {
    const refusal = { state: "gave_up" as const, code: 78, logTail: [], fatal: { reason: "not-in-applications", message: "This version upgrades your vaults, and it is running from the disk image rather than from Applications." } };
    let fail: (reason: unknown) => void = () => {};
    const onMoveToApplications = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const onOpenFromHere = vi.fn();
    render(<Landing engine={refusal} api={api()} storage={memoryStorage()} onRetry={vi.fn()} onMoveToApplications={onMoveToApplications} onOpenFromHere={onOpenFromHere} />);
    expect(screen.getByText("Move Knowledge Vault to Applications")).toBeTruthy();
    expect(screen.getByText(/running from the disk image/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull(); // it would only refuse again

    fireEvent.click(screen.getByRole("button", { name: "Move to Applications" }));
    expect(onMoveToApplications).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Moving…" }) as HTMLButtonElement).disabled).toBe(true);

    // a move that fails says why and can be tried again
    fail("Knowledge Vault could not replace /Applications/Knowledge Vault.app: Permission denied.");
    expect(await screen.findByText(/Permission denied/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Move to Applications" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Open from here anyway" }));
    expect(onOpenFromHere).toHaveBeenCalledOnce();
  });

  it("without the shell's move (a browser), that refusal keeps the plain Try again", () => {
    const refusal = { state: "gave_up" as const, code: 78, logTail: [], fatal: { reason: "not-in-applications", message: "Move it to Applications first." } };
    render(<Landing engine={refusal} api={api()} storage={memoryStorage()} onRetry={vi.fn()} />);
    expect(screen.getByText("The engine refused to start")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to Applications" })).toBeNull();
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Open vault Alpha prime" })).toBeTruthy()); // Alpha leads: no vault was opened, so by name

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

  // Under the full suite's load a render can take longer than the library's 1 s default: these waits allow 5 s.
  it("connects a remote vault, signed in or not: paste the server, pick from its vaults, then a tile named for its server", async () => {
    const a = api({ fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 3 }]) });
    const signedOut = { authenticated: false, appDid: "did:key:z", renownUrl: "https://www.renown.id", pending: null };
    render(<Landing engine={{ state: "ready" }} info={info} identity={signedOut} api={a} storage={memoryStorage()} />);
    // An open server needs no sign-in, so nothing waits for one.
    fireEvent.click(await screen.findByRole("button", { name: "Add vault" }, { timeout: 5000 }));
    fireEvent.click(screen.getByRole("tab", { name: /Connect one on a server/ }));
    fireEvent.change(screen.getByLabelText("Server address"), { target: { value: "switchboard.knowledge-vault.vetra.io" } });
    fireEvent.click(screen.getByRole("button", { name: "Find vaults" }));
    // The server's only vault is preselected.
    const option = (await screen.findByRole("checkbox", { name: /powerhouse-knowledge/ }, { timeout: 5000 })) as HTMLInputElement;
    expect(option.checked).toBe(true);
    expect(a.discoverRemote).toHaveBeenCalledWith(info, "switchboard.knowledge-vault.vetra.io");
    fireEvent.click(screen.getByRole("button", { name: "Connect vault" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open powerhouse-knowledge" })).toBeTruthy(), { timeout: 5000 });
    expect(a.addRemote).toHaveBeenCalledWith(info, "https://switchboard.knowledge-vault.vetra.io", "c589");
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
    // "Fresh" leads (by name, none opened yet) and has no saved layout: its sample is drawn.
    const freshCard = screen.getByRole("button", { name: "Open vault Fresh" }).closest(".kv-hero")!;
    expect(freshCard.querySelector(".kv-constellation")).toBeTruthy();
    expect(freshCard.querySelector(".kv-minimap")).toBeNull();
  });
});

describe("Landing — what changed since the last visit", () => {
  it("names the notes new since the page last showed a vault, says when the lead is writing notes, and opens it straight on a view", async () => {
    const storage = memoryStorage();
    storage.setItem("kv.recents", JSON.stringify({ v2: "2026-10-06T10:00:00Z" }));
    storage.setItem("kv.seen-notes", JSON.stringify({ v1: 371, v2: 280 }));
    const onOpenView = vi.fn();
    const a = api({
      fetchVaults: vi.fn(async () => [{ id: "v1", slug: "a", name: "Alpha", noteCount: 3 }, { id: "v2", slug: "b", name: "Team wiki", noteCount: 300 }]),
      fetchPipeline: vi.fn(async () => ({ state: "ready" as const, workflowId: "w", connectionId: "c", running: 1, waiting: 868, failures: [], hasRuns: true })),
    });
    render(<Landing engine={{ state: "ready" }} info={info} api={a} storage={storage} onOpenView={onOpenView} />);
    const lead = (await screen.findByRole("button", { name: "Open vault Team wiki" })).closest(".kv-hero") as HTMLElement;
    expect(await within(lead).findByText("+91 new notes")).toBeTruthy(); // 371 shown now, 280 last time
    expect(await within(lead).findByText("Writing notes…")).toBeTruthy();
    expect(a.fetchPipeline).toHaveBeenCalledWith(info, "v2");
    expect(within(screen.getByRole("region", { name: "Other vaults" })).queryByText(/new note/)).toBeNull(); // Alpha: nothing new
    // The counts shown are what the next visit compares with.
    await waitFor(() => expect(JSON.parse(storage.getItem("kv.seen-notes")!)).toEqual({ v1: 371, v2: 371 }));

    fireEvent.click(within(within(lead).getByRole("group", { name: "Open Team wiki on" })).getByRole("button", { name: "Notes" }));
    expect(onOpenView).toHaveBeenCalledWith(expect.objectContaining({ id: "v2", name: "Team wiki" }), "notes");
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
