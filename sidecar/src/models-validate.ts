import { privateHostAllow } from "./egress.js";

/**
 * Settings › Models › Validate: list the provider's models with the saved key —
 * the cheapest request that proves the endpoint is OpenAI-compatible and the
 * key is accepted, without spending a token.
 */
export type ModelVerdict = { ok: boolean; detail: string; warning?: string };

export async function validateModelEndpoint(endpoint: string, key: string, fetchImpl: typeof fetch = fetch): Promise<ModelVerdict> {
  const url = `${endpoint.replace(/\/+$/, "")}/models`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return { ok: false, detail: `Could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const body: unknown = await res.json().catch(() => undefined);
  // A server on the local network: the engine's egress allow-list is built at start from the saved endpoint.
  const warning = privateHostAllow(endpoint) ? "This server is on your local network. After saving, restart the app so the engine may reach it." : undefined;
  if (res.ok) {
    const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
    return { ok: true, detail: Array.isArray(data) ? `${data.length} models available` : "The provider answered", ...(warning ? { warning } : {}) };
  }
  const message = providerMessage(body) ?? `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) return { ok: false, detail: `The provider refused the key: ${message}` };
  return { ok: false, detail: `The provider answered HTTP ${res.status}: ${message}` };
}

function providerMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return undefined;
}

/**
 * Settings › Models' picker: the provider's model list, normalised. OpenRouter describes each
 * model (name, context, prices, supported parameters); OpenAI and a local Ollama or LM Studio
 * give little more than ids. Unknown fields stay undefined and the page shows what it has.
 */
export type CatalogModel = {
  id: string;
  name: string;
  contextLength?: number;
  /** USD per million tokens. */
  promptPrice?: number;
  completionPrice?: number;
  /** No cost at all (both prices zero, or an OpenRouter `:free` id). */
  free: boolean;
  /** Accepts `response_format` — what the pipeline needs. Undefined when the provider does not say. */
  jsonOutput?: boolean;
  /** Produces text (an image or audio model is no use to the vault). Undefined when the provider does not say. */
  textOutput?: boolean;
  /** Everything the model produces (OpenRouter's output_modalities): a music or image model also lists "text". */
  outputs?: string[];
  /** What the model accepts (OpenRouter's input_modalities): the vault sends text, and figures as images. */
  inputs?: string[];
  /** The longest reply the model can give, in tokens (the pipeline asks for up to 32k). */
  maxOutput?: number;
  /** Artificial Analysis' intelligence index, as OpenRouter relays it — the picker ranks "recommended" by it. */
  quality?: number;
};
export type ModelCatalog = { ok: true; models: CatalogModel[] } | { ok: false; detail: string };

// A negative price is OpenRouter's "varies" (its routers): unknown, not free.
const perMillion = (v: unknown): number | undefined => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1000) / 1000 : undefined;
};

export function normaliseCatalog(data: unknown): CatalogModel[] {
  if (!Array.isArray(data)) return [];
  const out: CatalogModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id : undefined;
    if (!id) continue;
    const pricing = m.pricing && typeof m.pricing === "object" ? (m.pricing as Record<string, unknown>) : undefined;
    const promptPrice = pricing ? perMillion(pricing.prompt) : undefined;
    const completionPrice = pricing ? perMillion(pricing.completion) : undefined;
    const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as unknown[]) : undefined;
    const arch = m.architecture && typeof m.architecture === "object" ? (m.architecture as Record<string, unknown>) : undefined;
    const outputs = arch && Array.isArray(arch.output_modalities) ? (arch.output_modalities as unknown[]) : undefined;
    const inputs = arch && Array.isArray(arch.input_modalities) ? (arch.input_modalities as unknown[]) : undefined;
    const top = m.top_provider && typeof m.top_provider === "object" ? (m.top_provider as Record<string, unknown>) : undefined;
    const bench = m.benchmarks && typeof m.benchmarks === "object" ? (m.benchmarks as Record<string, unknown>) : undefined;
    const aa = bench?.artificial_analysis && typeof bench.artificial_analysis === "object" ? (bench.artificial_analysis as Record<string, unknown>) : undefined;
    out.push({
      id,
      name: typeof m.name === "string" && m.name ? m.name : id,
      contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
      promptPrice,
      completionPrice,
      free: id.endsWith(":free") || (promptPrice === 0 && completionPrice === 0),
      jsonOutput: params ? params.includes("response_format") || params.includes("structured_outputs") : undefined,
      textOutput: outputs ? outputs.includes("text") : undefined,
      outputs: outputs ? outputs.filter((o): o is string => typeof o === "string") : undefined,
      inputs: inputs ? inputs.filter((o): o is string => typeof o === "string") : undefined,
      maxOutput: typeof top?.max_completion_tokens === "number" ? top.max_completion_tokens : undefined,
      quality: typeof aa?.intelligence_index === "number" ? aa.intelligence_index : undefined,
    });
  }
  return out;
}

export async function fetchModelCatalog(endpoint: string, key: string, fetchImpl: typeof fetch = fetch): Promise<ModelCatalog> {
  const url = `${endpoint.replace(/\/+$/, "")}/models`;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return { ok: false, detail: `Could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const message = providerMessage(body) ?? `HTTP ${res.status}`;
    return { ok: false, detail: res.status === 401 || res.status === 403 ? `The provider refused the key: ${message}` : `The provider answered HTTP ${res.status}: ${message}` };
  }
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  return { ok: true, models: normaliseCatalog(data) };
}

export type LocalProbe = { ok: true; endpoint: string; models: string[] } | { ok: false; endpoint: string; detail: string };

/**
 * Settings › Models › Use a local model: is a server answering at this address, and what does it
 * serve? Only addresses on this computer or the local network are tried, and no key is sent.
 * The address is normalised the way Settings stores it (a trailing /chat/completions is dropped).
 */
export async function probeLocalModels(raw: string, isAllowed: (endpoint: string) => boolean, fetchImpl: typeof fetch = fetch): Promise<LocalProbe> {
  const endpoint = raw.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  try {
    new URL(endpoint);
  } catch {
    return { ok: false, endpoint, detail: "That is not a URL. Try http://127.0.0.1:8080/v1." };
  }
  if (!isAllowed(endpoint)) return { ok: false, endpoint, detail: "Only a server on this computer or your local network can be used here." };
  const catalog = await fetchModelCatalog(endpoint, "", fetchImpl);
  if (!catalog.ok) return { ok: false, endpoint, detail: catalog.detail };
  if (catalog.models.length === 0) return { ok: false, endpoint, detail: "The server answered, but serves no model." };
  return { ok: true, endpoint, models: catalog.models.map((m) => m.id) };
}
