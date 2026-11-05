/**
 * The Node bundled with the app — one place. 26 is the active LTS line (Lithium, LTS since 2026-10-28); the dev loop,
 * CI and the end-to-end tests run the engine on it too. Its official Linux binaries link libatomic (since Node 25),
 * which not every system has: the .deb depends on libatomic1 (tauri.conf.json).
 */
export const NODE_VERSION = "26.13.0";

/**
 * SHA-256 of each official archive, pinned here: the build trusts the repository, not whatever the download site
 * serves on the day. Taken from the signed nodejs.org/dist/v26.13.0/SHASUMS256.txt.asc, its signature checked on
 * 2026-11-05 against the Node.js release keys (github.com/nodejs/release-keys): signed by Richard Lau,
 * C82F A3AE 1CBE DC6B E46B 9360 C43C EC45 C17A B93C. A version bump updates these with it.
 */
export const NODE_SHA256 = {
  "node-v26.13.0-linux-x64.tar.xz": "d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997",
  "node-v26.13.0-linux-arm64.tar.xz": "406fe3fbde1c054adff8b297c16fdb5af6659db327c1ac8acd46b56ef1af9a92",
  "node-v26.13.0-darwin-arm64.tar.xz": "6f5b3187d9df9fc007e881167905bc7d69ad26450ddc377c83d63256a2495b6e",
  "node-v26.13.0-darwin-x64.tar.xz": "8bd636bc981a92e1ab930c02340eece2076eb1aaf94d14e421cdeeddc1292298",
  "node-v26.13.0-win-x64.zip": "dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a",
};
