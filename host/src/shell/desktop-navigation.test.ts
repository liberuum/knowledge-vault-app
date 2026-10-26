// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// reactor-browser's store and helpers, reduced to what the navigation reads and writes.
const rb = vi.hoisted(() => {
  const store: { drives?: { header: { id: string; slug: string } }[]; selectedDriveId?: string; selectedNodeId?: string; navigation?: unknown } = {};
  let search: Record<string, string> = {};
  return {
    store,
    get search() {
      return search;
    },
    set search(next: Record<string, string>) {
      search = next;
    },
    open: vi.fn(),
  };
});
vi.mock("@powerhousedao/reactor-browser", () => ({
  getPHStore: () => rb.store,
  setSelectedDriveId: (id: string | undefined) => (rb.store.selectedDriveId = id),
  setSelectedNodeId: (id: string | undefined) => (rb.store.selectedNodeId = id),
  findDriveBySlug: (drives: { header: { id: string; slug: string } }[] | undefined, slug: string) => drives?.find((d) => d.header.slug === slug),
  extractNodeIdFromSlug: (slug: string) => slug.split("-").at(-1),
  makeDriveSlug: (drive: { header: { slug: string } }) => drive.header.slug,
  targetPathname: (target?: { driveSlug: string; nodeSlug?: string }) => (target ? `/d/${target.driveSlug}${target.nodeSlug ? `/${target.nodeSlug}` : ""}` : "/"),
  isSettingsTarget: (target: object | undefined) => !!target && "settings" in target,
  isGlobalSearchParam: (key: string) => key === "theme",
  browserNavigation: {
    open: rb.open,
    setSearch: (update: (prev: Record<string, string>) => Record<string, string | undefined>) => {
      rb.search = Object.fromEntries(Object.entries(update(rb.search)).filter((e): e is [string, string] => e[1] !== undefined));
    },
    hrefFor: (target?: { driveSlug: string }) => (target ? `/d/${target.driveSlug}` : "/"),
    useSearchParams: () => rb.search,
    useSetSearchParams: () => () => {},
  },
}));
import { desktopNavigation, installDesktopNavigation } from "./desktop-navigation.js";

const VAULT = { header: { id: "drive-1", slug: "my-vault" } };
afterEach(() => {
  for (const key of Object.keys(rb.store)) delete rb.store[key as keyof typeof rb.store];
  rb.search = {};
  rb.open.mockClear();
});

describe("desktop navigation (reactor-browser 6.2.3-dev.70+)", () => {
  it("opening a vault selects it in the store, and writes no Connect path for the shell's router to lose", () => {
    rb.store.drives = [VAULT];
    desktopNavigation.open({ driveSlug: "my-vault" });
    expect(rb.store.selectedDriveId).toBe("drive-1");
    expect(rb.store.selectedNodeId).toBeUndefined();
    expect(rb.open).not.toHaveBeenCalled();
    expect(desktopNavigation.location().pathname).toBe("/d/my-vault");
  });

  it("opening a document keeps its vault selected", () => {
    rb.store.drives = [VAULT];
    desktopNavigation.open({ driveSlug: "my-vault", nodeSlug: "a-note-node-7" });
    expect(rb.store.selectedDriveId).toBe("drive-1");
    expect(rb.store.selectedNodeId).toBe("7");
  });

  it("opening nothing closes the vault, as leaving the workspace does", () => {
    rb.store.drives = [VAULT];
    rb.store.selectedDriveId = "drive-1";
    rb.store.selectedNodeId = "7";
    desktopNavigation.open(undefined);
    expect(rb.store.selectedDriveId).toBeUndefined();
    expect(rb.store.selectedNodeId).toBeUndefined();
  });

  it("leaves Connect's settings page to the shell's own Settings", () => {
    rb.store.drives = [VAULT];
    rb.store.selectedDriveId = "drive-1";
    desktopNavigation.open({ settings: true });
    expect(rb.store.selectedDriveId).toBe("drive-1");
  });

  it("another document keeps only the app-wide params (the history panel closes); the same one takes `search` on top", () => {
    rb.store.drives = [VAULT];
    rb.store.selectedDriveId = "drive-1";
    rb.store.selectedNodeId = "7";
    rb.search = { history: "", theme: "dark" };
    desktopNavigation.open({ driveSlug: "my-vault", nodeSlug: "other-8" });
    expect(rb.search).toEqual({ theme: "dark" });
    desktopNavigation.open({ driveSlug: "my-vault", nodeSlug: "other-8" }, { search: { history: "" } });
    expect(rb.search).toEqual({ theme: "dark", history: "" });
  });

  it("has no document to return to: closing one goes to its folder instead", () => {
    expect(desktopNavigation.closeOpened?.()).toBe(false);
  });

  it("installs itself as the store's navigation", () => {
    installDesktopNavigation();
    expect(rb.store.navigation).toBe(desktopNavigation);
  });
});
