mod backoff;
mod config;
mod download;
mod drop_capture;
mod engine_archive;
mod host_server;
mod log_tail;
mod navigation;
mod proc_tree;
mod sidecar;
mod smoke;
mod tray;
pub mod webkit_env;

use config::{
    AppPaths, DEFAULT_PORTS, Ports, SidecarLaunch, UiConfig, new_control_token,
    pick_free_port_excluding,
};
use sidecar::{ReadyInfo, SidecarState, sidecar_info, spawn_sidecar, stop_sidecar_blocking};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// The engine's data directory, known once the engine is spawned or adopted (open_logs, reveal_path, close-to-tray).
#[derive(Default)]
struct DataDir(Mutex<Option<PathBuf>>);

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.state::<DataDir>().0.lock().ok()?.clone()
}

/// Stop the engine (waiting for its graceful stop), then exit — the tray's Quit, a close that
/// quits. Off the main thread: the window keeps painting "stopping", and the main thread stays
/// free for the tray and the event loop while the engine flushes its store.
pub(crate) fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        stop_sidecar_blocking(&app);
        app.exit(0);
    });
}

/// The host page reached the shell over IPC (it calls this once at boot): the smoke check's proof
/// that the window loaded and its capability works.
#[tauri::command]
fn host_loaded(state: tauri::State<'_, smoke::HostLoaded>) {
    if !state.0.swap(true, std::sync::atomic::Ordering::SeqCst) {
        println!("[shell] the page loaded and reached the shell over IPC");
    }
}

/// "Try again" after the engine kept stopping or refused to start.
#[tauri::command]
fn retry_engine(app: AppHandle) -> Result<(), String> {
    sidecar::retry_sidecar(&app)
}

/// Open the engine's logs folder in the file manager.
#[tauri::command]
fn open_logs(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)
        .ok_or("The engine's data folder is not known yet.")?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

/// Show a file the app wrote (an export, a backup) in the file manager — only inside the data folder.
#[tauri::command]
fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    // The app's data folder (exports, backups) and the Downloads folder (what the page saved).
    let roots: Vec<PathBuf> = [data_dir(&app), app.path().download_dir().ok()]
        .into_iter()
        .flatten()
        .filter_map(|r| r.canonicalize().ok())
        .collect();
    if !roots.iter().any(|r| target.starts_with(r)) {
        return Err("Only files the app saved can be shown.".into());
    }
    tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    quit(&app);
}

/// Whether the shell may move its working directory to the user's home: not inside an AppImage,
/// whose bundled WebKit resolves its helper processes against the working directory.
fn moves_to_home(appimage: Option<&std::ffi::OsStr>, appdir: Option<&std::ffi::OsStr>) -> bool {
    appimage.is_none() && appdir.is_none()
}

