/**
 * Words docling.rs's PDF text reader loses and pdf.js reads.
 *
 * A ligature glyph — ﬁ ﬂ ﬀ ﬃ ﬄ, one glyph drawn for two or three letters —
 * whose font gives it no Unicode mapping comes out of docling.rs as nothing or
 * a gap: "The eld of" for "The field of", "con ate" for "conflate". A drop cap
 * or a tight heading runs a capital into the next word: "AFinal Word". pdf.js
 * recovers both from the font, and the service reads every page with it up
 * front anyway (the quality score), so each page's pdf.js text says what was
 * meant. Measured on a 1,005-page book (MLSysBook, vol. 1): page 15 reads
 * "AFinal Word … The eld of computer architecture … do not con ate novelty".
 *
 * The repair is narrow and page-local. A broken form is replaced only by a
 * word written on the same page, only when the broken form is not itself
 * written there, and never when two different words could have produced it.
 * docling's structure — headings, tables, figures — is untouched.
 */

const LIGATURES = ["ffi", "ffl", "ff", "fi", "fl"];
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;
const COMPOUND = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+/gu;

/**
 * Ligatures as pdf.js can hand them over: the Unicode ligature characters, and
 * — measured in the same book, where some fonts map their ligature glyphs to
 * Latin-1 codes — "Ï" for fi and "Ò" for fl inside a lowercase word
 * ("efÏciency", "trafÏc", "ofÒine"). Spelled out before the repairs are built,
 * so docling.rs's broken "ef ciency" is mended to "efficiency" too.
 */
const SPELLED = [
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
  [/(?<=\p{Ll})Ï(?=\p{Ll})/gu, "fi"],
  [/(?<=\p{Ll})Ò(?=\p{Ll})/gu, "fl"],
];

/** pdf.js's text with its ligatures spelled out as letters. */
export function spellLigatures(text) {
  return SPELLED.reduce((out, [pattern, letters]) => out.replace(pattern, letters), text);
}

/** The words of a text, as the repair counts them. */
export function wordsOf(text) {
  return text.match(WORD) ?? [];
}

/** What a word looks like with one of its ligatures lost: the letters gone, or a gap where they were. */
function brokenForms(word) {
  const forms = new Set();
  for (const ligature of LIGATURES) {
    for (let at = word.indexOf(ligature); at >= 0; at = word.indexOf(ligature, at + 1)) {
      const left = word.slice(0, at);
      const right = word.slice(at + ligature.length);
      if (left.length + right.length < 2) continue;
      forms.add(left + right);
      if (left && right) forms.add(`${left} ${right}`);
    }
  }
  forms.delete(word);
  return forms;
}

/**
 * The repairs one page's pdf.js text supports: each broken form docling.rs
 * could have written, with the words pdf.js read in its place.
 */
