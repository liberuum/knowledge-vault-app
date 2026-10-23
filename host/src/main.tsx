import { installHistoryGuard } from "./shell/history-guard.js";
import { installWheelScroll } from "./shell/wheel-scroll.js";
import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted type (spec §2: nothing leaves the machine): Inter for the UI, Source Serif 4 for vault names.
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "@powerhousedao/design-system/style.css";
// Connect's classes, which the design system's components (the document toolbar, revision
// history, toasts) are styled with. Until Powerhouse 6.2.3-dev.70 the vault package's
// stylesheet carried a copy; since then a package's stylesheet holds only its own classes,
// so the host loads Connect's, as Connect does. Before the vault's: its layer order comes first.
import "@powerhousedao/connect/style.css";
import "@powerhousedao/knowledge-note/style.css";
import "@powerhousedao/workflow/style.css";
import "./host.css";
import { Boot } from "./boot.js";

// Nothing imported here touches the vault package: Boot shows the engine's state
// at once, declares the host when the engine is ready, and only then loads App.
// Before anything renders: the vault app's library writes Connect's path URLs; the shell's hash route stays authoritative.
installHistoryGuard();
// Linux desktop: a fast wheel moves the page its full distance (shell/wheel-scroll.ts).
installWheelScroll();
createRoot(document.getElementById("root")!).render(createElement(StrictMode, null, createElement(Boot)));
