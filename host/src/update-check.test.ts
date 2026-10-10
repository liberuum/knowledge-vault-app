import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, compareSemver } from "./update-check.js";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const feed = "https://api.github.com/repos/o/r/releases/latest";
const release = (tag: string) => ({ ok: true, json: async () => ({ tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}` }) });

describe("compareSemver", () => {
  it("orders versions the semver way, a leading v ignored, prereleases below their release", () => {
    expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
    expect(compareSemver("0.1.0-beta.2", "0.1.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("v0.3.0", "0.3.0")).toBe(0);
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
  });
});
describe("checkForUpdate", () => {
  it("is off without a feed, reports a newer release, caches the answer for an hour and a half, and never throws", async () => {
    const storage = memory();
    const fetchImpl = vi.fn(async () => release("v0.2.0")) as unknown as typeof fetch;
    expect(await checkForUpdate("", "0.1.0", fetchImpl, storage, () => 0)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    const first = await checkForUpdate(feed, "0.1.0", fetchImpl, storage, () => 1_000);
    expect(first).toEqual({ latest: "0.2.0", url: "https://github.com/o/r/releases/tag/v0.2.0", assets: [] });
    expect(await checkForUpdate(feed, "0.1.0", fetchImpl, storage, () => 1_000 + 89 * 60_000)).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await checkForUpdate(feed, "0.1.0", fetchImpl, storage, () => 1_000 + 91 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await checkForUpdate(feed, "0.2.0", fetchImpl, storage, () => 1_000 + 91 * 60_000)).toBeNull();
    expect(JSON.parse(storage.getItem("kv.update-check.v2")!)).toMatchObject({ latest: "0.2.0" });
    const broken = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await checkForUpdate(feed, "0.1.0", broken, memory(), () => 0)).toBeNull();
  });
  it("reads GitHub's list of releases: the newest wins, pre-releases count, drafts do not, its files come along", async () => {
    const list = [
      { tag_name: "v0.2.1", html_url: "u1", prerelease: true, assets: [{ name: "Knowledge-Vault_0.2.1_macOS_Apple-silicon.dmg", browser_download_url: "https://github.com/x/0.2.1.dmg", size: 9 }] },
      { tag_name: "v0.3.0", html_url: "u3", draft: true },
      { tag_name: "v0.2.2-dev.1", html_url: "u2", assets: [{ name: "a.dmg", browser_download_url: "https://github.com/x/a.dmg", size: 7 }, { name: "no-url" }] },
      null,
    ];
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => list })) as unknown as typeof fetch;
    expect(await checkForUpdate(feed, "0.2.0", fetchImpl, memory(), () => 0)).toEqual({ latest: "0.2.2-dev.1", url: "u2", assets: [{ name: "a.dmg", url: "https://github.com/x/a.dmg", size: 7 }] });
    const empty = vi.fn(async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch;
    expect(await checkForUpdate(feed, "0.2.0", empty, memory(), () => 0)).toBeNull();
  });
});
