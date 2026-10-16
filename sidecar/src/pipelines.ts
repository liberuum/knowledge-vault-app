import type { EngineToken } from "./connections.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteDocument, execute, gql, toActions } from "./reactor-gql.js";
import { SettingsError, type AppSettings } from "./settings.js";
import { createPipelineConnection, fillPipeline, fillWorkflow, instantiatePipeline, instantiateWorkflow, replaceWorkflowInPlace, type PipelineTemplate, type TemplateOp, type WorkflowTemplate } from "./templates.js";
import { classifyRunError, type RunProblem } from "./run-problems.js";

/**
 * Spec §4.5: every local vault gets the pipeline — the shipped template
 * instantiated with this vault's drive, the engine's origin, the user's model
 * settings and two workflow-runtime secrets: the bearer the piece calls the
 * vault with, and the model key. The records live in `<dataDir>/pipelines.json`;
 * the secrets live only in the runtime's store.
 */
export type PipelineRecord = {
  workflowId: string;
  connectionId: string;
  secretRefs: { token: string; llm: string };
  createdAt: string;
  /** The model settings the pipeline was set up with; a change in Settings makes it stale. */
  models: { endpoint: string; model: string };
  /** The bearer the piece calls the vault with: minted for a signed-in user, or the "open" placeholder an open engine never reads. */
  token: { kind: "open" | "minted"; expiresAt: string | null };
  /** Set when the pipeline was disabled (the model key was removed); the reason is what the chip says. */
  disabled?: string;
  /** The steps leave their model empty and the connection's default applies: a model change is a config write. Older records baked the model into the steps. */
  modelFromConnection?: boolean;
  /** Which template the pipeline was made from: an installed package with a newer one makes it stale (Update sets it up again). */
  templateDigest?: string;
  /** The connection's key is the model gateway's: the pipeline reaches its model through the engine's gateway. */
  gatewayKeyed?: true;
  /** The vault's Reweave notes workflow, on this pipeline's connection, and the template digest it was made from. */
  reweave?: { workflowId: string; digest: string };
};
export type PipelineStatus =
  | { state: "unconfigured" }
  | { state: "missing" }
  /** The workflow runtime is not up yet: after an unclean exit the engine waits out the previous one's lease (up to a minute). */
  | { state: "starting" }
  | { state: "stale"; reason: string; workflowId: string; connectionId: string }
  | {
      state: "ready";
      workflowId: string;
      connectionId: string;
      trigger?: { status: string; lastPollAt: string | null; lastError: string | null };
      lastRun?: { id: string; status: string; startedAt: string | null; endedAt: string | null; error: string | null; /** What the error means, when the engine can tell (run-problems.ts). */ problem?: RunProblem };
    };
export type EnsureResult = { state: "unconfigured" } | { state: "ready"; workflowId: string; connectionId: string };

const file = (dataDir: string) => join(dataDir, "pipelines.json");

