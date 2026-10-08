import { useCallback, useEffect, useState } from "react";
import { ONBOARDING_STEPS, type OnboardingStep } from "../onboarding/onboarding-state.js";

/**
 * Hash routes: a desktop webview reloads at the app's root, so a path-based
 * history would 404 on reload in production; the hash is invisible to the user.
 */
export const SETTINGS_SECTIONS = ["vaults", "appearance", "models", "conversion", "workflows", "diagnostics", "about", "identity"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type Route =
  | { name: "vaults"; newVault?: boolean }
  | { name: "vault"; id: string }
  | { name: "remote"; id: string }
  /** Workflow Studio; `workflow` opens one workflow's live view (Studio keeps its selection in the fragment as `#<id>`). */
  | { name: "workflows"; workflow?: string }
  | { name: "settings"; section: SettingsSection }
  /** The setup guide (spec §5); `vault` is the vault it created, for the sources step. */
  | { name: "welcome"; step?: OnboardingStep; vault?: string };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart = "", query = ""] = raw.split("?");
  // Workflow Studio's own fragment: a bare document id selects that workflow (so a reload keeps it).
  if (pathPart && !pathPart.startsWith("/") && /^[A-Za-z0-9_-]+$/.test(pathPart)) return { name: "workflows", workflow: pathPart };
  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length === 0) return new URLSearchParams(query).get("new") === "1" ? { name: "vaults", newVault: true } : { name: "vaults" };
  if (segments[0] === "vault" && segments[1]) return { name: "vault", id: decodeURIComponent(segments[1]) };
  if (segments[0] === "remote" && segments[1]) return { name: "remote", id: decodeURIComponent(segments[1]) };
  if (segments[0] === "workflows") return { name: "workflows" };
  if (segments[0] === "welcome") {
    const step = (ONBOARDING_STEPS as readonly string[]).includes(segments[1] ?? "") ? (segments[1] as OnboardingStep) : "welcome";
    return segments[2] ? { name: "welcome", step, vault: decodeURIComponent(segments[2]) } : { name: "welcome", step };
  }
  if (segments[0] === "settings") {
    const section = segments[1];
    return { name: "settings", section: (SETTINGS_SECTIONS as readonly string[]).includes(section ?? "") ? (section as SettingsSection) : "vaults" };
  }
  return { name: "vaults" };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case "vaults":
      return route.newVault ? "#/?new=1" : "#/";
    case "vault":
      return `#/vault/${encodeURIComponent(route.id)}`;
    case "remote":
      return `#/remote/${encodeURIComponent(route.id)}`;
    case "workflows":
      return route.workflow ? `#${route.workflow}` : "#/workflows";
    case "settings":
      return `#/settings/${route.section}`;
    case "welcome":
      return `#/welcome/${route.step ?? "welcome"}${route.vault ? `/${encodeURIComponent(route.vault)}` : ""}`;
  }
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(typeof window === "undefined" ? "" : window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route) => {
    const hash = routeHash(next);
    if (window.location.hash === hash) setRoute(next);
    else window.location.hash = hash;
  }, []);
  return [route, navigate];
}
