import { describe, expect, it } from "vitest";
import { MOVE_FIRST_MESSAGE, mustMoveFirst, readAppLocation } from "./app-location.js";

describe("readAppLocation", () => {
  it("reads only the places the shell sends", () => {
    expect(readAppLocation({ KV_APP_LOCATION: "disk-image" })).toBe("disk-image");
    expect(readAppLocation({ KV_APP_LOCATION: "translocated" })).toBe("translocated");
    expect(readAppLocation({ KV_APP_LOCATION: "downloads" })).toBe("downloads");
    expect(readAppLocation({})).toBeUndefined();
    expect(readAppLocation({ KV_APP_LOCATION: "" })).toBeUndefined();
    expect(readAppLocation({ KV_APP_LOCATION: "anywhere" })).toBeUndefined();
  });
});

describe("mustMoveFirst", () => {
  it("refuses only an upgrade started from a temporary place", () => {
    expect(mustMoveFirst("disk-image", "upgrade")).toBe(true);
    expect(mustMoveFirst("downloads", "upgrade")).toBe(true);
    expect(mustMoveFirst("translocated", "upgrade")).toBe(true);
  });
  it("leaves every other start as it was", () => {
    for (const relation of ["fresh", "same", "downgrade"] as const) expect(mustMoveFirst("disk-image", relation)).toBe(false);
    for (const relation of ["fresh", "same", "upgrade", "downgrade"] as const) expect(mustMoveFirst(undefined, relation)).toBe(false);
  });
});

describe("MOVE_FIRST_MESSAGE", () => {
  it("says where it runs, what would go wrong, and what to do", () => {
    expect(MOVE_FIRST_MESSAGE("disk-image")).toBe(
      "This version upgrades your vaults, and it is running from the disk image rather than from Applications. Your Dock would keep opening the older copy, which can't read upgraded vaults. Move it to Applications first; it opens again from there.",
    );
    expect(MOVE_FIRST_MESSAGE("downloads")).toContain("from the Downloads folder");
    expect(MOVE_FIRST_MESSAGE("translocated")).toContain("from where it was downloaded");
  });
});
