// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveSummary, TransferJob } from "../backup-files.js";
import type { SettingsApi } from "../screens/Settings.js";
import type { SidecarInfo } from "../sidecar.js";
import type { ActionResult, BackupInfo } from "../vaults.js";
import { BackupsSection, friendlyWhen, lastBackupLine, vaultsLine } from "./Backups.js";

const info = { origin: "http://127.0.0.1:4201", controlOrigin: "http://127.0.0.1:4202", controlToken: "t" } as SidecarInfo;
const NOW = new Date();
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const points: BackupInfo[] = [
  { name: "2026-10-10T17-19-09Z-6.2.3-dev.44", path: "/b/1", bytes: 74_000_000, stackVersion: "6.2.3-dev.44", createdAt: iso(5), kind: "backup", vaults: [{ name: "Research", noteCount: 39 }] },
  { name: "pre-restore-2026-10-10T19-05-01Z", path: "/b/2", bytes: 60_000_000, stackVersion: "6.2.3-dev.44", createdAt: iso(60), kind: "pre-restore" },
  { name: "imported-2026-10-09T08-00-00Z-6.2.3-dev.44", path: "/b/3", bytes: 50_000_000, stackVersion: "6.2.3-dev.44", createdAt: iso(3000), kind: "imported", importedFrom: "laptop.kvbackup" },
];
const before: ActionResult = { action: "backup", ok: true, detail: "Backed up 74 MB.", at: "2026-10-10T17:19:10.000Z" };
const job = (over: Partial<TransferJob>): TransferJob => ({ id: "j1", kind: "export", state: "running", done: 0, total: 100, file: "/home/u/x.kvbackup", backup: null, restore: false, bytes: null, error: null, startedAt: iso(0), finishedAt: null, ...over });
const summary: ArchiveSummary = { file: "/home/u/Downloads/laptop.kvbackup", fileBytes: 18_000_000, name: "2026-10-10T17-19-09Z-6.2.3-dev.44", createdAt: iso(5), stackVersion: "6.2.3-dev.44", appVersion: "0.2.2", bytes: 74_000_000, vaults: [{ name: "Research", noteCount: 39 }], tooNew: false };

/** An engine whose answers move on as the test says. */
function api(over: Partial<SettingsApi> = {}) {
  const state = { last: before, backups: points, transfers: [] as Array<TransferJob | null | Error> };
  const a = {
    fetchVaults: vi.fn(async () => [{ id: "v1", slug: "research", name: "Research", noteCount: 39 }]),
    fetchBackups: vi.fn(async () => ({ backups: state.backups, lastAction: state.last })),
    requestBackup: vi.fn(async () => ({ restarting: true })),
    requestRestore: vi.fn(async () => ({ restarting: true })),
    requestDeleteAll: vi.fn(async () => ({ restarting: true })),
    exportToFile: vi.fn(async () => ({ restarting: true })),
    saveBackupToFile: vi.fn(async (_i: SidecarInfo, name: string, path: string) => job({ backup: name, file: path })),
    deleteBackup: vi.fn(async (_i: SidecarInfo, name: string) => {
      state.backups = state.backups.filter((b) => b.name !== name);
    }),
    inspectBackupFile: vi.fn(async () => summary),
    importBackupFile: vi.fn(async (_i: SidecarInfo, file: string, restore: boolean) => job({ id: "j2", kind: "import", file, restore })),
    fetchTransfer: vi.fn(async () => {
      const next = state.transfers.length > 1 ? state.transfers.shift()! : (state.transfers[0] ?? null);
      if (next instanceof Error) throw next;
      return next;
    }),
    chooseExportPath: vi.fn(async () => "/home/u/Downloads/Knowledge Vault backup.kvbackup"),
    chooseImportFile: vi.fn(async () => "/home/u/Downloads/laptop.kvbackup"),
    ...over,
  };
  return { a: a as unknown as SettingsApi, state };
}
const mount = (a: SettingsApi, onRestarted = vi.fn()) => {
  render(<BackupsSection info={info} api={a} pollMs={5} canPickFiles onRestarted={onRestarted} />);
  return onRestarted;
};
afterEach(() => cleanup());

