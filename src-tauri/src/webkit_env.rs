//! Linux: WebKitGTK's DMA-BUF renderer needs a working GPU OpenGL ES stack. Without one (virtual
//! machines, CI's virtual display, some NVIDIA drivers) the web process aborts — "Couldn't open
//! libGLESv2.so.2" — and the window stays blank. The shared-memory renderer works everywhere, so it is
//! the default; a user who sets WEBKIT_DISABLE_DMABUF_RENDERER themselves keeps their value.

/// The variables to set before the first window, given what the environment already holds.
pub fn defaults(is_set: impl Fn(&str) -> bool) -> Vec<(&'static str, &'static str)> {
    if cfg!(target_os = "linux") && !is_set("WEBKIT_DISABLE_DMABUF_RENDERER") {
        vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::defaults;

    #[test]
    #[cfg(target_os = "linux")]
    fn linux_turns_the_dmabuf_renderer_off_by_default() {
        assert_eq!(
            defaults(|_| false),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
    }

    #[test]
    fn a_value_the_user_set_is_kept() {
        assert!(defaults(|k| k == "WEBKIT_DISABLE_DMABUF_RENDERER").is_empty());
    }
}
