import { expect, test } from "@playwright/test";

// Self-contained: creates its own vault (first-run form, or "New vault" when vaults already exist).
test("launcher: full view inside a vault, rename from the ⋯ menu, Settings sections, Workflow Studio reachable, typed delete", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Vaults" })).toBeVisible();
  const newVault = page.getByRole("button", { name: "New vault" });
  if (await newVault.isVisible().catch(() => false)) await newVault.click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Launcher vault");
  await page.getByRole("button", { name: "Create vault" }).click();

  // Creating opens the vault. Inside, the landing's chrome is gone; the app bar is the only landmark.
  await expect(page.getByText("Notes", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Knowledge Vault" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Workflows" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "App" })).toBeVisible();
  await page.getByRole("button", { name: "← Vaults" }).click();
  await expect(page.getByRole("button", { name: "Open Launcher vault" })).toBeVisible();

  // Rename from the tile's menu.
  await page.getByRole("button", { name: "More actions for Launcher vault" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Launcher vault renamed"); // exact: getByLabel("Name") also matches the dialog titled "Rename vault"
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("button", { name: "Open Launcher vault renamed" })).toBeVisible();

  // Settings: the sections list, Vaults, Models, Diagnostics, Appearance.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  await expect(page.getByText("Launcher vault renamed")).toBeVisible();
  // Protection (spec §4.4): offered, but disabled with the reason until the user signs in.
  const protect = page.getByRole("button", { name: "Protect local vaults" });
  await expect(protect).toBeVisible();
  await expect(protect).toBeDisabled();
  await expect(page.getByText(/Sign in first/)).toBeVisible();
  await page.getByRole("button", { name: "Models" }).click();
  await expect(page.getByRole("radiogroup", { name: "AI model provider" })).toBeVisible();
  await page.getByRole("button", { name: "Diagnostics" }).click();
  await expect(page.getByText(/Ready on port 4201/)).toBeVisible();
  await expect(page.getByText("http://127.0.0.1:4201/mcp")).toBeVisible();
  await expect(page.getByText(/switchboard init --url http:\/\/127\.0\.0\.1:4201\/graphql/)).toBeVisible(); // Connect your tools names the live port
  await page.getByRole("button", { name: "Appearance" }).click();
  await expect(page.getByLabel(/^Dark/)).toBeChecked();
  await page.getByRole("button", { name: "← Vaults" }).click();

  // Workflow Studio, full view, with the runtime reachable (no "unreachable" notice).
  await page.getByRole("button", { name: "Workflows" }).click();
  await expect(page.getByText("Automations in this drive")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/runtime is unreachable/)).toHaveCount(0);
  await page.getByRole("button", { name: "← Vaults" }).click();

  // Delete needs the name typed; the tile disappears.
  await page.getByRole("button", { name: "More actions for Launcher vault renamed" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const del = page.getByRole("button", { name: "Delete vault" });
  await expect(del).toBeDisabled();
  // The dialog sits in the middle of the window, over a blurred backdrop.
  const box = (await page.locator("dialog.kv-dialog[open]").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(2);
  expect(await page.locator("dialog.kv-dialog[open]").evaluate((d) => getComputedStyle(d, "::backdrop").backdropFilter)).toContain("blur");
  await page.getByLabel("Type the vault’s name to confirm").fill("Launcher vault renamed");
  await expect(del).toBeEnabled();
  await del.click();
  await expect(page.getByRole("button", { name: "Open Launcher vault renamed" })).toHaveCount(0);
});
