import type { VaultView } from "./OverviewStep.js";

/** The overview's cards, each with its view's mark (Vision: a shape to find before the words are read). */
export function CardIcon({ view }: { view: VaultView | "runs" }) {
  const p = { viewBox: "0 0 24 24", width: 20, height: 20, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (view) {
    case "chat":
      return (
        <svg {...p}>
          <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
          <path d="M8 10h8M8 13h5" />
        </svg>
      );
    case "notes":
      return (
        <svg {...p}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5M9 13h6M9 17h4" />
        </svg>
      );
    case "graph":
      return (
        <svg {...p}>
          <circle cx="6" cy="7" r="2.2" />
          <circle cx="18" cy="6" r="2.2" />
          <circle cx="12" cy="17" r="2.2" />
          <path d="M8 8l8.2-1.6M7.2 9l3.8 6M16.9 8l-3.6 7" />
        </svg>
      );
    case "search":
      return (
        <svg {...p}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M20 20l-4.2-4.2" />
        </svg>
      );
    case "sources":
      return (
        <svg {...p}>
          <path d="M12 16V4M7.5 8.5L12 4l4.5 4.5" />
          <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
        </svg>
      );
    case "runs":
      return (
        <svg {...p}>
          <rect x="3" y="3" width="6" height="6" rx="1.5" />
          <rect x="15" y="15" width="6" height="6" rx="1.5" />
          <rect x="15" y="3" width="6" height="6" rx="1.5" />
          <path d="M9 6h6M6 9v6a3 3 0 0 0 3 3h6" />
        </svg>
      );
  }
}
