import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";

const ENGINE = "http://127.0.0.1:4201/api/@powerhousedao/knowledge-note";
const octets = { "content-type": "application/octet-stream" };

/**
 * Plan 4, Stage A: documents convert on this computer with nothing installed —
 * the vendored docling service in no-binding mode — the engine's convert routes
 * answer the owner anonymously in open mode, and Settings › Conversion switches
 * where documents convert without an engine restart.
 */
test("conversion: ready out of the box, anonymous through the engine, switched live from Settings", async ({ page, request }) => {
  const foreign: string[] = [];
  const allowed = /^(?:https?|wss?):\/\/127\.0\.0\.1:420[0-9]\b/;
  page.on("request", (r) => {
    const u = r.url();
    if (/^(?:https?|wss?):/.test(u) && !allowed.test(u)) foreign.push(u);
  });

  await page.goto("/#/settings/conversion");
  await expect(page.getByRole("heading", { name: "Conversion" })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Ready", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^Reads PDF/)).toBeVisible();
  // The components, each with the one action that fits. The converter installs its binding on its own at start, so
  // this run may meet it before or after: either the binding to install, or installed.
  await expect(page.getByRole("button", { name: "Install binding" }).or(page.getByRole("button", { name: "Remove binding" })).first()).toBeVisible({ timeout: 60_000 });

  // The engine's own route, anonymous: open mode lets the owner through; the service is the runtime one.
  const health = (await (await request.get(`${ENGINE}/convert/health`)).json()) as Record<string, unknown>;
  expect(health).toMatchObject({ configured: true, ok: true, source: "runtime" });
  const binding = health.binding === true;

  const md = await request.post(`${ENGINE}/convert?filename=notes.md`, {
    headers: octets,
    data: Buffer.from("# Title\n\nIntro.\n\n## Part one\n\nBody one.\n\n## Part two\n\nBody two.\n"),
  });
  expect(md.status()).toBe(200);
  expect(((await md.json()) as { sections: unknown[] }).sections.length).toBeGreaterThanOrEqual(1);

  const pdfBytes = readFileSync(join(dirname(test.info().file), "fixtures", "text.pdf"));
  const pdf = await request.post(`${ENGINE}/convert?filename=text.pdf`, { headers: octets, data: pdfBytes });
  expect(pdf.status()).toBe(200);
  expect(await pdf.json()).toMatchObject({ textSource: "pdfjs", pages: 1 });

  // Without the binding, a format it cannot read names the remedy — never an empty source.
  if (!binding) {
    const docx = await request.post(`${ENGINE}/convert?filename=report.docx`, { headers: octets, data: Buffer.from("PK\u0003\u0004 not a docx") });
    expect(docx.status()).toBe(415);
    expect(await docx.json()).toMatchObject({ code: "BINDING_REQUIRED", details: { binding: false } });
  }

  // Off: the engine reports no converter at once — no restart.
  await page.getByLabel(/^Off/).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await expect
    .poll(async () => ((await (await request.get(`${ENGINE}/convert/health`)).json()) as { configured: boolean }).configured, { timeout: 15_000 })
    .toBe(false);
  await expect(page.locator(".kv-converter-head strong")).toHaveText("Off");

  // Back on this computer: a fresh helper, ready again, and the engine follows.
  await page.getByLabel(/^On this computer/).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => ((await (await request.get(`${ENGINE}/convert/health`)).json()) as { configured: boolean }).configured, { timeout: 15_000 })
    .toBe(true);

  expect(foreign, "only the loopback ports may be contacted").toEqual([]);
});
