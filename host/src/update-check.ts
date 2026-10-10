/** Semver order (`v` prefix ignored; a release outranks its prereleases; numeric identifiers compare as numbers). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => {
    const t = v.trim().replace(/^v/, "");
    const dash = t.indexOf("-");
    const core = (dash === -1 ? t : t.slice(0, dash)).split(".").map((x) => Number.parseInt(x, 10) || 0);
    const pre = dash === -1 ? [] : t.slice(dash + 1).split(".");
    return { core, pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = Number(p);
    const nq = Number(q);
    const c = Number.isInteger(np) && Number.isInteger(nq) ? Math.sign(np - nq) : p < q ? -1 : p > q ? 1 : 0;
    if (c !== 0) return c as -1 | 1;
  }
  return 0;
}

/** A file of the release: the installers, one per platform (the engine picks this machine's). */
export type UpdateAsset = { name: string; url: string; size: number | null };
export type UpdateInfo = { latest: string; url: string; assets: UpdateAsset[] };
type Storage = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
/** v2: the answer carries the release's files (v1 had none). */
const KEY = "kv.update-check.v2";
/** How often the app asks GitHub: every hour and a half (the open app checks again on this beat), well inside the 60 requests an hour GitHub allows. */
export const CHECK_EVERY_MS = 90 * 60_000;

type Release = { tag_name?: string; html_url?: string; draft?: boolean; assets?: Array<{ name?: string; browser_download_url?: string; size?: number }> };

function toInfo(r: Release, feedUrl: string): UpdateInfo | null {
  if (!r.tag_name || r.draft) return null;
  return {
    latest: r.tag_name.replace(/^v/, ""),
    url: r.html_url ?? feedUrl,
    assets: (r.assets ?? []).flatMap((a) => (a.name && a.browser_download_url ? [{ name: a.name, url: a.browser_download_url, size: typeof a.size === "number" ? a.size : null }] : [])),
  };
}

/** The newest release in the feed's answer: one release ("latest"), or a list — drafts left out, pre-releases in (the app ships as pre-releases). */
export function newestRelease(body: unknown, feedUrl: string): UpdateInfo | null {
  const list = Array.isArray(body) ? (body as Release[]) : [body as Release];
  let best: UpdateInfo | null = null;
  for (const r of list) {
    const info = r && typeof r === "object" ? toInfo(r, feedUrl) : null;
    if (info && (!best || compareSemver(info.latest, best.latest) > 0)) best = info;
  }
  return best;
}

/**
 * Spec §11: asks the release feed at most every hour and a half (cached in storage) and answers the
 * newer release, or null — when up to date, without a feed, or when anything fails (an
 * update check must never bother anyone).
 */
export async function checkForUpdate(feedUrl: string, current: string, fetchImpl: typeof fetch, storage: Storage, now: () => number = Date.now): Promise<UpdateInfo | null> {
  if (!feedUrl) return null;
  try {
    type Cached = UpdateInfo & { at: number };
    let cached: Cached | null;
    try {
      cached = JSON.parse(storage.getItem(KEY) ?? "null") as Cached | null;
    } catch {
      cached = null;
    }
    let latest: UpdateInfo;
    if (cached && now() - cached.at < CHECK_EVERY_MS) {
      latest = { latest: cached.latest, url: cached.url, assets: cached.assets ?? [] };
    } else {
      const res = await fetchImpl(feedUrl, { headers: { accept: "application/vnd.github+json" } });
      if (!res.ok) return null;
      const found = newestRelease(await res.json(), feedUrl);
      if (!found) return null;
      latest = found;
      storage.setItem(KEY, JSON.stringify({ at: now(), ...latest }));
    }
    return compareSemver(latest.latest, current) > 0 ? latest : null;
  } catch {
    return null;
  }
}
