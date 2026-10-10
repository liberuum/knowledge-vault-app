/**
 * docling JSON, rendered back to Markdown.
 *
 * A model conversion is one pass to docling JSON; the Markdown is rendered from
 * that document (`json_docling` input, no models). The render writes docling's
 * own placeholder comments as escaped text — `&lt;!-- formula-not-decoded --&gt;`
 * where a direct `to: "markdown"` conversion writes the comment. The figures and
 * the vault's client match the exact comment, so it is put back.
 *
 * Measured on a 48-page paper: that was the only difference, and with it undone
 * the render is byte-identical to the direct conversion (docling.rs 2.13).
 */
const ESCAPED_PLACEHOLDER = /&lt;!-- (formula-not-decoded|image) --&gt;/g;

/** Put docling's placeholder comments back where the render escaped them. */
export function restorePlaceholders(markdown) {
  return markdown.replace(ESCAPED_PLACEHOLDER, "<!-- $1 -->");
}
