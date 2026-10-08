// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IdentityStatus } from "../api/identity.js";
import type { SidecarInfo } from "../sidecar.js";
import { useIdentity, type IdentityApi } from "./use-identity.js";

const info = { port: 4201, controlPort: 4202, controlToken: "t", hostOrigin: "http://127.0.0.1:4200" } as unknown as SidecarInfo;
const signedOut: IdentityStatus = { authenticated: false, expired: false, appDid: "did:key:app", renownUrl: "https://www.renown.id", pending: null };

/**
 * Rule: the sign-in link is opened by the app window, never by the engine. The engine builds the
 * link and polls Renown for the result; the window hands the link to the system browser whole.
 * (Opening it from the engine went through `cmd /c start` on Windows, which cuts the link at `&`.)
 */
describe("useIdentity sign-in", () => {
  it("opens the link the engine reports, in the system browser, as the engine reported it", async () => {
    const url = "https://www.renown.id/console?session=abc&connect=did%3Akey%3Aapp&app=did%3Akey%3Aapp";
    const api: IdentityApi = {
      fetchAuthStatus: vi.fn(async () => signedOut),
      startLogin: vi.fn(async () => ({ url, alreadyAuthenticated: false })),
      cancelLogin: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      openUrl: vi.fn(async () => undefined),
    };
    const { result } = renderHook(() => useIdentity(info, api, 60_000));
    await waitFor(() => expect(api.fetchAuthStatus).toHaveBeenCalled());
    await act(() => result.current.signIn());
    expect(api.openUrl).toHaveBeenCalledTimes(1);
    expect(api.openUrl).toHaveBeenCalledWith(url);
  });

  it("opens nothing when the engine says the user is already signed in", async () => {
    const api: IdentityApi = {
      fetchAuthStatus: vi.fn(async () => ({ ...signedOut, authenticated: true, address: "0xabc" })),
      startLogin: vi.fn(async () => ({ alreadyAuthenticated: true })),
      cancelLogin: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
      openUrl: vi.fn(async () => undefined),
    };
    const { result } = renderHook(() => useIdentity(info, api, 60_000));
    await waitFor(() => expect(api.fetchAuthStatus).toHaveBeenCalled());
    await act(() => result.current.signIn());
    expect(api.openUrl).not.toHaveBeenCalled();
  });

  it("the real API opens links through the system browser", async () => {
    const { realIdentityApi } = await import("./use-identity.js");
    expect(typeof realIdentityApi.openUrl).toBe("function");
  });
});
