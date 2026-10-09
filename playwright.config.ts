import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  // One worker, in file order: the specs share one engine and one store (open-vault creates the vault launcher.spec uses).
  workers: 1,
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:4200", headless: true },
  // Its own store: --fresh wipes .e2e-data, never the developer's .dev-data. KV_DEBUG_ROUTES opens /debug/crash (resilience.spec).
  webServer: { command: "KV_DEBUG_ROUTES=1 KV_CONVERTER_AUTO_INSTALL=0 node scripts/dev.mjs --no-shell --fresh --data-dir .e2e-data", url: "http://127.0.0.1:4200", timeout: 180_000, reuseExistingServer: false },
});
