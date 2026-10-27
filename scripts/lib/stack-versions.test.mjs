import { describe, expect, it } from "vitest";
import { checkPgliteVersion, checkStackVersions, checkVaultAssets } from "./stack-versions.mjs";

describe("checkStackVersions", () => {
  it("accepts a workspace where every stack package is pinned to the expected version", () => {
    const out = checkStackVersions(
      [
        { name: "sidecar", deps: { "@powerhousedao/switchboard": "6.2.3-dev.44", "document-model": "6.2.3-dev.44" } },
        { name: "host", deps: { "@powerhousedao/reactor-browser": "6.2.3-dev.44", react: "19.2.6" } },
      ],
      "6.2.3-dev.44",
    );
    expect(out).toEqual([]);
  });

  it("ignores the file-linked vault package, its assets and document-engineering", () => {
    const out = checkStackVersions(
      [{ name: "host", deps: { "@powerhousedao/knowledge-note": "file:../../bai-knowledge-note", "@powerhousedao/knowledge-vault-assets": "1.0.0", "@powerhousedao/document-engineering": "1.40.5" } }],
      "6.2.3-dev.44",
    );
    expect(out).toEqual([]);
  });

  it("names every mismatch with its workspace and package", () => {
    const out = checkStackVersions(
      [{ name: "sidecar", deps: { "@powerhousedao/switchboard": "6.2.3-dev.43" } }],
      "6.2.3-dev.44",
    );
    expect(out).toEqual(["sidecar: @powerhousedao/switchboard is 6.2.3-dev.43, expected 6.2.3-dev.44"]);
  });
});

describe("checkPgliteVersion", () => {
  it("accepts a sidecar pin equal to the Switchboard's own", () => {
    expect(checkPgliteVersion("0.3.15", "0.3.15")).toBeNull();
  });
  it("names a mismatch and a Switchboard without the dependency", () => {
    expect(checkPgliteVersion("0.3.16", "0.3.15")).toBe("sidecar: @electric-sql/pglite is 0.3.16, the Switchboard pins 0.3.15");
    expect(checkPgliteVersion("0.3.15", undefined)).toMatch(/cannot verify/);
  });
});

describe("checkVaultAssets", () => {
  it("accepts the sidecar pinning exactly the assets version the vault package names", () => {
    expect(checkVaultAssets("1.0.0", "1.0.0")).toBeNull();
  });
  it("names a missing or different pin, and a vault package that names none", () => {
    expect(checkVaultAssets(undefined, "1.0.0")).toBe("sidecar: @powerhousedao/knowledge-vault-assets is missing, the vault package needs 1.0.0");
    expect(checkVaultAssets("1.0.1", "1.0.0")).toBe("sidecar: @powerhousedao/knowledge-vault-assets is 1.0.1, the vault package needs 1.0.0");
    expect(checkVaultAssets("1.0.0", undefined)).toMatch(/cannot verify/);
  });
});
