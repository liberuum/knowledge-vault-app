import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

// The vault chat answers through the app's one model (the engine's gateway), with no connect form of its own.
const CONTROL = "http://127.0.0.1:4202";
const auth = { authorization: "Bearer dev-token" };
let fake: Server;
const seen: Array<{ path: string; priority: string | undefined }> = [];

test.beforeAll(async () => {
  // A model server on this computer: lists one model and streams one answer.
  fake = createServer((req, res) => {
    seen.push({ path: req.url ?? "", priority: req.headers["x-kv-priority"] as string | undefined });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fake-model" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"Hello from the gateway"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
});
test.afterAll(async () => new Promise<void>((resolve) => fake.close(() => resolve())));

test("the vault chat answers through the app's model, with no connect form", async ({ page, request }) => {
  const port = (fake.address() as AddressInfo).port;
  const saved = await request.put(`${CONTROL}/settings`, { headers: auth, data: { models: { endpoint: `http://127.0.0.1:${port}/v1`, model: "fake-model" } } });
  expect(saved.ok()).toBe(true);
  const direct = await request.get(`${CONTROL}/llm/v1/models`, { headers: auth });
  expect(await direct.json()).toMatchObject({ data: [{ id: "fake-model" }] });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Vaults" })).toBeVisible();
  const newVault = page.getByRole("button", { name: "New vault" });
  if (await newVault.isVisible().catch(() => false)) await newVault.click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Gateway vault");
  await page.getByRole("button", { name: "Create vault" }).click();

  await page.getByRole("button", { name: "Chat" }).first().click({ timeout: 60_000 });
  await expect(page.getByText("fake-model on this computer")).toBeVisible();
  await expect(page.getByText("Connect with OpenRouter")).toHaveCount(0);
  await page.getByPlaceholder("Ask Gateway vault anything").fill("Hi");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Hello from the gateway")).toBeVisible({ timeout: 30_000 });
  // The gateway forwards to the model server and never passes on its own queue header.
  expect(seen.some((s) => s.path === "/v1/chat/completions" && s.priority === undefined)).toBe(true);
});
