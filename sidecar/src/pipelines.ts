import type { EngineToken } from "./connections.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteDocument, execute, gql, toActions } from "./reactor-gql.js";
import { SettingsError, type AppSettings } from "./settings.js";
import { instantiatePipeline, type PipelineTemplate } from "./templates.js";
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
};
export type PipelineStatus =
  | { state: "unconfigured" }
  | { state: "missing" }
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
  pieceVersion: string;
  readSettings: () => AppSettings;
  readModelKey: () => string | undefined;
  identity: { status: () => Promise<{ authenticated: boolean }>; token: (expiresIn: number) => Promise<{ token: string }> };
  workflowsDrive: () => Promise<{ id: string }>;
  vaultName: (vaultId: string) => Promise<string>;
  /** A protected engine answers only authenticated callers: its pipeline must run as the signed-in user. */
  engineProtected?: boolean;
  instantiate?: typeof instantiatePipeline;
  now?: () => string;
};

/** The bearer the piece uses lasts long enough to be forgotten about; re-creating the pipeline mints a new one. */
/** What a local model server is sent as its "key": llama.cpp, Ollama and LM Studio ignore it. */
export const LOCAL_PLACEHOLDER_KEY = "local";
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

export function createPipelineManager(deps: PipelineManagerDeps) {
  const f = deps.fetchImpl;
  const now = () => (deps.now ?? (() => new Date().toISOString()))(); // read each time: tests move the clock
  const instantiate = deps.instantiate ?? instantiatePipeline;

  async function createSecret(value: string, label: string): Promise<string> {
    const data = await gql<{ workflowRuntime: { createSecret: { ref: string } } }>(
      deps.origin,
      `mutation($v: String!, $l: String) { workflowRuntime { createSecret(value: $v, label: $l) { ref } } }`,
      { v: value, l: label },
      f,
    );
    return data.workflowRuntime.createSecret.ref;
  }
  const deleteSecret = (ref: string) => gql(deps.origin, `mutation($ref: String!) { workflowRuntime { deleteSecret(ref: $ref) } }`, { ref }, f).catch(() => undefined);
  async function discard(record: PipelineRecord): Promise<void> {
    for (const id of [record.workflowId, record.connectionId]) await deleteDocument(deps.origin, id, f).catch(() => undefined);
    for (const ref of [record.secretRefs.token, record.secretRefs.llm]) await deleteSecret(ref);
  }
  const engineToken = () => mintEngineToken(deps.identity, deps.engineProtected === true, now);
  // A model on this computer needs no key; its connection gets a placeholder the server ignores.
  const modelsConfigured = (settings: AppSettings) => (settings.models.hasKey || settings.models.local) && settings.models.model.trim().length > 0;
  const keyFor = (settings: AppSettings) => deps.readModelKey() ?? (settings.models.local ? LOCAL_PLACEHOLDER_KEY : undefined);

  /** Why a recorded pipeline no longer fits: disabled, other model settings, an "open" bearer on a protected engine, a token near its end. */
  function staleReason(record: PipelineRecord, settings: AppSettings): string | undefined {
    if (record.disabled) return record.disabled;
    // Records written before these fields existed carry neither; they are judged on what they have.
    if (record.models && (record.models.endpoint !== settings.models.endpoint || record.models.model !== settings.models.model)) return "the model settings changed";
    if (deps.engineProtected && record.token?.kind === "open") return "the engine is now protected; the pipeline was set up while it was open";
    if (record.token?.expiresAt) {
      const left = Date.parse(record.token.expiresAt) - Date.parse(now());
      if (left <= 0) return "the engine token expired";
      if (left < TOKEN_RENEW_BEFORE_MS) return "the engine token expires soon";
    }
    return undefined;
  }

  /** Create (or re-create) this vault's pipeline. Nothing happens without a model key and a model. */
  async function ensure(vaultId: string): Promise<EnsureResult> {
      const settings = deps.readSettings();
      const key = keyFor(settings);
      if (!modelsConfigured(settings) || !key) return { state: "unconfigured" };
      if (!deps.template) throw new Error("The installed vault package ships no pipeline template (pieces/knowledge-vault/templates/pipeline.json).");
      const token = await engineToken(); // before anything is created: a refusal costs nothing
      const records = readPipelines(deps.dataDir);
      const previous = records[vaultId];
      if (previous) {
        // The record goes first: a failure from here on reads "missing", never "ready" for a pipeline that no longer exists.
        delete records[vaultId];
        writePipelines(deps.dataDir, records);
        await discard(previous);
      }
      const name = await deps.vaultName(vaultId);
      const { id: workflowsDriveId } = await deps.workflowsDrive();
      const tokenRef = await createSecret(token.value, `${name} — engine token`);
      const llmRef = await createSecret(key, `${name} — model key`);
      try {
        const { workflowId, connectionId } = await instantiate({
          origin: deps.origin,
          template: deps.template,
          vaultName: name,
          driveId: vaultId,
          workflowsDriveId,
          secretRefs: { token: tokenRef, llm: llmRef },
          llm: { baseUrl: settings.models.endpoint, model: settings.models.model },
          pieceVersion: deps.pieceVersion,
          now,
          fetchImpl: f,
        });
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
          },
        });
        return { state: "ready", workflowId, connectionId };
      } catch (error) {
        // instantiatePipeline removed its documents; the two secrets are ours to remove.
        await deleteSecret(tokenRef);
        await deleteSecret(llmRef);
        throw error;
      }
  }

  /** Point a connection at the model settings: the config is rewritten whole, the other keys kept. */
  async function updateConnectionModels(connectionId: string, settings: AppSettings): Promise<void> {
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
      toActions([{ type: "SET_CONFIG", input: { config: { ...config, llm_base_url: settings.models.endpoint, llm_default_model: settings.models.model } } }], now),
      f,
    );
  }

  return {
    ensure,

    /**
     * Settings › Models changed: every pipeline follows. One whose steps defer to the connection gets
     * its connection's config rewritten in place (runs and history kept); an older one, with the model
     * baked into its steps, is set up again. Disabled pipelines stay disabled.
     */
    async applyModels(): Promise<{ updated: string[]; recreated: string[] }> {
      const settings = deps.readSettings();
      const out = { updated: [] as string[], recreated: [] as string[] };
      if (!modelsConfigured(settings)) return out;
      for (const [vaultId, record] of Object.entries(readPipelines(deps.dataDir))) {
        if (record.disabled) continue;
        if (record.models && record.models.endpoint === settings.models.endpoint && record.models.model === settings.models.model) continue;
        if (record.modelFromConnection) {
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
        await execute(deps.origin, record.workflowId, toActions([{ type: "SET_WORKFLOW_STATUS", input: { status: "DISABLED" } }], now), f).catch(() => undefined);
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
      const data = await gql<{
        workflowRuntime: {
          triggerStates: Array<{ workflowId: string; status: string; lastPollAt: string | null; lastError: string | null }>;
          runsPage: { items: Array<{ id: string; status: string; startedAt: string | null; endedAt: string | null; error: string | null }> };
        };
      }>(
        deps.origin,
        `query($w: String!) { workflowRuntime { triggerStates { workflowId status lastPollAt lastError } runsPage(workflowId: $w, paging: { limit: 1 }) { items { id status startedAt endedAt error } } } }`,
        { w: record.workflowId },
        f,
      );
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
