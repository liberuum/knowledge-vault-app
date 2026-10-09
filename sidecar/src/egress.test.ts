import { describe, expect, it } from "vitest";
import { isPrivateAddress, privateHostAllow, resolvesPrivate } from "./egress.js";
describe("privateHostAllow — the egress entry a LAN model server needs", () => {
  it("names private IPv4 and IPv6 literals as single-address ranges, and nothing for loopback or public hosts", () => {
    expect(privateHostAllow("http://192.168.1.20:11434/v1")).toBe("192.168.1.20/32");
    expect(privateHostAllow("http://10.0.0.5/v1")).toBe("10.0.0.5/32");
    expect(privateHostAllow("http://172.16.3.4:8080/v1")).toBe("172.16.3.4/32");
    expect(privateHostAllow("http://172.32.0.1/v1")).toBeNull(); // not RFC 1918
    expect(privateHostAllow("http://[fd00::1]:11434/v1")).toBe("fd00::1/128");
    expect(privateHostAllow("http://127.0.0.1:11434/v1")).toBeNull();
    expect(privateHostAllow("http://localhost:11434/v1")).toBeNull();
    expect(privateHostAllow("https://openrouter.ai/api/v1")).toBeNull();
    expect(privateHostAllow("not a url")).toBeNull();
  });
});

describe("a network of your own", () => {
  it("counts this computer, the LAN, a VPN such as Tailscale, and private IPv6, and nothing on the internet", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.9", "100.101.102.103", "169.254.10.1", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:192.168.1.5"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "100.128.0.1", "100.63.255.255", "172.32.0.1", "2001:4860:4860::8888"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(privateHostAllow("http://100.101.102.103:11434/v1")).toBe("100.101.102.103/32");
  });

  it("resolves a name once: a MagicDNS or LAN name counts when every address it has is private", async () => {
    const dns = (answers: Record<string, string[]>) => async (host: string) => {
      if (!answers[host]) throw new Error("ENOTFOUND");
      return answers[host]!.map((address) => ({ address }));
    };
    const resolve = dns({ "gpu-box.tail1234.ts.net": ["100.101.102.103"], "nas.local": ["192.168.1.20", "fe80::2"], "mixed.example": ["10.0.0.2", "93.184.216.34"], "example.com": ["93.184.216.34"] });
    expect(await resolvesPrivate("http://gpu-box.tail1234.ts.net:11434/v1", resolve)).toBe(true);
    expect(await resolvesPrivate("http://nas.local:1234/v1", resolve)).toBe(true);
    expect(await resolvesPrivate("http://mixed.example/v1", resolve)).toBe(false);
    expect(await resolvesPrivate("https://example.com/v1", resolve)).toBe(false);
    expect(await resolvesPrivate("http://unknown-host:8080/v1", resolve)).toBe(false);
    expect(await resolvesPrivate("http://100.101.102.103:8080/v1", resolve)).toBe(true); // an address needs no lookup
    expect(await resolvesPrivate("http://slow.example/v1", () => new Promise(() => {}), 20)).toBe(false); // no answer in time
  });
});

