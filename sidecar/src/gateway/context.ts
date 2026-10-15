import { probeServer } from "../model-discovery.js";

/** How long a model server's reported context is trusted: it changes only when the server restarts. */
const TTL_MS = 60_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The context size a model on this computer runs with, read from its server (llama.cpp's n_ctx,
 * Ollama, LM Studio, vLLM), so the pipeline can size what it sends. Loopback only; null when the
 * server does not say.
 */
export function localContextProbe(f: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; value: number | null }>();
  return async (endpoint: string, model: string): Promise<number | null> => {
    const key = `${endpoint}#${model}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    let value: number | null = null;
    try {
      const url = new URL(endpoint);
      if (LOOPBACK.has(url.hostname)) {
        const server = await probeServer(Number(url.port || (url.protocol === "https:" ? 443 : 80)), f);
        const models = server?.models ?? [];
        value = (models.find((m) => m.id === model) ?? models.find((m) => m.loaded) ?? models[0])?.contextLength ?? null;
      }
    } catch {
      value = null;
    }
    cache.set(key, { at: now(), value });
    return value;
  };
}