export function readPipelines(dataDir: string): Record<string, PipelineRecord> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(dataDir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, PipelineRecord>) : {};
  } catch {
    return {};
  }
}
export function writePipelines(dataDir: string, records: Record<string, PipelineRecord>): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${file(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n");
  renameSync(tmp, file(dataDir));
}

export type PipelineManagerDeps = {
  dataDir: string;
  origin: string;
  fetchImpl: typeof fetch;
  /** The template the installed vault package ships; absent when the package predates it. */
  template: PipelineTemplate | undefined;
  /** The Reweave notes workflow the installed vault package ships (reweave.json); absent when the package predates it. */
  reweaveTemplate?: WorkflowTemplate;
  instantiateReweave?: typeof instantiateWorkflow;
  pieceVersion: string;
  readSettings: () => AppSettings;
  readModelKey: () => string | undefined;
  identity: { status: () => Promise<{ authenticated: boolean }>; token: (expiresIn: number) => Promise<{ token: string }> };
  workflowsDrive: () => Promise<{ id: string }>;
  vaultName: (vaultId: string) => Promise<string>;
  /** The engine's model gateway: this launch's URL (the control port moves) and the persistent key. */
  gateway: { url: () => string; key: string };
  /** A protected engine answers only authenticated callers: its pipeline must run as the signed-in user. */
  engineProtected?: boolean;
  instantiate?: typeof instantiatePipeline;
  now?: () => string;
};

/** The bearer the piece uses lasts long enough to be forgotten about; an Update mints a new one. */
/** What a local model server is sent as its "key": llama.cpp, Ollama and LM Studio ignore it. */
export const LOCAL_PLACEHOLDER_KEY = "local";
/** The runtime's per-trigger poll interval, kept in the trigger's config (it never reaches the piece). */
const POLL_KEY = "pollEverySeconds";
type TriggerInput = { config?: Record<string, unknown> } & Record<string, unknown>;
const withoutPollInterval = (op: { type: string; input: unknown }) => {
  const input = op.input as TriggerInput;
  if (op.type !== "SET_TRIGGER" || !input?.config || !(POLL_KEY in input.config)) return op;
  const { [POLL_KEY]: _dropped, ...config } = input.config;
  return { ...op, input: { ...input, config } };
};

/**
 * A short fingerprint of a pipeline template: what a recorded pipeline was made from. The run policy
 * (SET_POLICY) and the trigger's poll interval are left out: start-up keeps both current on every
 * pipeline in place (followTemplate), so a change to them alone never asks the user to set the
 * pipeline up again. A template with neither hashes exactly as before.
 */
export function templateDigest(template: PipelineTemplate | undefined): string | undefined {
  if (!template) return undefined;
  const operations = template.workflow.operations.filter((o) => o.type !== "SET_POLICY").map(withoutPollInterval);
  const hashed = { ...template, workflow: { ...template.workflow, operations } };
  return createHash("sha256").update(JSON.stringify(hashed)).digest("hex").slice(0, 16);
}

/** The run policy the template publishes with (its SET_POLICY): undefined for a template from before 6.2.3-dev.50. */
export function templatePolicy(template: PipelineTemplate | undefined): Record<string, unknown> | undefined {
  const op = template?.workflow.operations.find((o) => o.type === "SET_POLICY");
  return op && typeof op.input === "object" && op.input !== null ? (op.input as Record<string, unknown>) : undefined;
}

/** How often the template's trigger checks the queue (its last SET_TRIGGER's pollEverySeconds), if it says. */
export function templatePollSeconds(template: PipelineTemplate | undefined): number | undefined {
  const op = template?.workflow.operations.filter((o) => o.type === "SET_TRIGGER").at(-1);
  const value = (op?.input as TriggerInput | undefined)?.config?.[POLL_KEY];
  return typeof value === "number" && value > 0 ? value : undefined;
}

/** A short fingerprint of the Reweave notes template: a recorded workflow made from another is made again. */
export function workflowDigest(template: WorkflowTemplate): string {
  return createHash("sha256").update(JSON.stringify(template)).digest("hex").slice(0, 16);
}

/** The engine answered without its workflow runtime: it boots without one while another holder's lease runs out. */
export const runtimeMissing = (error: unknown) => /Cannot query field "workflowRuntime"/.test(error instanceof Error ? error.message : String(error));

const ENGINE_TOKEN_SECONDS = 90 * 86_400;
/** A token this close to its end reads as stale, so the user updates before runs start failing. */
const TOKEN_RENEW_BEFORE_MS = 7 * 86_400_000;

/**
 * Signed in: a long-lived bearer minted by the identity. Open engine, nobody signed in: the
 * placeholder "open" — the engine never reads it. A protected engine with nobody signed in
 * has no bearer to give: refused (whatever uses it would run as nobody).
 * Shared by the vault pipelines and Studio's Knowledge Vault connections.
 */
export async function mintEngineToken(
  identity: PipelineManagerDeps["identity"],
  engineProtected: boolean,
  now: () => string = () => new Date().toISOString(),
): Promise<EngineToken> {
  try {
    if ((await identity.status()).authenticated) {
      const minted = await identity.token(ENGINE_TOKEN_SECONDS);
      return { value: minted.token, kind: "minted", expiresAt: new Date(Date.parse(now()) + ENGINE_TOKEN_SECONDS * 1000).toISOString() };
    }
  } catch {
    // expired or unavailable: treated as signed out
  }
  if (engineProtected) throw new SettingsError("Sign in first — on a protected engine this runs as you.");
  return { value: "open", kind: "open", expiresAt: null };
}

/** The engine's answer for a document that is gone (deleted in Studio), as opposed to one it could not read just now. Only its own document messages count: "Document model not found" is an engine still loading models. */
const GONE = /\bDocument not found(?::| with slug:)|\bDocument (?!model\b)\S+ (?:not found|was deleted at|has been deleted)\b/i;
export function documentGone(error: unknown): boolean {
  return GONE.test(error instanceof Error ? error.message : String(error));
}

export function createPipelineManager(deps: PipelineManagerDeps) {
  const f = deps.fetchImpl;
  const now = () => (deps.now ?? (() => new Date().toISOString()))(); // read each time: tests move the clock
  const instantiate = deps.instantiate ?? instantiatePipeline;
  const instantiateReweave = deps.instantiateReweave ?? instantiateWorkflow;

  async function createSecret(value: string, label: string): Promise<string> {
    const data = await gql<{ workflowRuntime: { createSecret: { ref: string } } }>(
      deps.origin,
      `mutation($v: String!, $l: String) { workflowRuntime { createSecret(value: $v, label: $l) { ref } } }`,
      { v: value, l: label },
      f,
    ).catch((error: unknown) => {
      throw runtimeMissing(error) ? new Error("Processing is still starting up. Try again in a minute.") : error;
    });
    return data.workflowRuntime.createSecret.ref;
  }
  const deleteSecret = (ref: string) => gql(deps.origin, `mutation($ref: String!) { workflowRuntime { deleteSecret(ref: $ref) } }`, { ref }, f).catch(() => undefined);
  async function discard(record: PipelineRecord): Promise<void> {
    for (const id of [...(record.reweave ? [record.reweave.workflowId] : []), record.workflowId, record.connectionId]) await deleteDocument(deps.origin, id, f).catch(() => undefined);
    for (const ref of [record.secretRefs.token, record.secretRefs.llm]) await deleteSecret(ref);
  }
  const engineToken = () => mintEngineToken(deps.identity, deps.engineProtected === true, now);
  // A model on this computer needs no key; its connection gets a placeholder the server ignores.
  const modelsConfigured = (settings: AppSettings) => (settings.models.hasKey || settings.models.local) && settings.models.model.trim().length > 0;
  const keyFor = (settings: AppSettings) => (settings.models.local ? LOCAL_PLACEHOLDER_KEY : deps.readModelKey());
  /** What a pipeline's connection says about its model: this launch's gateway, the model, and where it runs. */
  const modelConfig = (settings: AppSettings) => ({ llm_base_url: deps.gateway.url(), llm_default_model: settings.models.model, llm_locality: settings.models.local ? "local" : "hosted" });

  /** Why a recorded pipeline no longer fits: disabled, other model settings, an "open" bearer on a protected engine, a token near its end. */
  function staleReason(record: PipelineRecord, settings: AppSettings): string | undefined {
    if (record.disabled) return record.disabled;
    // Records written before these fields existed carry neither; they are judged on what they have.
    if (record.models && (record.models.endpoint !== settings.models.endpoint || record.models.model !== settings.models.model)) return "the model settings changed";
    if (deps.engineProtected && record.token?.kind === "open") return "the engine is now protected; the pipeline was set up while it was open";
    // The installed package ships a newer pipeline (longer limits, new steps): Update sets this one up again.
    const digest = templateDigest(deps.template);
    if (digest && record.templateDigest !== digest) return "a newer version of the pipeline is available";
    if (record.token?.expiresAt) {
      const left = Date.parse(record.token.expiresAt) - Date.parse(now());
      if (left <= 0) return "the engine token expired";
      if (left < TOKEN_RENEW_BEFORE_MS) return "the engine token expires soon";
    }
    return undefined;
  }

  /** Change one vault's record as it is on disk now (another step may have written it meanwhile); a vault without one is left alone. */
  function save(vaultId: string, change: (record: PipelineRecord) => PipelineRecord): void {
    const records = readPipelines(deps.dataDir);
    const current = records[vaultId];
    if (!current) return;
    records[vaultId] = change(current);
    writePipelines(deps.dataDir, records);
  }

  /**
   * A document's global state, or null when it no longer exists (deleted in Studio). Any other failure to read it
   * throws, so an engine that did not answer never reads as a deleted document. Update decides between "in place" and
   * "make it again" on this answer, and a wrong "gone" would throw the runs away.
   */
  async function globalState(id: string): Promise<{ status?: string } | null> {
    try {
      const data = await gql<{ document: { document: { state: { global: { status?: string } } } | null } | null }>(
        deps.origin,
        `query($id: String!) { document(idOrSlug: $id) { document { state } } }`,
        { id },
        f,
      );
      return data.document?.document?.state.global ?? null;
    } catch (error) {
      if (documentGone(error)) return null;
      throw error;
    }
  }

  /** A workflow's status, or null when it no longer exists (deleted in Studio). */
  async function workflowStatus(workflowId: string): Promise<string | null> {
    const global = await globalState(workflowId);
    return global ? (global.status ?? "UNKNOWN") : null;
  }

  /**
   * The vault's Reweave notes workflow, on its pipeline's connection. It is made when the record has none (a vault set
   * up before it existed, or an earlier try failed). From a newer template it is brought up to date in place, keeping
   * its id and its runs.
   *
   * `force` (an Update) brings it to the template even when its digest is current, because the connection may be new,
   * and makes it again when it was deleted in Studio. Without `force`, one deleted in Studio stays deleted. One switched
   * off in Studio stays off, unless `enable`: the app had switched it off. Never throws, because the pipeline works
   * without it.
   */
  async function ensureReweave(vaultId: string, opts: { force?: boolean; enable?: boolean } = {}): Promise<"created" | "updated" | "current" | "skipped" | "failed"> {
    const template = deps.reweaveTemplate;
    const record = readPipelines(deps.dataDir)[vaultId];
    if (!template || !record || record.disabled) return "skipped";
    const digest = workflowDigest(template);
    const name = async () => `${await deps.vaultName(vaultId)} — Reweave notes`;
    try {
      if (record.reweave) {
        if (record.reweave.digest === digest && !opts.force) return "current";
        const workflowId = record.reweave.workflowId;
        const status = await workflowStatus(workflowId);
        if (status !== null) {
          const operations = fillWorkflow({ template, name: await name(), driveId: vaultId, connectionId: record.connectionId, pieceVersion: deps.pieceVersion, now });
          const off = status === "DISABLED" && !opts.enable;
          await replaceWorkflowInPlace({ origin: deps.origin, workflowId, operations, status: off ? "DISABLED" : "ENABLED", now, fetchImpl: f });
          save(vaultId, (r) => ({ ...r, reweave: { workflowId, digest } }));
          return "updated";
        }
        if (!opts.force) {
          save(vaultId, (r) => ({ ...r, reweave: { workflowId, digest } }));
          return "skipped";
        }
        save(vaultId, ({ reweave: _gone, ...r }) => r);
      }
      const { id: workflowsDriveId } = await deps.workflowsDrive();
      const { workflowId } = await instantiateReweave({ origin: deps.origin, template, name: await name(), driveId: vaultId, connectionId: record.connectionId, workflowsDriveId, pieceVersion: deps.pieceVersion, now, fetchImpl: f });
      if (readPipelines(deps.dataDir)[vaultId]?.connectionId !== record.connectionId) {
        // The pipeline was set up again, or removed, meanwhile: this workflow belongs to nothing.
        await deleteDocument(deps.origin, workflowId, f).catch(() => undefined);
        return "skipped";
      }
      save(vaultId, (r) => ({ ...r, reweave: { workflowId, digest } }));
      return "created";
    } catch (error) {
      console.warn(`[pipelines] could not set up the Reweave notes workflow of vault ${vaultId}: ${error instanceof Error ? error.message : String(error)}`);
      return "failed";
    }
  }

  /**
   * Set up this vault's pipeline, or Update it. A pipeline whose workflow still exists is brought to the template in
   * place (updateInPlace): the workflow, its id and its runs stay. Without a record, or when the workflow was deleted
   * in Studio, it is created. Nothing happens without a model key and a model.
   */
  async function ensure(vaultId: string): Promise<EnsureResult> {
    const settings = deps.readSettings();
    const key = keyFor(settings);
    if (!modelsConfigured(settings) || !key) return { state: "unconfigured" };
    const template = deps.template;
    if (!template) throw new Error("The installed vault package ships no pipeline template (pieces/knowledge-vault/templates/pipeline.json).");
    const token = await engineToken(); // before anything is created: a refusal costs nothing
    const records = readPipelines(deps.dataDir);
    const previous = records[vaultId];
    if (previous && (await workflowStatus(previous.workflowId)) !== null) return updateInPlace(vaultId, previous, template, settings, token);
    if (previous) {
      // The workflow was deleted in Studio: what is left of the pipeline goes, and it is made anew.
      // The record goes first: a failure from here on reads "missing", never "ready" for a pipeline that no longer exists.
      delete records[vaultId];
      writePipelines(deps.dataDir, records);
      await discard(previous);
    }
    const name = await deps.vaultName(vaultId);
    const { id: workflowsDriveId } = await deps.workflowsDrive();
    const tokenRef = await createSecret(token.value, `${name} — engine token`);
    const llmRef = await createSecret(deps.gateway.key, `${name} — model gateway key`);
    let made: { workflowId: string; connectionId: string } | undefined;
    try {
      made = await instantiate({
        origin: deps.origin,
        template,
        vaultName: name,
        driveId: vaultId,
        workflowsDriveId,
        secretRefs: { token: tokenRef, llm: llmRef },
        llm: { baseUrl: deps.gateway.url(), model: settings.models.model },
        pieceVersion: deps.pieceVersion,
        now,
        fetchImpl: f,
      });
      const { workflowId, connectionId } = made;
      await updateConnectionModels(connectionId, settings);
      writePipelines(deps.dataDir, {
        ...readPipelines(deps.dataDir),
        [vaultId]: {
          workflowId,
          connectionId,
          secretRefs: { token: tokenRef, llm: llmRef },
          createdAt: now(),
          models: { endpoint: settings.models.endpoint, model: settings.models.model },
          token: { kind: token.kind, expiresAt: token.expiresAt },
          modelFromConnection: true,
          templateDigest: templateDigest(template),
          gatewayKeyed: true,
        },
      });
      await ensureReweave(vaultId);
      return { state: "ready", workflowId, connectionId };
    } catch (error) {
      // A failed instantiatePipeline removed its own documents. Once it has returned they are ours: the
      // config write or the record can still fail, and nothing would ever point at them again.
      if (made) for (const id of [made.workflowId, made.connectionId]) await deleteDocument(deps.origin, id, f).catch(() => undefined);
      // The two secrets are ours to remove either way.
      await deleteSecret(tokenRef);
      await deleteSecret(llmRef);
      throw error;
    }
  }

  /**
   * Update in place (spec §2): the pipeline keeps its workflow, the workflow's id, its runs and its place in the
   * Workflows drive. In order:
   *  1. two new secrets;
   *  2. the connection kept, or made from the template when it was deleted in Studio;
   *  3. the workflow brought to the template and published (replaceWorkflowInPlace, which rolls back to the last
   *     publish on a rejection);
   *  4. the template replayed onto the kept connection, with the new secret refs and the model settings, in one write;
   *  5. the record;
   *  6. the old secrets;
   *  7. the Reweave notes workflow.
   * A failure leaves the record as it was, so the chip still offers Update. Processing runs on the published workflow
   * throughout.
   */
  async function updateInPlace(vaultId: string, previous: PipelineRecord, template: PipelineTemplate, settings: AppSettings, token: EngineToken): Promise<EnsureResult> {
    const name = await deps.vaultName(vaultId);
    const made: string[] = []; // the secrets made for this Update, until the record holds them
    let connectionId = previous.connectionId;
    let newConnection: string | undefined;
    let restoreRefs: TemplateOp[] | undefined; // set once the kept connection may name the new secrets
    try {
      const tokenRef = await createSecret(token.value, `${name} — engine token`);
      made.push(tokenRef);
      const llmRef = await createSecret(deps.gateway.key, `${name} — model gateway key`);
      made.push(llmRef);
      const fill = { origin: deps.origin, template, vaultName: name, driveId: vaultId, secretRefs: { token: tokenRef, llm: llmRef }, llm: { baseUrl: deps.gateway.url(), model: settings.models.model }, pieceVersion: deps.pieceVersion, now, fetchImpl: f };
      if ((await globalState(connectionId)) === null) {
        const { id: workflowsDriveId } = await deps.workflowsDrive();
        newConnection = await createPipelineConnection({ ...fill, workflowsDriveId });
        connectionId = newConnection;
      }
      const filled = fillPipeline(fill, connectionId);
      await replaceWorkflowInPlace({ origin: deps.origin, workflowId: previous.workflowId, operations: filled.workflow, status: "ENABLED", now, fetchImpl: f });
      if (newConnection) {
        await updateConnectionModels(newConnection, settings);
      } else {
        restoreRefs = fillPipeline({ ...fill, secretRefs: previous.secretRefs }, connectionId).connection.filter((o) => o.type === "SET_SECRET_REF");
        const ops = filled.connection.map((o) => (o.type === "SET_CONFIG" ? { type: o.type, input: { config: { ...((o.input as { config?: Record<string, unknown> }).config ?? {}), ...modelConfig(settings) } } } : o));
        await execute(deps.origin, connectionId, toActions(ops, now), f);
      }
      // This record now, re-read: what another step wrote meanwhile (the Reweave notes workflow) is kept.
      const { disabled: _wasDisabled, ...kept } = readPipelines(deps.dataDir)[vaultId] ?? previous;
      writePipelines(deps.dataDir, {
        ...readPipelines(deps.dataDir),
        [vaultId]: {
          ...kept,
          workflowId: previous.workflowId,
          connectionId,
          secretRefs: { token: tokenRef, llm: llmRef },
          models: { endpoint: settings.models.endpoint, model: settings.models.model },
          token: { kind: token.kind, expiresAt: token.expiresAt },
          modelFromConnection: true,
          templateDigest: templateDigest(template),
          gatewayKeyed: true,
        },
      });
    } catch (error) {
      if (newConnection) await deleteDocument(deps.origin, newConnection, f).catch(() => undefined);
      // The connection's write may have landed in part: it is pointed back at the record's secrets before the new ones go.
      const restored = !restoreRefs || (await execute(deps.origin, connectionId, toActions(restoreRefs, now), f).then(() => true, () => false));
      if (restored) for (const ref of made) await deleteSecret(ref);
      else console.warn(`[pipelines] the connection of vault ${vaultId} may still name the secrets made for this Update; they are kept`);
      throw error;
    }
    for (const ref of [previous.secretRefs.token, previous.secretRefs.llm]) await deleteSecret(ref);
    // Switched off by the app (the record was disabled): switched on again, as setting it up again did.
    await ensureReweave(vaultId, { force: true, enable: previous.disabled !== undefined });
    return { state: "ready", workflowId: previous.workflowId, connectionId };
  }

  /** Point a connection at the model settings: the config is rewritten whole, the other keys kept. */
  async function updateConnectionModels(connectionId: string, settings: AppSettings, llmSecretRef?: string): Promise<void> {
    const data = await gql<{ document: { document: { state: { global: { config?: Record<string, unknown> } } } } }>(
      deps.origin,
      `query($id: String!) { document(idOrSlug: $id) { document { state } } }`,
      { id: connectionId },
      f,
    );
    const config = data.document.document.state.global.config ?? {};
    await execute(
      deps.origin,
      connectionId,
      toActions([{
        type: "SET_CONFIG",
        input: {
          config: {
            ...config,
            ...modelConfig(settings),
            ...(llmSecretRef ? { llm_api_key: llmSecretRef } : {}),
          },
        },
      }], now),
      f,
    );
  }

  return {
    ensure,

    /**
     * At start: every pipeline's connection points at this launch's gateway, older ones get the gateway key.
     * Each pipeline on its own: one that cannot be moved is left exactly as it was (record, key secret,
     * connection) and reported in `failed`; the others still move. An older pipeline goes new-key-first —
     * the new secret, the connection, the record — and only then loses its old secret, so a failure or a
     * crash at any point leaves a pipeline that still works.
     */
    async followGateway(): Promise<{ moved: string[]; failed: string[] }> {
      const settings = deps.readSettings();
      const out = { moved: [] as string[], failed: [] as string[] };
      for (const [vaultId, record] of Object.entries(readPipelines(deps.dataDir))) {
        let created: string | undefined; // the gateway-key secret made for this pipeline, until its record holds it
        try {
          const data = await gql<{ document: { document: { state: { global: { config?: Record<string, unknown> } } } } }>(
            deps.origin,
            `query($id: String!) { document(idOrSlug: $id) { document { state } } }`,
            { id: record.connectionId },
            f,
          ).catch(() => null);
          if (!data) continue; // the connection was deleted in Studio: nothing to point anywhere
          const current = data.document.document.state.global.config ?? {};
          if (record.gatewayKeyed) {
            if (current.llm_base_url === deps.gateway.url()) continue;
            await updateConnectionModels(record.connectionId, settings);
          } else {
            created = await createSecret(deps.gateway.key, `${await deps.vaultName(vaultId).catch(() => vaultId)} — model gateway key`);
            await updateConnectionModels(record.connectionId, settings, created);
            // This record now, re-read: a crash later loses nothing, and a pipeline set up meanwhile is not overwritten.
            writePipelines(deps.dataDir, { ...readPipelines(deps.dataDir), [vaultId]: { ...record, secretRefs: { ...record.secretRefs, llm: created }, gatewayKeyed: true } });
            created = undefined;
            await deleteSecret(record.secretRefs.llm);
          }
          out.moved.push(vaultId);
        } catch (error) {
          if (created) await deleteSecret(created);
          console.warn(`[pipelines] could not move the pipeline of vault ${vaultId} to the gateway: ${error instanceof Error ? error.message : String(error)}`);
          out.failed.push(vaultId);
        }
      }
      return out;
    },

    /**
     * At start: every pipeline publishes the template's run policy and the trigger's poll interval.
     * Since 6.2.3-dev.50 the runtime enforces the policy, and a pipeline made before the template carried
     * one runs with the workflow model's default (QUEUE, a one-hour deadline, PARK on the first failure);
     * one made before the 15 s interval checks the queue every 60 s. Each is patched in place —
     * SET_POLICY and/or SET_TRIGGER, then PUBLISH_WORKFLOW, since the runtime reads the published
     * workflow; publishing also lifts a park — keeping its runs and history. One with unpublished edits
     * from Workflow Studio is left alone (publishing would publish them too) and reported in `skipped`.
     */
    async followTemplate(): Promise<{ updated: string[]; skipped: string[]; failed: string[] }> {
      const out = { updated: [] as string[], skipped: [] as string[], failed: [] as string[] };
      const want = templatePolicy(deps.template);
      const wantPoll = templatePollSeconds(deps.template);
      if (!want && wantPoll === undefined) return out;
      type Binding = { id: string; pieceName: string; pieceVersion: string; triggerName: string; connectionId?: string | null; reactorConnectionId?: string | null; config?: Record<string, unknown>; propertySettings?: unknown[] | null };
      type Published = { version?: number; policy?: Record<string, unknown>; trigger?: Binding | null };
      for (const [vaultId, record] of Object.entries(readPipelines(deps.dataDir))) {
        if (record.disabled) continue; // set up again from the template when it is enabled
        try {
          const data = await gql<{ document: { document: { state: { global: { version?: number; trigger?: Binding | null; published?: Published | null } } } } }>(
            deps.origin,
            `query($id: String!) { document(idOrSlug: $id) { document { state } } }`,
            { id: record.workflowId },
            f,
          ).catch(() => null);
          if (!data) continue; // the workflow was deleted in Studio
          const global = data.document.document.state.global;
          const published = global.published?.policy ?? {};
          const policyStale = want !== undefined && !Object.entries(want).every(([k, v]) => published[k] === v);
          const trigger = global.trigger;
          const pollStale = wantPoll !== undefined && !!trigger && global.published?.trigger?.config?.[POLL_KEY] !== wantPoll;
          if (!policyStale && !pollStale) continue;
          if (global.published && global.version !== global.published.version) {
            out.skipped.push(vaultId);
            continue;
          }
          const ops: Array<{ type: string; input: unknown }> = [];
          if (policyStale) ops.push({ type: "SET_POLICY", input: want });
          if (pollStale && trigger) {
            const { id, pieceName, pieceVersion, triggerName, connectionId, reactorConnectionId, config, propertySettings } = trigger;
            ops.push({
              type: "SET_TRIGGER",
              input: {
                id,
                pieceName,
                pieceVersion,
                triggerName,
                ...(connectionId ? { connectionId } : {}),
                ...(reactorConnectionId ? { reactorConnectionId } : {}),
                config: { ...(config ?? {}), [POLL_KEY]: wantPoll },
                ...(propertySettings ? { propertySettings } : {}),
              },
            });
          }
          ops.push({ type: "PUBLISH_WORKFLOW", input: { publishedAt: now() } });
          await execute(deps.origin, record.workflowId, toActions(ops, now), f);
          out.updated.push(vaultId);
        } catch (error) {
          console.warn(`[pipelines] could not bring vault ${vaultId}'s pipeline up to the template: ${error instanceof Error ? error.message : String(error)}`);
          out.failed.push(vaultId);
        }
      }
      return out;
    },

    /** At start: every vault's pipeline gets its Reweave notes workflow, or has it brought to a newer template in place (ensureReweave). */
    async followReweave(): Promise<{ created: string[]; updated: string[]; failed: string[] }> {
      const out = { created: [] as string[], updated: [] as string[], failed: [] as string[] };
      for (const vaultId of Object.keys(readPipelines(deps.dataDir))) {
        const result = await ensureReweave(vaultId);
        if (result === "created") out.created.push(vaultId);
        if (result === "updated") out.updated.push(vaultId);
        if (result === "failed") out.failed.push(vaultId);
      }
      return out;
    },

    /**
     * Settings › Models changed: every pipeline follows. A pipeline whose steps defer to the connection gets its
     * connection's config rewritten in place. An older one, with the model baked into its steps or made from another
     * template, is brought to the template in place by ensure(); it is listed under `recreated`, a name kept for the
     * control API. Either way its runs and history are kept. Disabled pipelines stay disabled.
     */
    async applyModels(): Promise<{ updated: string[]; recreated: string[] }> {
      const settings = deps.readSettings();
      const out = { updated: [] as string[], recreated: [] as string[] };
      if (!modelsConfigured(settings)) return out;
      for (const [vaultId, record] of Object.entries(readPipelines(deps.dataDir))) {
        if (record.disabled) continue;
        if (record.models && record.models.endpoint === settings.models.endpoint && record.models.model === settings.models.model) continue;
        if (record.modelFromConnection && record.templateDigest === templateDigest(deps.template)) {
          await updateConnectionModels(record.connectionId, settings);
          const records = readPipelines(deps.dataDir);
          const current = records[vaultId];
          if (current) {
            records[vaultId] = { ...current, models: { endpoint: settings.models.endpoint, model: settings.models.model } };
            writePipelines(deps.dataDir, records);
          }
          out.updated.push(vaultId);
        } else {
          await ensure(vaultId);
          out.recreated.push(vaultId);
        }
      }
      return out;
    },

    /** The model key was removed: every recorded pipeline is disabled and its key secret deleted; the records say why. */
    async disableAll(reason: string): Promise<void> {
      const records = readPipelines(deps.dataDir);
      for (const [vaultId, record] of Object.entries(records)) {
        for (const id of [record.workflowId, ...(record.reweave ? [record.reweave.workflowId] : [])]) {
          await execute(deps.origin, id, toActions([{ type: "SET_WORKFLOW_STATUS", input: { status: "DISABLED" } }], now), f).catch(() => undefined);
        }
        await deleteSecret(record.secretRefs.llm);
        records[vaultId] = { ...record, disabled: reason };
      }
      writePipelines(deps.dataDir, records);
    },

    /**
     * This vault's pipeline as the runtime sees it: its trigger (filtered to its workflow) and its
     * last run — or `stale` with the reason when what it was set up with no longer holds.
     */
    async status(vaultId: string): Promise<PipelineStatus> {
      const settings = deps.readSettings();
      if (!modelsConfigured(settings)) return { state: "unconfigured" };
      const record = readPipelines(deps.dataDir)[vaultId];
      if (!record) return { state: "missing" };
      const stale = staleReason(record, settings);
      if (stale) return { state: "stale", reason: stale, workflowId: record.workflowId, connectionId: record.connectionId };
      let data: {
        workflowRuntime: {
          triggerStates: Array<{ workflowId: string; status: string; lastPollAt: string | null; lastError: string | null }>;
          runsPage: { items: Array<{ id: string; status: string; startedAt: string | null; endedAt: string | null; error: string | null }> };
        };
      };
      try {
        data = await gql(
          deps.origin,
          `query($w: String!) { workflowRuntime { triggerStates { workflowId status lastPollAt lastError } runsPage(workflowId: $w, paging: { limit: 1 }) { items { id status startedAt endedAt error } } } }`,
          { w: record.workflowId },
          f,
        );
      } catch (error) {
        if (runtimeMissing(error)) return { state: "starting" };
        throw error;
      }
      const trigger = data.workflowRuntime.triggerStates.find((t) => t.workflowId === record.workflowId);
      const run = data.workflowRuntime.runsPage.items[0];
      return {
        state: "ready",
        workflowId: record.workflowId,
        connectionId: record.connectionId,
        ...(trigger ? { trigger: { status: trigger.status, lastPollAt: trigger.lastPollAt, lastError: trigger.lastError } } : {}),
        ...(run ? { lastRun: { id: run.id, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, error: run.error, problem: classifyRunError(run.error) ?? undefined } } : {}),
      };
    },

    /** Delete the pipeline's documents and secrets and forget the record; a vault without one is left alone. */
    async remove(vaultId: string): Promise<void> {
      const records = readPipelines(deps.dataDir);
      const record = records[vaultId];
      if (!record) return;
      await discard(record);
      delete records[vaultId];
      writePipelines(deps.dataDir, records);
    },
  };
}
export type PipelineManager = ReturnType<typeof createPipelineManager>;
