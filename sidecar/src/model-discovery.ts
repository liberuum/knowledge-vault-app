import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Finding AI models running on this computer (spec §4): every port listening on loopback, plus the
 * well-known defaults, asked for an OpenAI-style model list; a server that answers is identified by its
 * native endpoint and asked what it has loaded. Read-only GETs, never a key, never a model load.
 */
export const KNOWN_PORTS: Readonly<Record<number, string>> = {
  11434: "Ollama",
  1234: "LM Studio",
  8080: "llama.cpp",
  8000: "vLLM",
  13305: "Lemonade",
  1337: "Jan",
  4891: "GPT4All",
  5001: "KoboldCpp",
};

export type DiscoveredModel = {
  id: string;
  /** Ready to answer now (true), installed but not loaded (false), or the server does not say (null). */
  loaded: boolean | null;
  contextLength: number | null;
  vision: boolean | null;
};
export type DiscoveredServer = {
  /** The OpenAI-compatible API root, e.g. http://127.0.0.1:8084/v1. */
  endpoint: string;
  port: number;
  /** "llama.cpp", "Ollama", "LM Studio", …, or "OpenAI-compatible server". */
  provider: string;
  models: DiscoveredModel[];
  /** Requests it takes at once, when it says (llama.cpp's slots). */
  parallel: number | null;
};

/** Linux /proc/net/tcp{,6}: ports in LISTEN (0A) on loopback or every interface. */
export function parseProcNetTcp(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== "0A") continue;
    const [ip, portHex] = (cols[1] ?? "").split(":");
    if (!ip || !portHex) continue;
    const anyAddress = /^0+$/.test(ip);
    const loopback4 = ip.length === 8 && ip.slice(6, 8).toUpperCase() === "7F"; // little-endian 127.x.x.x
    const loopback6 = ip.length === 32 && ip.toUpperCase() === "00000000000000000000000001000000"; // ::1
    if (anyAddress || loopback4 || loopback6) ports.add(Number.parseInt(portHex, 16));
  }
  return [...ports];
}

/** macOS `lsof -nP -iTCP -sTCP:LISTEN -F n`: lines like n127.0.0.1:8080, n*:11434, n[::1]:1234. */
export function parseLsof(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    const m = /^n(\*|127\.[\d.]+|localhost|\[::1?\]):(\d+)$/.exec(line.trim());
    if (m) ports.add(Number(m[2]));
  }
  return [...ports];
}

/** Windows `netstat -ano`: LISTENING rows on loopback or every interface. */
export function parseNetstat(text: string): number[] {
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "TCP" || cols[3] !== "LISTENING") continue;
    const m = /^(127\.[\d.]+|0\.0\.0\.0|\[::1?\]):(\d+)$/.exec(cols[1] ?? "");
    if (m) ports.add(Number(m[2]));
  }
  return [...ports];
}

export async function listeningPorts(platform: NodeJS.Platform = process.platform): Promise<number[]> {
  try {
    if (platform === "linux") {
      const read = (p: string) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return "";
        }
      };
      return [...new Set([...parseProcNetTcp(read("/proc/net/tcp")), ...parseProcNetTcp(read("/proc/net/tcp6"))])];
    }
    if (platform === "darwin") return parseLsof((await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"], { timeout: 4000 })).stdout);
    if (platform === "win32") return parseNetstat((await run("netstat", ["-ano"], { timeout: 6000, windowsHide: true })).stdout);
  } catch {
    // lsof exits 1 when nothing listens; any failure leaves the well-known ports
  }
  return [];
}

