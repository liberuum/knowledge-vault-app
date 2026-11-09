import { describe, expect, it, vi } from "vitest";
import { followVaultWrites } from "./vault-writes.js";

const announce = (target: EventTarget, detail: unknown) =>
  target.dispatchEvent(new CustomEvent("MutateDocument", { detail }));

describe("followVaultWrites", () => {
  it("re-reads every document the vault says it wrote", () => {
    const target = new EventTarget();
    const reread = vi.fn().mockResolvedValue(undefined);
    followVaultWrites(target, reread);
    announce(target, { identifier: "drive-1" });
    expect(reread).toHaveBeenCalledWith("drive-1");
  });

  it("ignores an announcement without an id, and a failed read", async () => {
    const target = new EventTarget();
    const reread = vi.fn().mockRejectedValue(new Error("offline"));
    followVaultWrites(target, reread);
    announce(target, undefined);
    announce(target, { identifier: 42 });
    expect(reread).not.toHaveBeenCalled();
    announce(target, { identifier: "drive-1" });
    await Promise.resolve();
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("stops when asked", () => {
    const target = new EventTarget();
    const reread = vi.fn().mockResolvedValue(undefined);
    followVaultWrites(target, reread)();
    announce(target, { identifier: "drive-1" });
    expect(reread).not.toHaveBeenCalled();
  });
});