pub fn run() {
    // Plan 6: an installed app (a release build) serves its host itself over loopback (host_server.rs)
    // and runs the engine it bundles. In development Vite serves the host on 4200 and the engine
    // comes from the repository.
    let packaged = !tauri::is_dev();
    // Development finds the repository from the launch directory (src-tauri/) — before it changes.
    let repo_dir = if packaged {
        None
    } else {
        std::env::current_dir()
            .ok()
            .and_then(|d| d.join("..").canonicalize().ok())
    };
    // A web page's file chooser opens in the process's working directory: start in the user's
    // home, never the app's own folder (src-tauri/ in development, /usr/bin for the .deb). Not
    // inside an AppImage: its WebKit finds its helper processes relative to the working directory
    // (`././/lib/webkit2gtk-4.1/…`) and aborts at start without it; there the file dialog comes
    // from the desktop's portal (webkit_env.rs), a process of its own that opens in the user's home anyway.
    if moves_to_home(
        std::env::var_os("APPIMAGE").as_deref(),
        std::env::var_os("APPDIR").as_deref(),
    ) && let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    {
        let _ = std::env::set_current_dir(home);
    }
    // Linux: GTK_USE_PORTAL (the desktop's own file dialog) is set in main(), see webkit_env.rs.
    let builder = tauri::Builder::default()
        // First: a second launch hands over to this one and exits (spec §9 — one engine per store).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }));
    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(SidecarState::default()))
        .manage(DataDir::default())
        .manage(tray::Tray::default())
        .plugin(tauri_plugin_dialog::init())
        .manage(download::Downloads::default())
        .manage(smoke::HostLoaded::default())
        .manage(std::sync::Arc::new(drop_capture::DropCapture::default()))
        .invoke_handler(tauri::generate_handler![
            sidecar_info,
            open_logs,
            reveal_path,
            quit_app,
            retry_engine,
            host_loaded,
            take_dropped_paths
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            // SIGTERM (a session logout, `kill`), SIGINT and SIGHUP take the graceful path the tray's
            // Quit takes — stop the engine and its workers, then exit — instead of ending the shell at
            // once and leaving the engine to notice on its own.
            #[cfg(unix)]
            {
                use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
                let on_signal = handle.clone();
                match signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) {
                    Ok(mut signals) => {
                        std::thread::spawn(move || {
                            if let Some(sig) = signals.forever().next() {
                                eprintln!("[shell] signal {sig}: stopping the engine, then quitting");
                                quit(&on_signal);
                            }
                        });
                    }
                    Err(e) => eprintln!("[shell] could not watch for SIGTERM ({e}); a kill ends the shell at once"),
                }
            }
            if let Err(e) = tray::build(&handle) {
                eprintln!("[shell] no system tray ({e}); closing the window will quit the app");
            }
            // The host page: bound before the window exists, so the window never loads a port
            // someone else holds and a busy port is never a blank window (review I3). The port is
            // remembered: the page's origin holds its storage (theme, layouts — review I4).
            let host_port = if packaged {
                let port_file = app.path().app_data_dir()?.join("host-port");
                let (listener, port) = host_server::bind(
                    host_server::read_port(&port_file),
                    host_server::DEFAULT_HOST_PORT,
                )?;
                host_server::write_port(&port_file, port);
                let assets = app.asset_resolver();
                std::thread::spawn(move || host_server::serve(listener, port, assets));
                // The window's permissions, for this exact origin only (never 127.0.0.1:*).
                app.add_capability(host_server::loopback_capability(
                    include_str!("../capabilities/default.json"),
                    port,
                ))?;
                port
            } else {
                DEFAULT_PORTS.host
            };
            // The window is built here rather than declared in tauri.conf.json so it can carry
            // the navigation guard (spec §5.8): external pages go to the system browser.
            let url = if packaged {
                tauri::WebviewUrl::External(
                    format!("http://127.0.0.1:{host_port}")
                        .parse()
                        .expect("a loopback URL"),
                )
            } else {
                tauri::WebviewUrl::default()
            };
            let window = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("Knowledge Vault")
                .inner_size(1280.0, 820.0)
                .min_inner_size(MIN_WINDOW.0, MIN_WINDOW.1)
                .disable_drag_drop_handler()
                // A hidden or minimised window keeps running its page: a document batch converts
                // in the background while the user is in another window, or after closing to the
                // tray. macOS 14+ honours this (WebKit suspends a hidden view by default); Linux and
                // Windows ignore it, and the page holds a Web Lock while it has work instead.
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .on_download(|webview, event| {
                    use tauri::webview::DownloadEvent;
                    let app = webview.app_handle();
                    match event {
                        DownloadEvent::Requested { url, destination } => {
                            // Written to a staging folder first; where it goes is the user's choice once it is complete.
                            let name = download::file_name_for(destination, &url);
                            let root = app
                                .path()
                                .app_cache_dir()
                                .unwrap_or_else(|_| std::env::temp_dir());
                            let staged = download::staging_path(&root, &name);
                            app.state::<download::Downloads>().0.lock().unwrap().insert(
                                url.to_string(),
                                download::Staged {
                                    path: staged.clone(),
                                    name,
                                },
                            );
                            *destination = staged;
                            true
                        }
                        DownloadEvent::Finished { url, path, success } => {
                            let staged = app
                                .state::<download::Downloads>()
                                .0
                                .lock()
                                .unwrap()
                                .remove(&url.to_string());
                            let Some(staged) = staged else {
                                return true;
                            };
                            let written = path.unwrap_or_else(|| staged.path.clone());
                            if !success {
                                let _ = std::fs::remove_file(&written);
                                let _ = app.emit(
                                    "download:finished",
                                    serde_json::json!({ "success": false, "path": null }),
                                );
                                return true;
                            }
                            // The desktop's own Save dialog (the portal on Linux), starting in Downloads.
                            let mut dialog = app.dialog().file().set_file_name(&staged.name);
                            if let Ok(dir) = app.path().download_dir().or_else(|_| app.path().home_dir()) {
                                dialog = dialog.set_directory(dir);
                            }
                            let app = app.clone();
                            dialog.save_file(move |choice| {
                                let outcome = match choice.and_then(|p| p.into_path().ok()) {
                                    Some(dest) => match download::move_file(&written, &dest) {
                                        Ok(()) => serde_json::json!({ "success": true, "path": dest.to_string_lossy() }),
                                        Err(_) => serde_json::json!({ "success": false, "path": null }),
                                    },
                                    None => {
                                        let _ = std::fs::remove_file(&written);
                                        serde_json::json!({ "success": true, "cancelled": true, "path": null })
                                    }
                                };
                                let _ = app.emit("download:finished", outcome);
                            });
                            true
                        }
                        _ => true,
                    }
                })
                .on_navigation(move |url| {
                    if navigation::is_internal(url, host_port, packaged) {
                        return true;
                    }
                    match navigation::external_target(url) {
                        Some(target) => {
                            if let Err(e) = tauri_plugin_opener::open_url(target, None::<&str>) {
                                eprintln!("[shell] could not open {target} in the browser: {e}");
                            }
                        }
                        None => eprintln!("[shell] refused navigation to {url}"),
                    }
                    false
                })
                .build()?;
            // Linux: WebKitGTK shows a page only the first file of a drop; the shell keeps the whole list.
            #[cfg(target_os = "linux")]
            drop_capture::watch(
                &window,
                app.state::<std::sync::Arc<drop_capture::DropCapture>>().inner().clone(),
            )?;
            #[cfg(not(target_os = "linux"))]
            let _ = window;
            // Dev loop (scripts/dev.mjs) already runs a sidecar: adopt it instead of spawning another.
            // Never in an installed app: its engine is its own (review minor 6).
            if let (false, Ok(p), Ok(c), Ok(t)) = (
                packaged,
                std::env::var("KV_DEV_SIDECAR_PORT"),
                std::env::var("KV_DEV_CONTROL_PORT"),
                std::env::var("KV_DEV_CONTROL_TOKEN"),
            ) {
                let port: u16 = p
                    .parse()
                    .map_err(|_| format!("KV_DEV_SIDECAR_PORT is not a port: {p}"))?;
                let control_port: u16 = c
                    .parse()
                    .map_err(|_| format!("KV_DEV_CONTROL_PORT is not a port: {c}"))?;
                let info = ReadyInfo {
                    port,
                    control_port,
                    control_token: t,
                };
                app.state::<Mutex<SidecarState>>().lock().unwrap().ready = Some(info);
                if let Ok(dir) = std::env::var("KV_DEV_DATA_DIR") {
                    *app.state::<DataDir>().0.lock().unwrap() = Some(PathBuf::from(dir));
                }
                tray::refresh(&handle, "ready");
                return Ok(());
            }
            // Spec §3.3: the engine owns `<app-data>/vault/`. The webview keeps its own profile
            // (CacheStorage, databases, hsts-storage.sqlite, …) in the app-data root, so the two never mix.
            let data_dir = app.path().app_data_dir()?.join("vault");
            std::fs::create_dir_all(&data_dir)?;
            *app.state::<DataDir>().0.lock().unwrap() = Some(data_dir.clone());
            let repo_dir = match (&repo_dir, packaged) {
                (_, true) => PathBuf::new(),
                (Some(dir), false) => dir.clone(),
                (None, false) => {
                    return Err("could not find the repository from the launch directory".into());
                }
            };
            let resource_dir = app.path().resource_dir()?;
            let archive = packaged
                .then(|| engine_archive::archived_engine(&resource_dir))
                .flatten();
            let sidecar = SidecarLaunch::for_build(packaged, &resource_dir, &repo_dir);
            let paths = AppPaths { data_dir, sidecar };
            let ports = Ports {
                host: host_port,
                // Picked apart from each other and from the host page (review minor 2).
                sidecar: pick_free_port_excluding(DEFAULT_PORTS.sidecar, &[host_port]),
                control: pick_free_port_excluding(
                    DEFAULT_PORTS.control,
                    &[
                        host_port,
                        pick_free_port_excluding(DEFAULT_PORTS.sidecar, &[host_port]),
                    ],
                ),
            };
            if let Some(archive) = archive {
                // Windows ships the engine as one archive (the installer's 260-character path limit): it is
                // unpacked once per version, off the main thread, while the page shows the engine starting.
                let base = app.path().app_local_data_dir()?.join("engine");
                sidecar::mark_preparing(&handle);
                let h = handle.clone();
                std::thread::spawn(move || {
                    match engine_archive::unpack(&archive, &base, env!("CARGO_PKG_VERSION")) {
                        Ok(root) => {
                            let paths = AppPaths {
                                data_dir: paths.data_dir,
                                sidecar: SidecarLaunch::at(root),
                            };
                            // The spawn ends the unpack's "preparing" itself (or report_fatal does).
                            if let Err(e) = spawn_sidecar(
                                &h,
                                &paths,
                                ports,
                                new_control_token(),
                                env!("CARGO_PKG_VERSION"),
                            ) {
                                sidecar::report_fatal(&h, "engine-start", e.to_string());
                            }
                        }
                        Err(e) => sidecar::report_fatal(
                            &h,
                            "engine-unpack",
                            format!(
                                "The engine could not be unpacked into {}: {e}",
                                base.display()
                            ),
                        ),
                    }
                });
            } else {
                spawn_sidecar(
                    &handle,
                    &paths,
                    ports,
                    new_control_token(),
                    env!("CARGO_PKG_VERSION"),
                )?;
            }
            if std::env::var("KV_SMOKE").as_deref() == Ok("1") {
                let h = handle.clone();
                std::thread::spawn(move || smoke::watch(h, host_port));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                // Plan 5: with a tray, closing hides the window and the engine keeps serving
                // tools; read at every close, so the Appearance switch applies at once.
                let keep = app.state::<tray::Tray>().available()
                    && data_dir(app)
                        .map(|d| UiConfig::load(&d.join("config.json")).close_to_tray)
                        .unwrap_or(true);
                api.prevent_close();
                if keep {
                    let _ = window.hide();
                } else {
                    // Wait for the engine before exiting: the process must not end while it flushes.
                    quit(app);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Knowledge Vault shell")
        .run(|app, event| {
            // ExitRequested fires when the last window closes or app.exit() runs. macOS Cmd+Q goes
            // through NSApp terminate: and arrives only as RunEvent::Exit — so both stop the engine
            // (idempotent: the second call finds no child).
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                stop_sidecar_blocking(app);
            }
        });
}

/// The smallest the window may be. Small enough for a half-width tile in a tiling window manager:
/// a minimum larger than the tile makes the compositor squeeze the window, and the pointer then
/// lands beside what it hovers (Hyprland at 1.6 scale, a ~950-pixel tile, under the old 960).
const MIN_WINDOW: (f64, f64) = (480.0, 480.0);

#[cfg(test)]
mod window_size_tests {
    use super::MIN_WINDOW;

    /// A tiling window manager (Hyprland, Sway, i3) squeezes a window it cannot shrink, and the
    /// pointer then misses what it hovers. The minimum must fit a half-width tile of a 1920-wide
    /// display at 150 % scaling (640 logical pixels, minus borders and gaps) and a short tile.
    #[test]
    fn the_minimum_fits_a_half_width_tile() {
        assert!(
            MIN_WINDOW.0 <= 600.0,
            "minimum width {} is wider than a half tile",
            MIN_WINDOW.0
        );
        assert!(
            MIN_WINDOW.1 <= 500.0,
            "minimum height {} is taller than a short tile",
            MIN_WINDOW.1
        );
    }
}

#[cfg(test)]
mod working_dir_tests {
    use super::moves_to_home;
    use std::ffi::OsStr;

    #[test]
    fn stays_put_inside_an_appimage_and_moves_home_otherwise() {
        assert!(moves_to_home(None, None));
        assert!(!moves_to_home(
            Some(OsStr::new("/home/u/Knowledge Vault.AppImage")),
            Some(OsStr::new("/tmp/.mount_x"))
        ));
        assert!(!moves_to_home(
            None,
            Some(OsStr::new("/home/u/squashfs-root"))
        ));
    }
}

/// The files of the last Linux drop, which WebKitGTK shows the page only the first of (drop_capture.rs).
/// Empty on Windows and macOS, whose pages get the files themselves.
#[tauri::command]
fn take_dropped_paths(
    capture: tauri::State<'_, std::sync::Arc<drop_capture::DropCapture>>,
) -> Vec<String> {
    capture.take()
}

#[cfg(test)]
mod capability_tests {
    /// Every command the shell registers must be granted to the page, or the installed app's page
    /// (a remote origin to Tauri) cannot call it. Keep in step with build.rs and generate_handler!.
    #[test]
    fn the_capability_grants_every_app_command() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let granted: Vec<&str> = caps["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        for cmd in [
            "sidecar_info",
            "open_logs",
            "reveal_path",
            "quit_app",
            "retry_engine",
            "host_loaded",
            "take_dropped_paths",
        ] {
            let perm = format!("allow-{}", cmd.replace('_', "-"));
            assert!(
                granted.contains(&perm.as_str()),
                "capabilities/default.json does not grant {perm}"
            );
        }
    }
}
