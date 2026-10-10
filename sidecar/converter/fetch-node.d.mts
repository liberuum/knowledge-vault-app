export const MODELS_BASE_URL: string;
/** What the download calls: a URL string and fetch's options — `fetch` itself, or a stand-in. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type ModelFile = { dest: string; urls: string[]; optional?: boolean };
/** The model files, in the upstream script's order. */
export function modelPlan(base?: string): ModelFile[];
export function download(
  url: string,
  dest: string,
  options?: { fetchImpl?: FetchLike; attempts?: number; backoffMs?: number; stallMs?: number; wait?: (ms: number) => Promise<void> },
): Promise<void>;
/** Fetch the models into `home` (`.models/…`); `only` fetches just that one file. */
export function fetchModelsInNode(options: {
  home: string;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  only?: string;
  wait?: (ms: number) => Promise<void>;
}): Promise<void>;
