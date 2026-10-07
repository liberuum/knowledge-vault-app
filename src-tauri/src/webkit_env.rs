//! Linux: environment defaults for GTK and WebKitGTK, set in main() before any thread starts. A value the
//! user set is always kept.
//!
//! - WEBKIT_DISABLE_DMABUF_RENDERER=1: the DMA-BUF renderer needs a GPU OpenGL ES stack; without one
//!   (virtual machines, a CI's virtual display, some NVIDIA drivers) the web process aborts — "Couldn't
//!   open libGLESv2.so.2" — and the window stays blank. The shared-memory renderer works everywhere.
//! - GTK_USE_PORTAL=1, only in a desktop session (XDG_CURRENT_DESKTOP set): a page's file chooser is the
//!   desktop's own dialog (xdg-desktop-portal). Outside one — GitHub's runner: a session bus and the
//!   portal installed, no desktop behind it — GTK's start-up calls to the portal wait on it and the page
//!   never loads; there GTK's built-in chooser is used.

/// The variables to set, given what the environment holds.
pub fn defaults(get: impl Fn(&str) -> Option<String>) -> Vec<(&'static str, &'static str)> {
    let mut out = Vec::new();
    if !cfg!(target_os = "linux") {
        return out;
    }
    if get("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        out.push(("WEBKIT_DISABLE_DMABUF_RENDERER", "1"));
    }
    let desktop = get("XDG_CURRENT_DESKTOP").is_some_and(|d| !d.trim().is_empty());
    if desktop && get("GTK_USE_PORTAL").is_none() {
        out.push(("GTK_USE_PORTAL", "1"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::defaults;

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            vars.iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn a_desktop_session_gets_the_portal_and_the_shared_memory_renderer() {
        assert_eq!(
            defaults(env(&[("XDG_CURRENT_DESKTOP", "Hyprland")])),
            vec![
                ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
                ("GTK_USE_PORTAL", "1")
            ]
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn without_a_desktop_session_gtk_is_left_off_the_portal() {
        assert_eq!(
            defaults(env(&[])),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
        assert_eq!(
            defaults(env(&[("XDG_CURRENT_DESKTOP", " ")])),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
    }

    #[test]
    fn values_the_user_set_are_kept() {
        let set = [
            ("XDG_CURRENT_DESKTOP", "GNOME"),
            ("GTK_USE_PORTAL", "0"),
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "0"),
        ];
        assert!(defaults(env(&set)).is_empty());
    }
}
