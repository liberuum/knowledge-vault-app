import { expect, test, type APIRequestContext } from "@playwright/test";
import { skipSetupGuide } from "./fixtures/landing.js";

const CONTROL = "http://127.0.0.1:4202";
const ENGINE = "http://127.0.0.1:4201";
const auth = { authorization: "Bearer dev-token" };

test.setTimeout(300_000); // may wait out a workflow lease first

type DriveNode = { id: string; kind: string; name: string; parentFolder?: string | null; documentType?: string };

async function nodesOf(request: APIRequestContext, driveId: string): Promise<DriveNode[]> {
  const res = await request.post(`${ENGINE}/graphql`, {
    data: { query: `query($id: String!) { document(idOrSlug: $id) { document { state } } }`, variables: { id: driveId } },
  });
  const body = (await res.json()) as { data: { document: { document: { state: { global: { nodes: DriveNode[] } } } } } };
  return body.data.document.document.state.global.nodes;
}

async function documentExists(request: APIRequestContext, id: string): Promise<boolean> {
  const res = await request.post(`${ENGINE}/graphql`, {
    data: { query: `query($id: String!) { document(idOrSlug: $id) { document { id } } }`, variables: { id } },
  });
  const body = (await res.json()) as { data?: { document?: { document?: { id?: string } | null } | null } | null };
  return Boolean(body.data?.document?.document?.id);
}

/**
 * Workflow Studio runs inside the app on our own client adapter (host/src/remote-client-module.ts)
 * and history guard (host/src/shell/history-guard.ts), not Connect's. Since 6.2.3-dev.47 it keeps each
 * workflow in a home folder that orders the sidebar, walks back and forward through the workflows
 * visited, and deletes a workflow by deleting its home folder. Each is driven through the UI here and
 * the drive read back from the engine.
 */
test("Workflow Studio in the app: + creates in a home folder, back and forward, keyboard reorder, delete removes the workflow", async ({ page, request }) => {
  const consoleLines: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message.slice(0, 300)}`));
  // Independent of the specs before it: one may have left the app at its first run (delete-all) or the
  // engine waiting out a crashed engine's workflow lease (up to a minute, 6.2.3-dev.51).
  await skipSetupGuide(request);
  const runtimeUp = async () => {
    const res = await request.post(`${ENGINE}/graphql`, { data: { query: "{ workflowRuntime { __typename } }" } }).catch(() => null);
    return res?.ok() ?? false;
  };
  await expect.poll(runtimeUp, { timeout: 120_000, message: "the workflow runtime answers" }).toBe(true);
  const drive = ((await (await request.get(`${CONTROL}/workflows`, { headers: auth })).json()) as { drive: { id: string } }).drive;
  await page.goto("/#/workflows");
  await expect(page.getByText("Automations in this drive").or(page.getByRole("heading", { name: "Workflows", level: 2 })).first()).toBeVisible({ timeout: 60_000 });

  const workflows = async () => (await nodesOf(request, drive.id)).filter((n) => n.kind === "file" && n.documentType === "powerhouse/workflow");
  /** The sort key of a workflow's home folder, read fresh: a reorder renames or moves folders. */
  const keyOf = async (id: string) => {
    const nodes = await nodesOf(request, drive.id);
    const folder = nodes.find((n) => n.id === nodes.find((w) => w.id === id)?.parentFolder);
    return folder?.name.split(" · ")[0];
  };
  const before = (await workflows()).length;

  // "+" twice: each workflow lands in its own home folder ("<key> · <name>") and is selected in the address.
  const created: DriveNode[] = [];
  for (const n of [1, 2]) {
    await page.locator('button[aria-label="New workflow"]').click(); // the sidebar's "+" (the empty overview has a second one)
    await expect.poll(async () => (await workflows()).length, { timeout: 30_000 }).toBe(before + n);
    const id = (await workflows()).find((w) => !created.some((c) => c.id === w.id))!.id;
    // The adapter creates the document at the root, then moves it into the folder Studio made for it.
    const homeOf = async () => {
      const nodes = await nodesOf(request, drive.id);
      const node = nodes.find((w) => w.id === id);
      return { node, folder: nodes.find((x) => x.id === node?.parentFolder) };
    };
    try {
      await expect.poll(async () => (await homeOf()).folder?.kind, { timeout: 30_000, message: "a new workflow gets a home folder" }).toBe("folder");
    } catch (error) {
      console.log("DEBUG drive nodes:", JSON.stringify((await nodesOf(request, drive.id)).map((x) => ({ id: x.id.slice(0, 8), kind: x.kind, name: x.name, parent: x.parentFolder?.slice(0, 8) ?? null }))));
      console.log("DEBUG page console:", JSON.stringify(consoleLines.slice(-15)));
      throw error;
    }
    const { node: latest, folder: home } = await homeOf();
    created.push(latest!);
    expect(home!.name).toContain(` · ${latest!.name}`);
    await expect(page).toHaveURL(new RegExp(`#${latest!.id}$`));
  }
  const [first, second] = created as [DriveNode, DriveNode];

  // Back and forward walk the workflows visited, without leaving Studio, and the open editor follows
  // (reactor-browser would read both from Connect's path, which the app keeps at "/": history-guard.ts).
  const openEditor = () => page.evaluate(() => (window as unknown as { ph?: { selectedNodeId?: string } }).ph?.selectedNodeId);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#${first.id}$`));
  await expect(page.locator('button[aria-label="New workflow"]')).toBeVisible(); // still in Studio
  await expect.poll(openEditor).toBe(first.id);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#${second.id}$`));
  await expect.poll(openEditor).toBe(second.id);

  // Alt+ArrowUp on the second row moves it above the first: its home folder now sorts first.
  expect((await keyOf(second.id))! > (await keyOf(first.id))!).toBe(true);
  await page.getByRole("button", { name: new RegExp(`^${second.name}`) }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(async () => (await keyOf(second.id))! < (await keyOf(first.id))!, { timeout: 30_000 }).toBe(true);

  // Delete the first, confirming by its name: the document goes with its home folder, so it cannot keep firing.
  const firstHome = (await nodesOf(request, drive.id)).find((n) => n.id === first.parentFolder)?.id;
  await page.getByRole("button", { name: `More actions for ${first.name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("textbox", { name: `Type ${first.name} to confirm` }).fill(first.name);
  await dialog.getByRole("button", { name: "Delete workflow" }).click();
  await expect.poll(async () => documentExists(request, first.id), { timeout: 30_000 }).toBe(false);
  const after = await nodesOf(request, drive.id);
  expect(after.some((n) => n.id === first.id || n.id === firstHome), "neither the workflow nor its home folder stays in the drive").toBe(false);
  expect(after.some((n) => n.id === second.id), "the other workflow is untouched").toBe(true);
});