const PROBE_MS = 700;
async function getJson(url: string, f: typeof fetch): Promise<unknown> {
  try {
    const res = await f(url, { signal: AbortSignal.timeout(PROBE_MS) });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** The ids in an OpenAI-style model list ({ data: [{ id }] }), or null when it is not one. */
function modelIds(list: unknown): string[] | null {
  if (!isObject(list) || !Array.isArray(list.data)) return null;
  return list.data.flatMap((m) => (isObject(m) && typeof m.id === "string" && m.id ? [m.id] : []));
}

/** One port: is it a model server, which one, and what does it serve. */
export async function probeServer(port: number, f: typeof fetch = fetch): Promise<DiscoveredServer | null> {
  const base = `http://127.0.0.1:${port}`;
  let prefix = "/v1";
  let list = await getJson(`${base}/v1/models`, f);
  let ids = modelIds(list);
  if (ids === null) {
    prefix = "/api/v1"; // Lemonade
    list = await getJson(`${base}/api/v1/models`, f);
    ids = modelIds(list);
  }
  if (!ids || ids.length === 0) return null;
  const server: DiscoveredServer = {
    endpoint: base + prefix,
    port,
    provider: "OpenAI-compatible server",
    models: ids.map((id) => ({ id, loaded: null, contextLength: null, vision: null })),
    parallel: null,
  };
  const byId = (id: string) => server.models.find((m) => m.id === id);
  // vLLM puts the context length in its own model list.
  if (isObject(list) && Array.isArray(list.data)) {
    for (const m of list.data) if (isObject(m) && typeof m.id === "string" && num(m.max_model_len)) byId(m.id)!.contextLength = num(m.max_model_len);
  }
  const [props, ollama, lmstudio, kobold, vllm] = await Promise.all([
    getJson(`${base}/props`, f),
    getJson(`${base}/api/version`, f),
    getJson(`${base}/api/v0/models`, f),
    getJson(`${base}/api/extra/version`, f),
    getJson(`${base}/version`, f),
  ]);
  if (isObject(props) && (isObject(props.default_generation_settings) || "total_slots" in props)) {
    server.provider = "llama.cpp";
    const settings = isObject(props.default_generation_settings) ? props.default_generation_settings : {};
    const ctx = num(settings.n_ctx) ?? num(props.n_ctx);
    const vision = isObject(props.modalities) && typeof props.modalities.vision === "boolean" ? props.modalities.vision : null;
    server.parallel = num(props.total_slots);
    for (const m of server.models) Object.assign(m, { loaded: true, contextLength: ctx, vision });
  } else if (isObject(ollama) && typeof ollama.version === "string") {
    server.provider = "Ollama";
    const ps = await getJson(`${base}/api/ps`, f);
    const running = new Map<string, number | null>();
    if (isObject(ps) && Array.isArray(ps.models)) {
      for (const m of ps.models) if (isObject(m) && typeof m.name === "string") running.set(m.name, num(m.context_length));
    }
    for (const m of server.models) {
      m.loaded = running.has(m.id);
      m.contextLength = running.get(m.id) ?? null;
    }
  } else if (isObject(lmstudio) && Array.isArray(lmstudio.data)) {
    server.provider = "LM Studio";
    const info = new Map<string, Record<string, unknown>>();
    for (const m of lmstudio.data) if (isObject(m) && typeof m.id === "string") info.set(m.id, m);
    server.models = server.models.filter((m) => info.get(m.id)?.type !== "embeddings");
    for (const m of server.models) {
      const i = info.get(m.id);
      if (!i) continue;
      m.loaded = i.state === "loaded";
      m.contextLength = num(i.loaded_context_length) ?? num(i.max_context_length);
      m.vision = i.type === "vlm";
    }
  } else if (isObject(kobold) && typeof kobold.result === "string" && /kobold/i.test(kobold.result)) {
    server.provider = "KoboldCpp";
  } else if (isObject(vllm) && typeof vllm.version === "string" && server.models.some((m) => m.contextLength !== null)) {
    server.provider = "vLLM";
  } else if (port === 13305 || prefix === "/api/v1") {
    server.provider = "Lemonade";
  } else if (port === 1337) {
    server.provider = "Jan";
  } else if (port === 4891) {
    server.provider = "GPT4All";
  }
  return server.models.length ? server : null;
}

/** Every model server on this computer: listening ports plus the defaults, probed at once. */
export async function discoverLocalModels(
  opts: { exclude?: number[]; fetchImpl?: typeof fetch; ports?: () => Promise<number[]> } = {},
): Promise<DiscoveredServer[]> {
  const exclude = new Set(opts.exclude ?? []);
  const listening = await (opts.ports ?? listeningPorts)();
  const ports = [...new Set([...listening, ...Object.keys(KNOWN_PORTS).map(Number)])].filter((p) => p > 0 && !exclude.has(p));
  const found = (await Promise.all(ports.map((p) => probeServer(p, opts.fetchImpl ?? fetch)))).filter((s): s is DiscoveredServer => s !== null);
  // A server with a model ready to answer first; then by port.
  const ready = (s: DiscoveredServer) => (s.models.some((m) => m.loaded === true) ? 0 : 1);
  return found.sort((a, b) => ready(a) - ready(b) || a.port - b.port);
}
