//! The files of a Linux drop, as GTK hands them to the window.
//!
//! WebKitGTK leaves a page's `text/uri-list` empty for files dragged from a file manager and shows only the
//! first file's address (in a generated `text/html` link), so a drop of several files reaches the page as one.
//! GTK delivers the drop's complete list to the window before WebKit reads it; the shell keeps it and the page
//! takes it on its drop event (`take_dropped_paths`). Windows and macOS hand pages real files: nothing to do.
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A list older than this belongs to a drag that ended elsewhere; it is never handed to a later drop.
const FRESH: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct DropCapture(Mutex<Option<(Instant, Vec<String>)>>);

impl DropCapture {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn store(&self, uris: Vec<String>) {
        if !uris.is_empty() {
            *self.0.lock().unwrap() = Some((Instant::now(), uris));
        }
    }

    /// The last drop's addresses while they are fresh, once: taking them clears them.
    pub fn take(&self) -> Vec<String> {
        self.take_at(Instant::now())
    }

    fn take_at(&self, now: Instant) -> Vec<String> {
        match self.0.lock().unwrap().take() {
            Some((at, uris)) if now.saturating_duration_since(at) <= FRESH => uris,
            _ => Vec::new(),
        }
    }
}

/// Keeps every URI list GTK delivers to the window. `drag-data-received` runs its handlers before WebKit's own
/// (the signal runs last), so the list is stored before the page's drop event fires.
#[cfg(target_os = "linux")]
pub fn watch(
    window: &tauri::WebviewWindow,
    capture: std::sync::Arc<DropCapture>,
) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        use gtk::prelude::WidgetExt;
        webview
            .inner()
            .connect_drag_data_received(move |_, _, _, _, data, _, _| {
                capture.store(data.uris().iter().map(|uri| uri.to_string()).collect());
            });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hands_a_drop_over_once_and_never_a_stale_one() {
        let capture = DropCapture::default();
        capture.store(vec!["file:///a.pdf".into(), "file:///b.pdf".into()]);
        assert_eq!(capture.take(), vec!["file:///a.pdf", "file:///b.pdf"]);
        assert!(capture.take().is_empty(), "taken once");
        capture.store(vec!["file:///old.pdf".into()]);
        assert!(
            capture
                .take_at(Instant::now() + FRESH + Duration::from_secs(1))
                .is_empty(),
            "a stale drop is dropped"
        );
    }
}
