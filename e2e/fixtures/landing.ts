import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const CONTROL = "http://127.0.0.1:4202";
export const auth = { authorization: "Bearer dev-token" };

/**
 * A fresh store opens the setup guide (a new install). Specs about the landing record it as skipped first, the way a
 * returning person has it; the guide has its own checks.
 */
export async function skipSetupGuide(request: APIRequestContext): Promise<void> {
  const saved = await request.put(`${CONTROL}/settings`, { headers: auth, data: { ui: { onboarding: "skipped" } } });
  expect(saved.ok()).toBe(true);
}

/**
 * A vault made on the landing: the first-run form, or "New vault" once vaults exist. The heading shows before the
 * vault list has loaded, so wait for one of the two before choosing.
 */
export async function createVaultOnLanding(page: Page, name: string, submit: "button" | "enter" = "button"): Promise<void> {
  const field = page.getByRole("textbox", { name: "Name", exact: true });
  const newVault = page.getByRole("button", { name: "New vault" });
  await expect(field.or(newVault).first()).toBeVisible({ timeout: 60_000 });
  if (!(await field.isVisible())) await newVault.click();
  await field.fill(name);
  if (submit === "enter") await page.keyboard.press("Enter");
  else await page.getByRole("button", { name: "Create vault" }).click();
}
