/// The app's own commands. Declared here so Tauri generates an `allow-<command>` permission for each;
/// capabilities/default.json grants them. The installed app's page is served over http (a remote origin
/// to Tauri), and a remote page reaches no custom command unless a capability grants it.
const COMMANDS: &[&str] = &[
    "sidecar_info",
    "open_logs",
    "reveal_path",
    "quit_app",
    "install_update",
    "retry_engine",
    "host_loaded",
    "take_dropped_paths",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
