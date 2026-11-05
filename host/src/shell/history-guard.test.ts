// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installHistoryGuard, setHistoryEditorRestorer } from "./history-guard.js";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("history guard — the shell's hash route stays authoritative", () => {
  it("rewrites Connect-style path writes to the root and keeps the current hash", () => {
    const uninstall = installHistoryGuard();
    window.location.hash = "#/vault/abc";
    window.history.pushState(null, "", "/d/research-notes");
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("#/vault/abc");
    window.location.hash = "#/settings/models";
    window.history.pushState(null, "", "/");
    expect(`${window.location.pathname}${window.location.hash}`).toBe("/#/settings/models");
    window.history.replaceState(null, "", "/d/research-notes/some-node");
    expect(`${window.location.pathname}${window.location.hash}`).toBe("/#/settings/models");
    uninstall();
  });
  it("lets a write that carries its own hash through, and keeps the query string", () => {
    const uninstall = installHistoryGuard();
    window.location.hash = "#/vault/abc";
    window.history.pushState(null, "", "/#/workflows");
    expect(`${window.location.pathname}${window.location.hash}`).toBe("/#/workflows");
    window.history.replaceState(null, "", "/?user=0xabc");
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/?user=0xabc#/workflows");
    uninstall();
  });
  it("does not add a history entry for a write that changes nothing", () => {
    const uninstall = installHistoryGuard();
    window.location.hash = "#/vault/abc";
    const before = window.history.length;
    window.history.pushState(null, "", "/d/research-notes"); // becomes /#/vault/abc — where we already are
    expect(window.history.length).toBe(before);
    uninstall();
  });
});

describe("history guard — back and forward keep the app open and walk its editors", () => {
  it("records the open editor on each entry, and on popstate reopens that editor before the page's other listeners hear it", () => {
    const uninstall = installHistoryGuard();
    const ph = { selectedDriveId: "workflows", selectedNodeId: "wf-1" };
    (window as unknown as { ph: typeof ph }).ph = ph;
    window.history.pushState(null, "", "/#wf-1"); // Studio selecting wf-1 with its editor open
    expect(window.history.state).toEqual({ phNode: "wf-1" });

    const restored: Array<string | undefined> = [];
    setHistoryEditorRestorer((id) => restored.push(id));
    // Workflow Studio reads its selection (?item=) through reactor-browser's search params, which follow popstate; with a
    // host navigation set, reactor-browser's own path sync stands down, so nothing reads the selection from the path.
    const heard: Array<Array<string | undefined>> = [];
    const studio = () => heard.push([...restored]);
    window.addEventListener("popstate", studio);
    ph.selectedNodeId = "wf-2";
    window.dispatchEvent(new PopStateEvent("popstate", { state: { phNode: "wf-1" } }));
    window.dispatchEvent(new PopStateEvent("popstate", { state: null })); // an entry the router made: no editor
    expect(restored).toEqual(["wf-1", undefined]);
    expect(heard, "Studio hears each step, after the editor is reopened").toEqual([["wf-1"], ["wf-1", undefined]]);
    window.removeEventListener("popstate", studio);
    uninstall();
  });
});

