/**
 * Every file address a drop offers, wherever the platform put it. WebKitGTK (the Linux window) lists
 * `text/uri-list` for files dragged from a file manager but may answer it empty, and put the address under
 * `URL`, `text/plain`, the `text/html` part or the drop's string items instead. Call it inside the drop
 * handler: the drop's data is read before the first await, while the event still allows it.
 */
export async function dropAddresses(dt: DataTransfer): Promise<{ addresses: string[]; seen: Array<[string, string]> }> {
  const seen: Array<[string, string]> = [];
  const read = (type: string) => {
    try {
      return dt.getData(type);
    } catch {
      return "";
    }
  };
  for (const type of new Set([...Array.from(dt.types), "URL", "text/plain"])) seen.push([type, read(type)]);
  const strings = Array.from(dt.items ?? []).filter((item) => item.kind === "string");
  const fromItems = await Promise.all(
    strings.map(
      (item) =>
        new Promise<[string, string]>((resolve) => {
          const done = setTimeout(() => resolve([`item ${item.type}`, ""]), 1000);
          try {
            item.getAsString((value) => {
              clearTimeout(done);
              resolve([`item ${item.type}`, value ?? ""]);
            });
          } catch {
            clearTimeout(done);
            resolve([`item ${item.type}`, ""]);
          }
        }),
    ),
  );
  seen.push(...fromItems);
  const addresses = new Set<string>();
  for (const [, value] of seen) {
    for (const match of value.matchAll(/file:\/\/[^\s"'<>]+/g)) addresses.add(match[0].replace(/&amp;/g, "&"));
    // A bare absolute path on its own line (some file managers' text/plain).
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^\/[^<>"]+$/.test(trimmed) || /^[A-Za-z]:\\[^<>"]+$/.test(trimmed)) addresses.add(trimmed);
    }
  }
  return { addresses: [...addresses], seen };
}

/** What a drop held, for the message when nothing in it was a file: each part, briefly. */
export function describeDrop(seen: ReadonlyArray<[string, string]>): string {
  const parts = seen.map(([type, value]) => `${type}: ${value ? `"${value.replace(/\s+/g, " ").slice(0, 70)}${value.length > 70 ? "…" : ""}"` : "empty"}`);
  return parts.join("; ") || "nothing";
}
