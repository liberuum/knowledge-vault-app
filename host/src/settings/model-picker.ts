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

/**
 * Models that suit processing, best first: text output, `response_format`, 64k+ context, room for a
 * 16k reply, a known price — ranked by the quality score the provider relays (Artificial Analysis'
 * intelligence index), cheaper first among equals. Only a catalog that describes its models
 * (OpenRouter) can say; a bare list recommends nothing.
 */
export function recommendedModels(models: readonly CatalogModel[], limit = 8): CatalogModel[] {
  return models
    .filter(
      (m) =>
        m.jsonOutput === true &&
        m.textOutput !== false &&
        (m.contextLength ?? 0) >= MIN_CONTEXT_FOR_PROCESSING &&
        (m.maxOutput === undefined || m.maxOutput >= MIN_OUTPUT_FOR_PROCESSING) &&
        m.quality !== undefined &&
        m.promptPrice !== undefined &&
        !m.free &&
        // OpenRouter's batch variants answer hours later; the pipeline waits for its reply.
        !m.id.endsWith(":batch"),
    )
    .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || (a.promptPrice ?? Infinity) - (b.promptPrice ?? Infinity) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export const freeModels = (models: readonly CatalogModel[]) => models.filter((m) => m.free);

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
