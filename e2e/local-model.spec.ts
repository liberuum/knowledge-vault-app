import { expect, test } from "@playwright/test";

// Settings › Models › Use a local model: an address that fails to connect must not be lost
// when the user leaves the page and comes back, or reloads the app.
test("the local model address the user typed survives a failed connect, leaving and a reload", async ({ page }) => {
  const typed = "http://127.0.0.1:59999/v1"; // nothing listens there
  // "Use a local model…" is in the On this computer card; a fresh app starts on OpenRouter's.
  const useLocal = async () => {
    await page.getByRole("radio", { name: /On this computer/ }).click();
    await page.getByRole("button", { name: "Use a local model…" }).click();
  };
  await page.goto("/#/settings/models");
  await useLocal();
  const field = page.getByLabel("Local server address");
  await expect(field).toHaveValue("http://127.0.0.1:8080/v1");
  await field.fill(typed);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText(/Could not connect/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Cancel" }).click();

  // Leave for another section and come back.
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("button", { name: "Models" }).click();
  await useLocal();
  await expect(page.getByLabel("Local server address")).toHaveValue(typed);

  // A full reload too.
  await page.reload();
  await useLocal();
  await expect(page.getByLabel("Local server address")).toHaveValue(typed);
});
