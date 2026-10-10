import { useEffect, useId, useMemo, useRef, useState } from "react";
import { defaultModel, filterModels, fitForProcessing, formatContext, formatPrice, freeModels, offerableModels, recommendedModels, type CatalogModel } from "./model-picker.js";

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
  /** A key was just entered and is about to be asked: show the list as on its way, not as missing. */
  pending?: boolean;
  /**
   * When the key's list arrives and no model it offers is chosen, choose the best fit for the
   * user (defaultModel) — no click needed; they pick another only if they want to.
   */
  autoChoose?: boolean;
};

type Group = { label: string; models: CatalogModel[] };

/**
 * The model field: free text, plus a searchable list of the models the saved key gives access to.
 * Grouped as "Recommended for processing" (what the pipeline needs, cheapest first), "Free" and
 * "All models"; typing filters every group; arrows, Enter and Escape work as in a combobox.
 */
export function ModelPicker({ id, value, onChange, disabled, placeholder, hasKey, load, reloadKey, pending = false, autoChoose = false }: Props) {
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  // The model chosen for the user from the last list (shown as such until they pick another).
  const [chosenForYou, setChosenForYou] = useState<string | null>(null);
  const latest = useRef({ value, onChange, autoChoose });
  latest.current = { value, onChange, autoChoose };
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Typing filters the list; opening it by click or focus shows everything, with the current model highlighted.
  const [typed, setTyped] = useState(false);
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
      .then((c) => {
        if (!alive) return;
        setCatalog(c);
        // A key's list arrived: unless the current model is one it offers, choose the best fit.
        const { value: current, onChange: change, autoChoose: auto } = latest.current;
        if (!auto || !c.ok || c.models.some((m) => m.id === current && fitForProcessing(m).ok !== false)) return;
        const pick = defaultModel(c.models);
        if (pick) {
          change(pick.id);
          setChosenForYou(pick.id);
        }
      })
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
    const matching = filterModels(offerableModels(catalog.models, value), typed ? value : "");
    const recommended = recommendedModels(matching);
    const free = freeModels(matching);
    const seen = new Set([...recommended, ...free].map((m) => m.id));
    const rest = matching.filter((m) => !seen.has(m.id));
    const out: Group[] = [];
    if (recommended.length) out.push({ label: "Recommended for processing", models: recommended });
    if (free.length) out.push({ label: "Free", models: free });
    if (rest.length) out.push({ label: recommended.length || free.length ? "All models" : "Models", models: rest.slice(0, 200) });
    return out;
  }, [catalog, value, typed]);
  const flat = useMemo(() => groups.flatMap((g) => g.models), [groups]);

  useEffect(() => {
    const current = typed ? -1 : flat.findIndex((m) => m.id === value);
    setActive(current >= 0 ? current : 0);
  }, [value, open, typed, flat]);

  const choose = (m: CatalogModel) => {
    onChange(m.id);
    setTyped(false);
    setOpen(false);
  };
  const show = () => {
    if (!catalog?.ok) return;
    setTyped(false);
    setOpen(true);
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

  const fetching = pending || (hasKey && loading);
  const status = fetching
    ? "Checking your key and fetching its models…"
    : !hasKey
      ? "Enter your API key to see the models it gives you."
      : catalog && !catalog.ok
        ? `Could not list models: ${catalog.detail}`
        : catalog?.ok
          ? `${offerableModels(catalog.models, "").length} of the ${catalog.models.length} models your key gives you can do the vault's work (text in, JSON out) — type to search, or pick from the list.${catalog.models.some((m) => m.quality !== undefined) ? " Recommended ones are ranked by their quality score." : ""}`
          : null;
  const current = catalog?.ok ? catalog.models.find((m) => m.id === value) : undefined;
  let index = -1;

  return (
    <div className="kv-picker" ref={root}>
      <div className="kv-picker-field">
      <input
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          if (catalog?.ok) setOpen(true);
        }}
        onFocus={show}
        onClick={show}
        onKeyDown={onKeyDown}
        placeholder={fetching ? "Loading the models…" : placeholder}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && flat.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && flat[active] ? `${listId}-${active}` : undefined}
      />
      {catalog?.ok && (
        <button
          type="button"
          className="kv-picker-toggle"
          aria-label={open ? "Hide the models" : "Show the models"}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (open ? setOpen(false) : show())}
          disabled={disabled}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {open && catalog?.ok && (
        <div className="kv-picker-list" role="listbox" id={listId} aria-label="Models">
          {flat.length === 0 && typed && <p className="kv-picker-empty">No model matches “{value}”. You can still save what you typed.</p>}
          {groups.map((g) => (
            <div key={g.label} role="group" aria-label={g.label}>
              <p className="kv-picker-group">{g.label}</p>
              {g.models.map((m) => {
                index += 1;
                const i = index;
                const price = formatPrice(m);
                const ctx = formatContext(m);
                const fit = fitForProcessing(m);
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
                    ref={i === active ? (el) => el?.scrollIntoView?.({ block: "nearest" }) : undefined}
                  >
                    <span className="kv-picker-id">{m.id}</span>
                    <span className="kv-picker-meta">
                      {m.name !== m.id && <span>{m.name}</span>}
                      {ctx && <span>{ctx}</span>}
                      {price && <span>{price}</span>}
                      {fit.ok === true && (
                        <span className="kv-picker-badge" data-kind="ok" title={`Answers in JSON, text only, takes a whole source: the pipeline can use it${m.describedBy === "catalog" ? " (from the model catalog the app ships)" : ""}`}>
                          fits processing
                        </span>
                      )}
                      {fit.ok === false && <span className="kv-picker-badge" data-kind="warn" title="The pipeline would fail with this model">won't work: {fit.reason}</span>}
                      {fit.ok === null && (
                        <span className="kv-picker-badge" data-kind="unknown" title="Nothing describes this model, so the app can't tell whether processing works with it">
                          unchecked
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      </div>
      {status && (
        <p className="kv-hint kv-picker-status" role="status" aria-busy={fetching || undefined}>
          {fetching && <span className="kv-spinner" aria-hidden="true" />}
          {status}
        </p>
      )}
      {chosenForYou !== null && chosenForYou === value && current && (
        <p className="kv-hint kv-picker-chosen">
          Chosen for you: among the models that fit processing, the best one at a fair price. Pick another from the list if you like.
        </p>
      )}
      {current && catalog?.ok && (formatContext(current) || formatPrice(current)) && (
        <p className="kv-hint">
          {current.name !== current.id ? `${current.name} · ` : ""}
          {[formatContext(current), formatPrice(current)].filter(Boolean).join(" · ")}
          {(() => {
            const fit = fitForProcessing(current);
            return fit.ok === false ? ` · not for processing: ${fit.reason}` : fit.ok === true ? " · fits processing" : "";
          })()}
        </p>
      )}
    </div>
  );
}
