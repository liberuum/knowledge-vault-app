import { useEffect, useId, useRef, type ReactNode } from "react";

/** A modal on the native <dialog>: Escape closes (via `cancel`), focus is trapped by the browser. */
export function Dialog({ open, title, onClose, children, kind = "default" }: { open: boolean; title: string; onClose: () => void; children: ReactNode; kind?: "default" | "danger" }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      // showModal() moves focus to the first focusable element, after a child's autoFocus already ran;
      // a field marked data-autofocus (the one the dialog is about) gets it back.
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="kv-dialog"
      data-kind={kind}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose(); // the browser closed it itself (a second Escape); keep React's state in step
      }}
    >
      {open && (
        <div className="kv-dialog-body">
          <h2 id={titleId} className="kv-dialog-title">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
