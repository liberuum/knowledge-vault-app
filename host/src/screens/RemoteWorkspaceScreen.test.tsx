// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../reactor.js", () => ({ activate: vi.fn(() => ({})) }));
vi.mock("../bootstrap.js", () => ({ declareDesktopHost: vi.fn() }));
vi.mock("./WorkspaceScreen.js", () => ({ WorkspaceScreen: () => <div>the vault app</div> }));
vi.mock("../api/identity.js", () => ({ createTokenProvider: () => Object.assign(async () => "jwt", { invalidate: () => {} }) }));
import { RemoteWorkspaceScreen } from "./RemoteWorkspaceScreen.js";

const info = { origin: "http://127.0.0.1:4201", graphqlUrl: "http://127.0.0.1:4201/graphql", controlOrigin: "http://127.0.0.1:4202", controlToken: "t" };
const vault = { kind: "remote" as const, id: "c589", slug: "pk", name: "powerhouse-knowledge", switchboardUrl: "https://switchboard.knowledge-vault.vetra.io", addedAt: "2026-10-06T00:00:00Z" };
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("RemoteWorkspaceScreen", () => {
  it("says the vault needs a connection while its server cannot be reached, and clears it when it answers", async () => {
    vi.useFakeTimers();
    let down = true;
    const probe = vi.fn(async () => { if (down) throw new TypeError("Failed to fetch"); return new Response("{}"); }) as unknown as typeof fetch;
    render(<RemoteWorkspaceScreen info={info} vault={vault} identity={undefined} onBack={() => {}} probeFetch={probe} probeMs={1000} />);
    expect(screen.getByText("the vault app")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("status").textContent).toContain("You're offline — this vault lives on switchboard.knowledge-vault.vetra.io and needs a connection.");
    down = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByText(/You're offline/)).toBeNull();
  });
});
