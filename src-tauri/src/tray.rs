//! Plan 5 Task 6 — the tray: the app stays reachable with the window closed, the engine keeps
//! serving the CLI and agents, and Quit is the one way to stop everything.

use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

/// The disabled "Engine: …" line, kept so the supervisor's status can refresh it.
#[derive(Default)]
pub struct Tray {
    engine_line: Mutex<Option<MenuItem<Wry>>>,
}

impl Tray {
    /// Whether the tray exists — closing to the tray without one would leave no way back.
    pub fn available(&self) -> bool {
        self.engine_line
            .lock()
            .map(|l| l.is_some())
            .unwrap_or(false)
    }
}

/// What the tray says for each supervisor state.
pub fn engine_label(state: &str) -> String {
    let words = match state {
        "ready" => "ready",
        "starting" => "starting…",
        "restarting" => "restarting…",
        "gave_up" => "keeps stopping",
        "stopping" => "stopping…",
        _ => "stopped",
    };
    format!("Engine: {words}")
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Builds the tray; on failure (no system tray on this desktop) the app works as before,
/// and closing the window quits instead of hiding it.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open Knowledge Vault").build(app)?;
    let engine = MenuItemBuilder::with_id("engine", engine_label("starting"))
        .enabled(false)
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &engine])
        .separator()
        .item(&quit)
        .build()?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Knowledge Vault")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            // The person's own Quit: asks first while sources are being added (lib.rs, may_quit).
            "quit" => crate::quit_asking(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    *app.state::<Tray>().engine_line.lock().unwrap() = Some(engine);
    Ok(())
}

/// Never holds a lock across `set_text`: in Tauri 2 it hops to the main thread and waits there,
/// so a background thread holding the lock while the main thread waits for the same lock
/// (Quit → stop → the reader thread refreshing) would deadlock. The item is cloned out and
/// the update is queued on the main thread without waiting for it.
pub fn refresh(app: &AppHandle, state: &str) {
    let item = app
        .try_state::<Tray>()
        .and_then(|tray| tray.engine_line.lock().ok().and_then(|line| line.clone()));
    if let Some(item) = item {
        let text = engine_label(state);
        let _ = app.run_on_main_thread(move || {
            let _ = item.set_text(text);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::engine_label;

    #[test]
    fn names_every_supervisor_state() {
        assert_eq!(engine_label("ready"), "Engine: ready");
        assert_eq!(engine_label("restarting"), "Engine: restarting…");
        assert_eq!(engine_label("gave_up"), "Engine: keeps stopping");
        assert_eq!(engine_label("exited"), "Engine: stopped");
    }
}
