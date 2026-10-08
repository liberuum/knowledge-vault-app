// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { declareDesktopHost, HOST_CHANGED_EVENT, HOST_SLOT, setHostModel } from "./bootstrap.js";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HOST_SLOT];
  setHostModel(undefined); // the model is module state: one test's must not reach the next
});

describe("declareDesktopHost", () => {
  it("writes the slot the vault package reads, before the package is loaded", () => {
    declareDesktopHost("http://127.0.0.1:4201");
    expect((globalThis as Record<string, unknown>)[HOST_SLOT]).toEqual({ kind: "desktop", switchboardOrigin: "http://127.0.0.1:4201" });
  });
  it("re-declares with a bearer and identity for a remote vault, and tells the package", async () => {
    const heard = vi.fn();
    window.addEventListener(HOST_CHANGED_EVENT, heard);
    const bearer = () => Promise.resolve("jwt");
    declareDesktopHost("https://switchboard.knowledge-vault.vetra.io", { bearer, identity: { address: "0xabc" } });
    const slot = (globalThis as Record<string, unknown>)[HOST_SLOT] as { switchboardOrigin: string; bearer: () => Promise<string>; identity: { address: string } };
    expect(slot.switchboardOrigin).toBe("https://switchboard.knowledge-vault.vetra.io");
    expect(await slot.bearer()).toBe("jwt");
    expect(slot.identity).toEqual({ address: "0xabc" });
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener(HOST_CHANGED_EVENT, heard);
  });
  it("every declaration carries the app's model and the settings opener", () => {
    const open = () => {};
    setHostModel({ baseUrl: "http://127.0.0.1:4202/llm/v1", model: "m", label: "m on this computer" }, open);
    declareDesktopHost("http://127.0.0.1:4201");
    const slot = (globalThis as Record<string, unknown>)[HOST_SLOT] as { model?: unknown; openModelSettings?: unknown };
    expect(slot.model).toEqual({ baseUrl: "http://127.0.0.1:4202/llm/v1", model: "m", label: "m on this computer" });
    expect(slot.openModelSettings).toBe(open);
    setHostModel(null, open);
    declareDesktopHost("http://127.0.0.1:4201");
    expect(((globalThis as Record<string, unknown>)[HOST_SLOT] as { model?: unknown }).model).toBeNull();
  });
  it("a remote vault's declaration carries the app's model too: the chat still runs on the app's model there", () => {
    const open = () => {};
    const model = { baseUrl: "http://127.0.0.1:4202/llm/v1", model: "m", label: "m on this computer" };
    setHostModel(model, open);
    declareDesktopHost("https://switchboard.knowledge-vault.vetra.io", { bearer: () => Promise.resolve("jwt"), identity: { address: "0xabc" } });
    const slot = (globalThis as Record<string, unknown>)[HOST_SLOT] as { switchboardOrigin: string; model?: unknown; openModelSettings?: unknown };
    expect(slot.switchboardOrigin).toBe("https://switchboard.knowledge-vault.vetra.io");
    expect(slot.model).toEqual(model);
    expect(slot.openModelSettings).toBe(open);
  });
  it("a host that declares no model leaves the keys out altogether: absent is not null, and the chat keeps its own connections", () => {
    setHostModel(undefined);
    declareDesktopHost("http://127.0.0.1:4201");
    const slot = (globalThis as Record<string, unknown>)[HOST_SLOT] as object;
    expect(Object.keys(slot).sort()).toEqual(["kind", "switchboardOrigin"]);
  });
  it("a model without an opener declares the model alone", () => {
    setHostModel({ baseUrl: "http://127.0.0.1:4202/llm/v1", model: "m", label: "m on this computer" });
    declareDesktopHost("http://127.0.0.1:4201");
    const slot = (globalThis as Record<string, unknown>)[HOST_SLOT] as object;
    expect(Object.keys(slot).sort()).toEqual(["kind", "model", "switchboardOrigin"]);
  });
});
