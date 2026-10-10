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
  inputs?: string[];
  maxOutput?: number;
  quality?: number;
  /** The provider only named this model; its facts come from the catalog the app ships. */
  describedBy?: "catalog";
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
 * Whether the pipeline can use a model: it must take text (images are welcome, for figures),
 * answer in JSON (`response_format`), produce text and nothing else (a music or image model also lists "text" and still refuses the work), take a
 * whole source (64k+ context) and give a long reply (16k+). `ok: null` when the provider's list
 * says too little to tell (OpenAI, a local server).
 */
/**
 * What a service lists beside its chat models, told by name when nothing describes them: the
 * reason the vault cannot use each kind.
 */
const NOT_FOR_PROCESSING: readonly (readonly [RegExp, string])[] = [
  [/embed/i, "embeddings, not a chat model"],
  [/tts|native-audio|transcri|whisper|speech|realtime|translate|-live(-|$)|audio/i, "speech or live audio, not a text model"],
  [/veo|sora|video/i, "makes video, not a text model"],
  [/lyria|music/i, "makes music, not a text model"],
  [/image|imagen|dall-e|nano-banana/i, "makes images, not a text model"],
  [/computer-use|antigravity|deep-research|robotics/i, "an agent model, not for chat or processing"],
  [/moderation|davinci|babbage|\baqa\b/i, "not a chat model"],
];

export function fitForProcessing(m: CatalogModel): Fit {
  if (m.jsonOutput === undefined && m.outputs === undefined && m.contextLength === undefined) {
    const rule = NOT_FOR_PROCESSING.find(([pattern]) => pattern.test(m.id));
    return rule ? { ok: false, reason: rule[1] } : { ok: null };
  }
  if (m.jsonOutput === false) return { ok: false, reason: "no JSON output" };
  if (m.inputs && !m.inputs.includes("text")) return { ok: false, reason: "does not take text input" };
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

/** How close to the best model's quality score a cheaper one must be to be chosen instead. */
const NEAR_BEST = 0.85;

/**
 * The model to choose for someone who has not: among the models recommended for processing, the
 * cheapest whose quality is near the best one's (review I5: not the dearest — but never a much
 * weaker model just because it is cheap); else the best-rated model that fits. A model nothing
 * describes is never chosen for anyone.
 */
export function defaultModel(models: readonly CatalogModel[]): CatalogModel | undefined {
  const cost = (m: CatalogModel) => (m.promptPrice ?? Infinity) + (m.completionPrice ?? Infinity);
  const ranked = recommendedModels(models, 8);
  const best = ranked[0]?.quality ?? 0;
  const value = ranked.filter((m) => (m.quality ?? 0) >= NEAR_BEST * best).sort((a, b) => cost(a) - cost(b) || (b.quality ?? 0) - (a.quality ?? 0))[0];
  if (value) return value;
  return models
    .filter((m) => fitForProcessing(m).ok === true && !m.id.endsWith(":batch"))
    .sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1) || cost(a) - cost(b) || a.id.localeCompare(b.id))[0];
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

/** The models the picker offers: the ones that can do the vault's work, or might (the provider said too little), plus the one currently chosen. */
export function offerableModels(models: readonly CatalogModel[], current: string): CatalogModel[] {
  return models.filter((m) => fitForProcessing(m).ok !== false || m.id === current);
}
