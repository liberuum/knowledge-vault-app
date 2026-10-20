/** The app's version must agree in package.json, Cargo.toml, tauri.conf.json and the AppStream metainfo (Plan 6). */
export function checkVersions(versions) {
  const [first, ...rest] = Object.entries(versions);
  return rest.filter(([, v]) => v !== first[1]).map(([where, v]) => `${where} says ${v}, ${first[0]} says ${first[1]}`);
}
/** `version = "…"` in Cargo.toml's [package] section. */
export function cargoVersion(text) {
  const pkg = text.split(/^\[/m).find((s) => s.startsWith("package]")) ?? "";
  return /^version\s*=\s*"([^"]+)"/m.exec(pkg)?.[1];
}
/**
 * The newest release in an AppStream metainfo: the first `<release>` of `<releases>`, which software
 * centres and AppImage managers show as the app's version.
 */
export function metainfoVersion(text) {
  const releases = /<releases>([\s\S]*?)<\/releases>/.exec(text)?.[1] ?? "";
  return /<release\b[^>]*\bversion="([^"]+)"/.exec(releases)?.[1];
}
