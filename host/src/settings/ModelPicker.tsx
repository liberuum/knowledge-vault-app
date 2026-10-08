import { useEffect, useId, useMemo, useRef, useState } from "react";
import { filterModels, formatContext, formatPrice, freeModels, recommendedModels, type CatalogModel } from "./model-picker.js";

export type CatalogResult = { ok: true; models: CatalogModel[] } | { ok: false; detail: string };

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Whether a key is saved: without one the provider cannot be asked, and the field stays a plain text field. */
  hasKey: boolean;
  /** The provider's list (the engine asks with the saved key); null while nothing was loaded yet. */
  load: () => Promise<CatalogResult>;
  /** Changes to this reload the list (the form's endpoint). */
  reloadKey?: string;
};

type Group = { label: string; models: CatalogModel[] };

/**
 * The model field: free text, plus a searchable list of the models the saved key gives access to.
 * Grouped as "Recommended for processing" (what the pipeline needs, cheapest first), "Free" and
 * "All models"; typing filters every group; arrows, Enter and Escape work as in a combobox.
 */
export function ModelPicker({ id, value, onChange, disabled, placeholder, hasKey, load, reloadKey }: Props) {
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);

  // Load once a key exists; again when the endpoint changes.
  useEffect(() => {
    if (!hasKey) {
      setCatalog(null);
      return;
    }
    let alive = true;
    setLoading(true);
    load()
      .then((c) => alive && setCatalog(c))
      .catch((e: unknown) => alive && setCatalog({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [hasKey, load, reloadKey]);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    if (!catalog?.ok) return [];
    const matching = filterModels(catalog.models, value);
    const recommended = recommendedModels(matching);
    const free = freeModels(matching);
    const seen = new Set([...recommended, ...free].map((m) => m.id));
    const rest = matching.filter((m) => !seen.has(m.id));
    const out: Group[] = [];
    if (recommended.length) out.push({ label: "Recommended for processing", models: recommended });
    if (free.length) out.push({ label: "Free", models: free });
    if (rest.length) out.push({ label: recommended.length || free.length ? "All models" : "Models", models: rest.slice(0, 200) });
    return out;
  }, [catalog, value]);
  const flat = useMemo(() => groups.flatMap((g) => g.models), [groups]);

  useEffect(() => setActive(0), [value, open]);

  const choose = (m: CatalogModel) => {
    onChange(m.id);
    setOpen(false);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!catalog?.ok) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open && flat[active]) {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  const status = !hasKey
    ? "Save your API key to pick from the models it gives you."
    : loading
      ? "Listing your provider's models…"
      : catalog && !catalog.ok
        ? `Could not list models: ${catalog.detail}`
        : catalog?.ok
          ? `${catalog.models.length} models available — type to search, or pick from the list. Recommended ones can do the pipeline's job, ranked by the quality score the provider reports.`
          : null;
  const current = catalog?.ok ? catalog.models.find((m) => m.id === value) : undefined;
  let index = -1;

  return (
    <div className="kv-picker" ref={root}>
      <input
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (catalog?.ok) setOpen(true);
        }}
        onFocus={() => catalog?.ok && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && flat.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && flat[active] ? `${listId}-${active}` : undefined}
      />
      {open && catalog?.ok && (
        <div className="kv-picker-list" role="listbox" id={listId} aria-label="Models">
          {flat.length === 0 && <p className="kv-picker-empty">No model matches “{value}”. You can still save what you typed.</p>}
          {groups.map((g) => (
            <div key={g.label} role="group" aria-label={g.label}>
              <p className="kv-picker-group">{g.label}</p>
              {g.models.map((m) => {
                index += 1;
                const i = index;
                const price = formatPrice(m);
                const ctx = formatContext(m);
                return (
                  <div
                    key={m.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className="kv-picker-option"
                    data-active={i === active || undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(m)}
                    onMouseEnter={() => setActive(i)}
                  >
                    <span className="kv-picker-id">{m.id}</span>
                    <span className="kv-picker-meta">
                      {m.name !== m.id && <span>{m.name}</span>}
                      {ctx && <span>{ctx}</span>}
                      {price && <span>{price}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {status && <p className="kv-hint" role="status">{status}</p>}
      {current && catalog?.ok && (formatContext(current) || formatPrice(current)) && (
        <p className="kv-hint">
          {current.name !== current.id ? `${current.name} · ` : ""}
          {[formatContext(current), formatPrice(current)].filter(Boolean).join(" · ")}
          {current.jsonOutput === false ? " · does not support JSON output, which processing needs" : ""}
        </p>
      )}
    </div>
  );
}
