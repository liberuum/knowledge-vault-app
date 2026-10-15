/**
 * How a long PDF is read: in page windows, and its back matter apart.
 *
 * Measured on a 1,005-page book (MLSysBook vol. 1, Ryzen 7 5800X, 8 threads):
 * the whole book in one docling.rs call took 15 min; four 250-page windows
 * took about a minute each — except the last. Its Index pages are two-column
 * lists of "term, page" lines that the layout model takes for tables, and each
 * "table" runs TableFormer's decoder to its 1,024-step cap on one thread:
 * 18 s for a single Index page, about ten minutes for the Index. Read without
 * TableFormer (`noTableFormer`: tables from the layout's geometry) an Index
 * page takes a fraction of a second — and the vault leaves an Index section
 * out by default anyway.
 *
 * So a PDF of `WINDOW_FROM_PAGES` pages or more, or one with back matter, is
 * read in windows of at most `WINDOW_PAGES`: each window's end moves the
 * progress bar, and back matter — Index, Glossary, References, found from the
 * PDF's own outline or, without one, from pages of "term, page" lines — is
 * read without TableFormer. The windows are joined into one document
 * (docmerge.mjs) before anything downstream sees them.
 */

export const WINDOW_FROM_PAGES = 200;
export const WINDOW_PAGES = 150;

/** Outline titles that name back matter, numbered or not ("A. Index", "Appendix B: Glossary"). */
const BACK_MATTER = /^(?:(?:appendix\s+)?[a-z0-9]{1,3}[.:)]?\s+)?(index|subject index|author index|name index|glossary|bibliography|references|works cited)\s*$/i;

/** An index line: a term, a comma, page numbers ("Power management mobile AI, 608"). */
const INDEX_LINE = /\p{L}.*,\s*\d{1,4}(?:\s*[–-]\s*\d{1,4})?(?:\s*,\s*\d{1,4}(?:\s*[–-]\s*\d{1,4})?)*\s*$/u;

/** A page that reads like an index: a dozen or more lines, half of them "term, page". */
export function indexLikePage(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 12) return false;
  return lines.filter((line) => INDEX_LINE.test(line)).length * 2 >= lines.length;
}

/**
 * The pages (1-based) of back matter, from the outline's top-level entries in
 * document order: a back-matter entry runs to the page before the next entry,
 * or to the end. Without such entries, the pages that read like an index.
 */
export function backMatterPages({ pages, outline = [], pageTexts = [] }) {
  const marked = new Set();
  const entries = outline.filter((entry) => Number.isInteger(entry.page) && entry.page >= 1 && entry.page <= pages);
  entries.forEach((entry, i) => {
    if (!BACK_MATTER.test(entry.title.trim())) return;
    const end = i + 1 < entries.length ? Math.max(entry.page, entries[i + 1].page - 1) : pages;
    for (let page = entry.page; page <= end; page++) marked.add(page);
  });
  if (marked.size === 0) {
    pageTexts.forEach((text, i) => {
      if (indexLikePage(text ?? "")) marked.add(i + 1);
    });
  }
  return marked;
}

/**
 * The windows to read, in page order: `{ from, to, backMatter }`, 1-based and
 * inclusive. Null when one read of the whole file is the plan (short, no back
 * matter).
 */
export function planWindows({ pages, outline = [], pageTexts = [] }) {
  if (!Number.isInteger(pages) || pages < 2) return null;
  const back = backMatterPages({ pages, outline, pageTexts });
  if (pages < WINDOW_FROM_PAGES && back.size === 0) return null;
  const windows = [];
  let from = 1;
  for (let page = 2; page <= pages + 1; page++) {
    const ends =
      page > pages || back.has(page) !== back.has(from) || page - from >= WINDOW_PAGES;
    if (!ends) continue;
    windows.push({ from, to: page - 1, backMatter: back.has(from) });
    from = page;
  }
  return windows;
}
