import { expect, test } from "@playwright/test";

/**
 * Plan 5: the engine stops under a running app and comes back; a backup and the delete-all
 * run at the engine's next start. Runs last (alphabetically after `pipeline`): it ends by
 * deleting every local vault. Needs KV_DEBUG_ROUTES=1 (playwright.config.ts) for /debug/crash.
 */
const CONTROL = "http://127.0.0.1:4202";
const auth = { authorization: "Bearer dev-token" };

test.setTimeout(300_000);

test("resilience: a crash is survived, a backup is made, and delete-all returns the app to its first run", async ({ page, request }) => {
  // A vault to work in.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Vaults" })).toBeVisible();
  // Earlier specs leave vaults behind: wait for the list (the "New vault" button) or the first-run form, whichever comes.
  const newVault = page.getByRole("button", { name: "New vault" });
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(newVault.or(name).first()).toBeVisible({ timeout: 60_000 });
  if (await newVault.isVisible()) await newVault.click();
  await name.fill("Resilience vault");
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByText("Notes", { exact: true }).first()).toBeVisible({ timeout: 60_000 });

  // (a) The engine crashes: the banner says the app is reconnecting, the dev loop's supervisor
  // brings the engine back after 1 s, and the banner clears with the vault still open.
  const crash = await request.post(`${CONTROL}/debug/crash`, { headers: auth });
  expect(crash.status()).toBe(202);
  await expect(page.getByText(/Reconnecting…/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Reconnecting…/)).toHaveCount(0, { timeout: 90_000 });
  await expect(page.getByText("Notes", { exact: true }).first()).toBeVisible();

  // (b) Back up now: the engine restarts, makes the backup before it opens the store, and the list shows it.
  await page.getByRole("button", { name: "← Vaults" }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText(/Restarting the engine… the backup runs/)).toBeVisible();
  const backups = page.getByRole("list", { name: "Backups" });
  await expect(backups.getByText(/^\d{4}-\d{2}-\d{2}T.*-6\.2\.3/)).toBeVisible({ timeout: 120_000 });

  // (c) Delete all local data, keeping the backups: the app reloads into its first run, the setup guide.
  const del = page.getByRole("button", { name: "Delete all local data" });
  await expect(del).toBeDisabled();
  await page.getByLabel("Type delete to confirm").fill("delete");
  await del.click();
  await expect(page.getByRole("heading", { name: "Turn your documents into connected notes" })).toBeVisible({ timeout: 120_000 });
  const after = await (await request.get(`${CONTROL}/backups`, { headers: auth })).json();
  expect(after.backups.length).toBeGreaterThan(0);
  expect(after.lastAction).toMatchObject({ action: "delete-all", ok: true });
});