describe("Backup & restore", () => {
  it("leads with how recent the last backup is, and lists the restore points newest first with what made them", async () => {
    const { a } = api();
    mount(a);
    expect(await screen.findByRole("heading", { name: /^Backed up today at/ })).toBeTruthy();
    expect(await screen.findByText("Research · 39 notes on this computer")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Restore points" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]!.textContent).toMatch(/Newest/);
    expect(rows[0]!.textContent).toMatch(/Research · 39 notes · 74 MB/);
    expect(rows[1]!.textContent).toMatch(/Before a restore/);
    expect(rows[2]!.textContent).toMatch(/Imported.*from laptop\.kvbackup/);
  });

  it("exports: a Save dialog, a clean copy while the engine restarts, then the file written with its progress", async () => {
    const { a, state } = api();
    mount(a);
    await screen.findByRole("list", { name: "Restore points" });
    vi.mocked(a.exportToFile).mockImplementationOnce(async () => {
      state.last = { action: "backup", ok: true, detail: "Backed up.", at: "2026-10-10T20:00:00.000Z", };
      state.transfers = [new Error("restarting"), job({ file: "/home/u/Downloads/Knowledge Vault backup.kvbackup", done: 40 }), job({ file: "/home/u/Downloads/Knowledge Vault backup.kvbackup", state: "done", done: 100, bytes: 18_000_000 })];
      return { restarting: true };
    });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(a.exportToFile).toHaveBeenCalledWith(info, "/home/u/Downloads/Knowledge Vault backup.kvbackup"));
    expect(a.chooseExportPath).toHaveBeenCalledWith(expect.stringMatching(/^Knowledge Vault backup \d{4}-\d{2}-\d{2}\.kvbackup$/));
    const done = await screen.findByRole("status");
    await waitFor(() => expect(done.textContent).toMatch(/Exported/));
    expect(done.textContent).toMatch(/Knowledge Vault backup\.kvbackup · 18 MB/);
  });

  it("a cancelled Save dialog changes nothing", async () => {
    const { a } = api({ chooseExportPath: vi.fn(async () => null) });
    mount(a);
    await screen.findByRole("list", { name: "Restore points" });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(a.chooseExportPath).toHaveBeenCalled());
    expect(a.exportToFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("imports: shows what the file holds first, then unpacks it, switches to it and reloads once the engine answers", async () => {
    const { a, state } = api();
    const onRestarted = mount(a);
    await screen.findByRole("list", { name: "Restore points" });
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/laptop\.kvbackup/);
    expect(dialog.textContent).toMatch(/Research · 39 notes/);
    expect(dialog.textContent).toMatch(/Knowledge Vault 0\.2\.2/);
    expect(dialog.textContent).toMatch(/saved as a restore point first/);
    vi.mocked(a.importBackupFile).mockImplementationOnce(async (_i: SidecarInfo, file: string, restore: boolean) => {
      state.transfers = [job({ id: "j2", kind: "import", file, restore, done: 50 }), job({ id: "j2", kind: "import", file, restore, state: "done", done: 100 }), new Error("restarting")];
      setTimeout(() => (state.last = { action: "restore", ok: true, detail: "Restored.", at: "2026-10-10T20:01:00.000Z" }), 30);
      return job({ id: "j2", kind: "import", file, restore });
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import and replace" }));
    await waitFor(() => expect(a.importBackupFile).toHaveBeenCalledWith(info, "/home/u/Downloads/laptop.kvbackup", true));
    expect(await screen.findByText(/Unpacking laptop\.kvbackup/)).toBeTruthy();
    await waitFor(() => expect(onRestarted).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("only adds an imported file to the restore points when asked to", async () => {
    const { a, state } = api();
    const onRestarted = mount(a);
    await screen.findByRole("list", { name: "Restore points" });
    vi.mocked(a.importBackupFile).mockImplementationOnce(async (_i: SidecarInfo, file: string, restore: boolean) => {
      state.transfers = [job({ id: "j2", kind: "import", file, restore, state: "done", done: 100 })];
      return job({ id: "j2", kind: "import", file, restore });
    });
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Only add to restore points" }));
    await waitFor(() => expect(a.importBackupFile).toHaveBeenCalledWith(info, "/home/u/Downloads/laptop.kvbackup", false));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Added to restore points/));
    expect(onRestarted).not.toHaveBeenCalled();
  });

  it("a file from a newer app cannot be imported, and a file that is not a backup is named as such", async () => {
    const { a } = api({ inspectBackupFile: vi.fn(async () => ({ ...summary, tooNew: true, stackVersion: "9.0.0" })) });
    mount(a);
    await screen.findByRole("list", { name: "Restore points" });
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    const dialog = await screen.findByRole("dialog", { name: "This file needs a newer app" });
    expect(within(dialog).queryByRole("button", { name: "Import and replace" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    cleanup();

    const { a: b } = api({ inspectBackupFile: vi.fn(async () => Promise.reject(new Error("notes.txt is not a Knowledge Vault backup."))) });
    mount(b);
    await screen.findByRole("list", { name: "Restore points" });
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Importing did not finish/);
    expect(alert.textContent).toMatch(/notes\.txt is not a Knowledge Vault backup/);
  });

  it("saves an existing restore point to a file, and deletes one after confirming", async () => {
    const { a, state } = api();
    mount(a);
    await screen.findByRole("list", { name: "Restore points" });
    state.transfers = [job({ file: "/home/u/Downloads/Knowledge Vault backup.kvbackup", state: "done", done: 100, bytes: 9_000_000 })];
    fireEvent.click(screen.getAllByRole("button", { name: /^Save the restore point of/ })[0]!);
    await waitFor(() => expect(a.saveBackupToFile).toHaveBeenCalledWith(info, points[0]!.name, "/home/u/Downloads/Knowledge Vault backup.kvbackup"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Exported.*9 MB/));

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete the restore point of/ })[2]!);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(a.deleteBackup).toHaveBeenCalledWith(info, points[2]!.name));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Restore points" })).getAllByRole("listitem")).toHaveLength(2));
  });

  it("deletes all local data through a dialog: what goes and stays, the restore points kept unless ticked, the word typed", async () => {
    const { a } = api();
    mount(a);
    await screen.findByRole("list", { name: "Restore points" });
    const card = screen.getByRole("region", { name: "Delete all local data" });
    expect(within(card).getByRole("list", { name: "Removed" }).textContent).toMatch(/Every local vault/);
    expect(within(card).getByRole("list", { name: "Kept" }).textContent).toMatch(/Restore points, unless you choose otherwise/);
    expect(within(card).queryByRole("textbox")).toBeNull(); // no bare field on the page

    fireEvent.click(within(card).getByRole("button", { name: "Delete all local data…" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete all local data?" });
    const field = within(dialog).getByLabelText("Type delete to confirm") as HTMLInputElement;
    expect(field.className).toMatch(/kv-bk-confirm/);
    expect(document.activeElement).toBe(field);
    expect(dialog.textContent).toMatch(/Your 3 restore points \(184 MB\) stay/);
    const go = within(dialog).getByRole("button", { name: "Delete everything" }) as HTMLButtonElement;
    fireEvent.change(field, { target: { value: "Delete " } }); // case and spaces forgiven
    expect(go.disabled).toBe(false);
    expect(field.className).toMatch(/is-confirmed/);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Also delete the restore points/ }));
    expect(dialog.textContent).toMatch(/nothing can be brought back/);
    fireEvent.click(go);
    await waitFor(() => expect(a.requestDeleteAll).toHaveBeenCalledWith(info, true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers to export first from the delete-all dialog, and says when nothing could be brought back", async () => {
    const { a } = api({ chooseExportPath: vi.fn(async () => null) });
    mount(a);
    await screen.findByRole("list", { name: "Restore points" });
    fireEvent.click(screen.getByRole("button", { name: "Delete all local data…" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Export to a file first" }));
    await waitFor(() => expect(a.chooseExportPath).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(a.requestDeleteAll).not.toHaveBeenCalled();
    cleanup();

    const { a: none } = api({ fetchBackups: vi.fn(async () => ({ backups: [], lastAction: null })) });
    mount(none);
    await screen.findByText(/No restore points yet/);
    fireEvent.click(screen.getByRole("button", { name: "Delete all local data…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/There are no restore points, so nothing can be brought back/);
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });

  it("words time, freshness and contents the way people say them", () => {
    const now = new Date(2026, 9, 10, 20, 0);
    expect(friendlyWhen(new Date(2026, 9, 10, 18, 19).toISOString(), now)).toMatch(/^Today, /);
    expect(friendlyWhen(new Date(2026, 9, 9, 9, 2).toISOString(), now)).toMatch(/^Yesterday, /);
    expect(friendlyWhen(new Date(2025, 2, 6, 9, 2).toISOString(), now)).toMatch(/2025/);
    expect(lastBackupLine(undefined, now)).toEqual({ text: "No backup yet", fresh: false });
    const at = (d: Date): BackupInfo => ({ ...points[0]!, createdAt: d.toISOString() });
    expect(lastBackupLine(at(new Date(2026, 9, 7, 12)), now)).toEqual({ text: "Backed up 3 days ago", fresh: true });
    expect(lastBackupLine(at(new Date(2026, 8, 20, 12)), now)).toEqual({ text: "Last backup 20 days ago", fresh: false });
    expect(vaultsLine([{ name: "Research", noteCount: 1 }])).toBe("Research · 1 note");
    expect(vaultsLine([{ name: "A", noteCount: 1200 }, { name: "B", noteCount: 3 }])).toBe("2 vaults · 1,203 notes");
    expect(vaultsLine(undefined)).toBeNull();
  });
});