export function pageRepairs(pageText) {
  const words = wordsOf(spellLigatures(pageText));
  const written = new Set(words);
  const flat = ` ${words.join(" ")} `;
  const candidates = new Map();
  const offer = (broken, meant) => {
    const isWritten = broken.includes(" ") ? flat.includes(` ${broken} `) : written.has(broken);
    if (isWritten) return;
    const seen = candidates.get(broken);
    if (seen === undefined) candidates.set(broken, meant);
    else if (seen !== meant) candidates.set(broken, null); // two words could have made it: leave it alone
  };
  for (const word of written) {
    if (!LIGATURES.some((ligature) => word.includes(ligature))) continue;
    for (const broken of brokenForms(word)) offer(broken, word);
    // "off" and "fit" lose all but one letter: "o", "t". Too short to replace
    // everywhere; between two words of running text it is mended in place
    // (`repairText`), and only when the letter alone is never written here.
    for (const ligature of LIGATURES) {
      const left = word.startsWith(ligature) ? "" : null;
      const rest = word.length - ligature.length;
      if (rest === 1 && !written.has(word.replace(ligature, ""))) {
        const letter = word.replace(ligature, "");
        if (left !== null || word.endsWith(ligature)) offer(`\u0000${letter}`, word);
      }
    }
  }
  // A hyphenated compound whose last part lost its ligature: "trade-o" for "trade-off".
  for (const compound of spellLigatures(pageText).match(COMPOUND) ?? []) {
    const parts = compound.split("-");
    const last = parts.at(-1) ?? "";
    if (!LIGATURES.some((ligature) => last.includes(ligature))) continue;
    for (const ligature of LIGATURES) {
      const at = last.indexOf(ligature);
      if (at < 0) continue;
      const before = last.slice(0, at);
      const after = last.slice(at + ligature.length);
      const head = parts.slice(0, -1).join("-");
      // The letters gone ("trade-o" for "trade-off"), or a gap where they were ("trade-o s" for "trade-offs").
      if (before + after) offer(`${head}-${before}${after}`, compound);
      if (before && after) offer(`${head}-${before} ${after}`, compound);
    }
  }
  // A capital run into the next word: "AFinal" for "A Final".
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i], words[i + 1]];
    if (a.length === 1 && /\p{Lu}/u.test(a) && /^\p{L}/u.test(b)) offer(a + b, `${a} ${b}`);
  }
  const repairs = new Map();
  for (const [broken, meant] of candidates) if (meant !== null) repairs.set(broken, meant);
  return repairs;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text with each broken form, standing as whole words, replaced by what pdf.js read. */
export function repairText(text, repairs, { inPlace = true } = {}) {
  if (repairs.size === 0 || !text) return text;
  const whole = [...repairs.keys()].filter((k) => !k.startsWith("\u0000"));
  let out = text;
  if (whole.length > 0) {
    const pattern = whole.sort((a, b) => b.length - a.length).map(escape).join("|");
    const re = new RegExp(`(?<![\\p{L}\\p{N}'’-])(?:${pattern})(?![\\p{L}\\p{N}'’-])`, "gu");
    out = out.replace(re, (broken) => repairs.get(broken) ?? broken);
  }
  // A one-letter remnant ("t" of "fit"), mended only between two words of
  // running text: a lowercase word before, a word after.
  if (inPlace) {
    for (const [key, meant] of repairs) {
      if (!key.startsWith("\u0000")) continue;
      const letter = escape(key.slice(1));
      const re = new RegExp(`(?<=\\p{Ll}\\p{Ll} )${letter}(?= [\\p{L}\\p{N}])`, "gu");
      out = out.replace(re, meant);
    }
  }
  return out;
}

/**
 * A docling JSON with its text items and table cells repaired page by page
 * (`pageTexts[n - 1]` is page n's pdf.js text). `fixes` counts the items that
 * changed; with none, the JSON comes back as it was given.
 */
export function repairDocument(json, pageTexts) {
  const doc = JSON.parse(json);
  const byPage = new Map();
  const repairsFor = (page) => {
    if (!Number.isInteger(page) || page < 1 || page > pageTexts.length) return null;
    if (!byPage.has(page)) byPage.set(page, pageRepairs(pageTexts[page - 1] ?? ""));
    return byPage.get(page);
  };
  let fixes = 0;
  const fix = (holder, key, page, label) => {
    const repairs = repairsFor(page);
    const text = holder?.[key];
    if (!repairs || repairs.size === 0 || typeof text !== "string") return;
    // A formula is docling's own reading of math, never mended; in code a lone letter is a name.
    if (label === "formula") return;
    const repaired = repairText(text, repairs, { inPlace: label !== "code" });
    if (repaired !== text) {
      holder[key] = repaired;
      fixes += 1;
    }
  };
  for (const item of doc.texts ?? []) {
    const page = item.prov?.[0]?.page_no;
    fix(item, "text", page, item.label);
    fix(item, "orig", page, item.label);
  }
  for (const table of doc.tables ?? []) {
    const page = table.prov?.[0]?.page_no;
    for (const cell of table.data?.table_cells ?? []) fix(cell, "text", page);
    for (const row of table.data?.grid ?? []) for (const cell of row ?? []) fix(cell, "text", page);
  }
  return { json: fixes > 0 ? JSON.stringify(doc) : json, fixes };
}
