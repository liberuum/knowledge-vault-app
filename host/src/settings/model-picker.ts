/** The Models picker's logic, kept pure: searching the provider's catalog and ranking what suits the pipeline. */
export type CatalogModel = {
  id: string;
  name: string;
  contextLength?: number;
  promptPrice?: number;
  completionPrice?: number;
  free: boolean;
  jsonOutput?: boolean;
  textOutput?: boolean;
  outputs?: string[];
  maxOutput?: number;
  quality?: number;
};

/** Case-insensitive, every word of the query must appear in the id or the name. */
export function filterModels(models: readonly CatalogModel[], query: string): CatalogModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...models];
  return models.filter((m) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The pipeline's extraction reads a whole source in one pass and asks for JSON, so a model needs room and `response_format`. */
export const MIN_CONTEXT_FOR_PROCESSING = 64_000;
/** The longest reply the pipeline asks for; a model that cannot give it would cut extractions short. */
export const MIN_OUTPUT_FOR_PROCESSING = 16_000;

export type Fit = { ok: true } | { ok: false; reason: string } | { ok: null };

/**
 * Whether the pipeline can use a model: it must answer in JSON (`response_format`), produce text
 * and nothing else (a music or image model also lists "text" and still refuses the work), take a
 * whole source (64k+ context) and give a long reply (16k+). `ok: null` when the provider's list
 * says too little to tell (OpenAI, a local server).
 */
export function fitForProcessing(m: CatalogModel): Fit {
  if (m.jsonOutput === undefined && m.outputs === undefined && m.contextLength === undefined) return { ok: null };
  if (m.jsonOutput === false) return { ok: false, reason: "no JSON output" };
  if (m.textOutput === false) return { ok: false, reason: "does not produce text" };
  const media = (m.outputs ?? []).filter((o) => o !== "text");
  if (media.length) return { ok: false, reason: `makes ${media.join(" and ")}, not a text model` };
  if (m.contextLength !== undefined && m.contextLength < MIN_CONTEXT_FOR_PROCESSING) return { ok: false, reason: "context too small for a whole source" };
  if (m.maxOutput !== undefined && m.maxOutput < MIN_OUTPUT_FOR_PROCESSING) return { ok: false, reason: "replies too short for an extraction" };
  if (m.jsonOutput !== true) return { ok: null };
  return { ok: true };
}

/**
 * Models that suit processing, best first: the ones that fit (above), with a known price and a
 * quality score — ranked by the score the provider relays (Artificial Analysis' intelligence
 * index), cheaper first among equals. A bare list recommends nothing.
 */
export function recommendedModels(models: readonly CatalogModel[], limit = 8): CatalogModel[] {
  return models
    .filter(
      (m) =>
        fitForProcessing(m).ok === true &&
        m.quality !== undefined &&
        m.promptPrice !== undefined &&
        !m.free &&
        // OpenRouter's batch variants answer hours later; the pipeline waits for its reply.
        !m.id.endsWith(":batch"),
    )
    .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || (a.promptPrice ?? Infinity) - (b.promptPrice ?? Infinity) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Free models, the ones that fit processing first. */
export const freeModels = (models: readonly CatalogModel[]) =>
  models.filter((m) => m.free).sort((a, b) => Number(fitForProcessing(b).ok === true) - Number(fitForProcessing(a).ok === true) || a.id.localeCompare(b.id));

/** "$2 / $10 per M tokens", "free", or nothing when the provider did not say. */
export function formatPrice(m: CatalogModel): string | null {
  if (m.free) return "free";
  if (m.promptPrice === undefined && m.completionPrice === undefined) return null;
  const f = (v?: number) => (v === undefined ? "?" : v >= 1 ? `$${Number(v.toFixed(2))}` : `$${Number(v.toFixed(3))}`);
  return `${f(m.promptPrice)} / ${f(m.completionPrice)} per M tokens`;
}

/** "1.05M context", "128k context", or nothing. */
export function formatContext(m: CatalogModel): string | null {
  const n = m.contextLength;
  if (!n) return null;
  return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M context` : `${Math.round(n / 1000)}k context`;
}
