import { describe, expect, it } from "vitest";
import { packageOf, verdict } from "./engine-load-check.mjs";

describe("engine load check", () => {
  const nm = "/stage/sidecar/node_modules";
  it("names the package a loaded file belongs to, scoped or not, and nothing outside node_modules", () => {
    expect(packageOf("file:///stage/sidecar/node_modules/viem/_esm/index.js", nm)).toBe("viem");
    expect(packageOf("file:///stage/sidecar/node_modules/@renown/sdk/dist/node.js", nm)).toBe("@renown/sdk");
    expect(packageOf("file:///stage/sidecar/node_modules/@wagmi/connectors/dist/x.js", nm)).toBe("@wagmi/connectors");
    expect(packageOf("file:///stage/sidecar/dist/main.js", nm)).toBeNull();
    // percent-encoded spaces in the path; a Windows drive path only on Windows (fileURLToPath is the OS's)
    expect(packageOf("file:///stage/Knowledge%20Vault/node_modules/viem/index.js", "/stage/Knowledge Vault/node_modules")).toBe("viem");
    if (process.platform === "win32") expect(packageOf("file:///C:/Program%20Files/Knowledge%20Vault/sidecar/node_modules/viem/index.js", "C:\\Program Files\\Knowledge Vault\\sidecar\\node_modules")).toBe("viem");
    expect(packageOf("not a url", nm)).toBeNull();
  });
  it("fails on a loaded wallet package or a missing module, and not on the onnxruntime-node fallback the engine expects", () => {
    const ok = verdict(["file:///stage/sidecar/node_modules/@renown/sdk/dist/node.js", "file:///stage/sidecar/node_modules/viem/index.js"], nm, "[Embedder] onnxruntime-node not found (Cannot find package 'onnxruntime-node'), falling back to wasm\n");
    expect(ok).toEqual({ dropped: [], missing: [] });
    const bad = verdict(["file:///stage/sidecar/node_modules/wagmi/dist/index.js", "file:///stage/sidecar/node_modules/@privy-io/react-auth/dist/i.js"], nm, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@reown/appkit'\n");
    expect(bad.dropped).toEqual(["wagmi", "@privy-io/react-auth"]);
    expect(bad.missing).toHaveLength(1);
  });
});
