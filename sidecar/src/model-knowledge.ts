import { MODEL_SNAPSHOT, MODEL_SNAPSHOT_DATE } from "./model-knowledge.data.js";
import { normaliseCatalog, type CatalogModel } from "./models-validate.js";

/**
 * A provider's own model list (OpenAI, Anthropic, Gemini, xAI) names its models and says little
 * else, so the picker could not tell which ones the vault can use. The engine ships a snapshot of
 * OpenRouter's public catalog for those providers (scripts/update-model-knowledge.mjs) and fills in
 * what the provider left out: context, reply length, JSON support, prices, quality. Nothing is
 * fetched at run time; a model the snapshot does not know stays unjudged.
 */
export { MODEL_SNAPSHOT_DATE };

/** The snapshot's name for a provider's models, by the provider's API host. */
export function catalogPrefix(endpoint: string): string | undefined {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return undefined;
  }
  if (host === "api.openai.com") return "openai/";
  if (host === "api.anthropic.com") return "anthropic/";
  if (host === "generativelanguage.googleapis.com") return "google/";
  if (host === "api.x.ai") return "x-ai/";
  return undefined;
}

/**
 * One key for a model however its provider spells it: no owner prefix, no `:free`/`:batch`, no
 * dated-snapshot or `-latest` suffix, dots as dashes ("anthropic/claude-sonnet-4.5" and
 * "claude-sonnet-4-5-20250929" both become "claude-sonnet-4-5").
 */
export function modelKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/:[a-z]+$/, "")
    .replace(/-latest$/, "")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/\./g, "-");
}

let known: Map<string, CatalogModel> | undefined;
function knownModels(): Map<string, CatalogModel> {
  if (!known) {
    known = new Map();
    for (const m of normaliseCatalog([...MODEL_SNAPSHOT])) {
      const owner = m.id.slice(0, m.id.indexOf("/") + 1);
      const key = owner + modelKey(m.id);
      if (!known.has(key)) known.set(key, m);
    }
  }
  return known;
}

/** Each model the provider described keeps its own facts; one it only named gets the snapshot's. */
export function describeFromKnowledge(endpoint: string, models: CatalogModel[]): CatalogModel[] {
  const prefix = catalogPrefix(endpoint);
  if (!prefix) return models;
  return models.map((m) => {
    if (m.jsonOutput !== undefined || m.contextLength !== undefined || m.outputs !== undefined) return m;
    const k = knownModels().get(prefix + modelKey(m.id));
    if (!k) return m;
    return { ...k, id: m.id, name: m.name !== m.id ? m.name : k.name, free: m.free, describedBy: "catalog" };
  });
}
