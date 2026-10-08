import { describe, expect, it } from "vitest";
import { debBinaries, releaseNotes, sizeLine, withSizes } from "./release-notes.mjs";

describe("releaseNotes", () => {
  it("names the versions it was built from — read from the manifests, never typed in", () => {
    const notes = releaseNotes({ app: "0.2.0", stack: "6.2.3-dev.44", vaultPackage: "1.0.54-dev.24", node: "24.21.0" });
    expect(notes).toContain("Knowledge Vault 0.2.0");
    expect(notes).toContain("Powerhouse stack **6.2.3-dev.44**");
    expect(notes).toContain("@powerhousedao/knowledge-note **1.0.54-dev.24**");
    expect(notes).toContain("Node **24.21.0**");
    expect(notes).toMatch(/not notarised/i);
    expect(notes).toMatch(/Open Anyway/);
    expect(notes).toMatch(/\*\*Done\*\* — not \*Move to Bin\*/);
    expect(notes).toContain('xattr -dr com.apple.quarantine "/Applications/Knowledge Vault.app"');
    expect(notes).toMatch(/13\.5/);
  });
  it("formats an installer's size in MB", () => {
    expect(sizeLine("Knowledge-Vault_0.2.0_Linux_x86-64.AppImage", 231_456_789)).toBe("| Knowledge-Vault_0.2.0_Linux_x86-64.AppImage | 231 MB |");
  });
});
describe("withSizes", () => {
  it("adds one table of the installers, replacing any previous one — a re-run never appends a second", () => {
    const assets = [
      { name: "Knowledge-Vault_0.2.0_Linux_x86-64.AppImage", size: 317_000_000 },
      { name: "Knowledge-Vault_0.2.0_Linux_x86-64.deb", size: 271_000_000 },
      { name: "Knowledge-Vault_0.2.0_macOS_Apple-silicon.dmg", size: 190_000_000 },
      { name: "latest.json", size: 900 },
    ];
    const once = withSizes("Notes body.", assets);
    expect(once).toContain("### Installers");
    expect(once).toContain("| Knowledge-Vault_0.2.0_Linux_x86-64.AppImage | 317 MB |");
    expect(once).not.toContain("latest.json");
    const twice = withSizes(once, assets);
    expect(twice).toBe(once);
    expect(twice.match(/### Installers/g)).toHaveLength(1);
  });
});
describe("debBinaries", () => {
  it("lists what a .deb would install into /usr/bin", () => {
    const listing = [
      "-rwxr-xr-x root/root  12 2026-10-07 12:00 ./usr/bin/knowledge-vault-app",
      "-rwxr-xr-x root/root  99 2026-10-07 12:00 ./usr/bin/kv-node",
      "drwxr-xr-x root/root   0 2026-10-07 12:00 ./usr/bin/",
      "-rw-r--r-- root/root  10 2026-10-07 12:00 ./usr/lib/Knowledge Vault/sidecar/package.json",
    ].join("\n");
    expect(debBinaries(listing)).toEqual(["knowledge-vault-app", "kv-node"]);
    // tar -t of a Tauri deb: no leading ./, and bin/ folders deep in node_modules are not /usr/bin
    expect(debBinaries("usr/bin\nusr/bin/knowledge-vault-app\nusr/bin/kv-node\nusr/lib/Knowledge Vault/sidecar/node_modules/x/bin/x.js")).toEqual(["knowledge-vault-app", "kv-node"]);
  });
});
