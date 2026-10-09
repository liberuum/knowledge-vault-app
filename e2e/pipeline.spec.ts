import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

const CONTROL = "http://127.0.0.1:4202";
const ENGINE = "http://127.0.0.1:4201";
const auth = { authorization: "Bearer dev-token" };

/**
 * Plan 2: the pipeline's plumbing without a real model. A fake OpenAI-compatible
 * server on loopback lists one model and fails every completion; Validate
 * reports the listing; a vault created in the UI comes up with its pipeline
 * ready (the shipped template instantiated by the engine); a source queued
 * through the vault's REST makes the trigger fire; the runtime records the run
 * as FAILED because the model answered 500; and the chip says so, leading to
 * the runs in Workflow Studio. Honest: nothing emulates a model's output.
 */
test("pipeline: template instantiated per vault, a queued source runs, a failed run is surfaced", async ({ page, request }) => {
  test.setTimeout(330_000);
  const completions: string[] = [];
  const fake: Server = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      return;
    }
    if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
      completions.push(req.headers.authorization ?? "");
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "no model here" } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const port = (fake.address() as { port: number }).port;
  try {
    // Settings › Models, saved through the control API as the page would, then validated in the UI.
    const saved = await request.put(`${CONTROL}/settings`, { headers: auth, data: { models: { endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: "fake-model", apiKey: "sk-test-not-real" } } });
    expect(saved.ok()).toBe(true);
    expect((await saved.json()).models.endpoint).toBe(`http://127.0.0.1:${port}/v1`); // a pasted completions URL is normalised to the API root
    await page.goto("/#/settings/models");
    await expect(page.getByRole("radiogroup", { name: "AI model provider" })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Validate" }).click();
    await expect(page.getByText("1 models available")).toBeVisible({ timeout: 30_000 });

    // A vault created now gets its pipeline: the chip in its app bar says processing is ready.
    await page.goto("/#/");
    await expect(page.getByRole("heading", { name: "Vaults" })).toBeVisible();
    // Either the first-run form is already there or the list has loaded and "New vault" opens it.
    const newVault = page.getByRole("button", { name: "New vault" });
    const nameBox = page.getByRole("textbox", { name: "Name", exact: true });
    await newVault.or(nameBox).first().waitFor({ timeout: 60_000 });
    if (await newVault.isVisible().catch(() => false)) await newVault.click();
    await nameBox.fill("Pipeline vault", { timeout: 30_000 });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "← Vaults" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Processing ready")).toBeVisible({ timeout: 60_000 });
    const vaults = (await (await request.get(`${CONTROL}/vaults`, { headers: auth })).json()).vaults as Array<{ id: string; name: string }>;
    const vault = vaults.find((v) => v.name === "Pipeline vault");
    expect(vault).toBeTruthy();
    const pipeline = await (await request.get(`${CONTROL}/vaults/${vault!.id}/pipeline`, { headers: auth })).json();
    expect(pipeline.pipeline.state).toBe("ready");
    expect(pipeline.pipeline.trigger?.status).toBe("ENABLED");

    // Queue a source through the vault's own REST surface (open mode: the anonymous caller is the owner).
    // The vault app scaffolds the drive's folders on first open; until /sources exists the engine refuses, so retry briefly.
    const source = { drive: vault!.id, title: "Notes on a small experiment", sourceType: "ARTICLE", content: "The experiment measured how long a queued source takes to be picked up by the pipeline. It was picked up within a minute, and the extraction step called the model." };
    let queued = await request.post(`${ENGINE}/api/@powerhousedao/knowledge-note/sources`, { headers: { "content-type": "application/json" }, data: source });
    for (let attempt = 0; attempt < 30 && queued.status() === 400 && (await queued.text()).includes("FOLDER_UNRESOLVED"); attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      queued = await request.post(`${ENGINE}/api/@powerhousedao/knowledge-note/sources`, { headers: { "content-type": "application/json" }, data: source });
    }
    expect(queued.status(), await queued.text()).toBeLessThan(300);

    // The trigger polls the queue; the run reaches the model, which fails; the runtime records FAILED.
    const deadline = Date.now() + 240_000;
    let lastRun: { status: string; error: string | null } | undefined;
    while (Date.now() < deadline) {
      const p = (await (await request.get(`${CONTROL}/vaults/${vault!.id}/pipeline`, { headers: auth })).json()).pipeline;
      lastRun = p.lastRun;
      if (lastRun && lastRun.status !== "RUNNING") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(lastRun, "the trigger fired and a run was recorded").toBeTruthy();
    expect(lastRun!.status).toBe("FAILED");
    expect(completions.length, "the piece reached the model through the connection").toBeGreaterThan(0);
    expect(completions[0]).toBe("Bearer sk-test-not-real"); // the model key travelled as a runtime secret, not through the UI

    // The chip surfaces it, and leads to the runs.
    await page.goto(`/#/vault/${encodeURIComponent(vault!.id)}`);
    await expect(page.getByText("Last processing run failed")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "See runs" }).click();
    // "See runs" leads to Workflow Studio on the Workflows drive, where this vault's workflow is listed by name.
    try {
      await expect(page).toHaveURL(/#\/workflows/, { timeout: 10_000 });
      await expect(page.getByText("Pipeline vault — Vault pipeline").first()).toBeVisible({ timeout: 90_000 });
    } catch (error) {
      const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 700);
      throw new Error(`${String(error).split("\n")[0]}\n  url: ${page.url()}\n  page: ${text}`);
    }
  } finally {
    await request.put(`${CONTROL}/settings`, { headers: auth, data: { models: { apiKey: "" } } }).catch(() => undefined);
    await new Promise<void>((r) => fake.close(() => r()));
  }
});
