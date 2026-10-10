//! Linux: environment defaults for GTK and WebKitGTK, set in main() before any thread starts. A value the
//! user set is always kept.
//!
//! - WEBKIT_DISABLE_DMABUF_RENDERER=1, only where WebKit's DMA-BUF (GPU) renderer cannot work. It needs a
//!   GPU OpenGL ES stack: without one (virtual machines, a CI's virtual display) the web process aborts —
//!   "Couldn't open libGLESv2.so.2" — and the window stays blank; NVIDIA's proprietary driver shows a
//!   blank or garbled page with it. There the shared-memory renderer is used, which works everywhere but
//!   copies every frame through the CPU: on a machine whose GPU has the stack it makes scrolling visibly
//!   slower (a HiDPI window most of all), so everywhere else WebKit keeps its own renderer.
//! - GTK_USE_PORTAL=1, only in a desktop session (XDG_CURRENT_DESKTOP set): a page's file chooser is the
//!   desktop's own dialog (xdg-desktop-portal). Outside one — GitHub's runner: a session bus and the
//!   portal installed, no desktop behind it — GTK's start-up calls to the portal wait on it and the page
//!   never loads; there GTK's built-in chooser is used.

/// What this machine offers WebKit's DMA-BUF renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gpu {
    /// A DRM render node (`/dev/dri/renderD*`): none on a virtual display, nor in most virtual machines.
    pub render_node: bool,
    /// `libGLESv2.so.2` loads.
    pub gles: bool,
    /// NVIDIA's proprietary driver is loaded (`/proc/driver/nvidia`).
    pub nvidia_proprietary: bool,
}

impl Gpu {
    pub fn dmabuf_works(&self) -> bool {
        self.render_node && self.gles && !self.nvidia_proprietary
    }

    /// Looks at this machine: three cheap checks, run once in main().
    #[cfg(target_os = "linux")]
    pub fn probe() -> Self {
        let render_node = std::fs::read_dir("/dev/dri")
            .map(|dir| {
                dir.flatten()
                    .any(|e| e.file_name().to_string_lossy().starts_with("renderD"))
            })
            .unwrap_or(false);
        Self {
            render_node,
            gles: gles_loads(),
            nvidia_proprietary: std::path::Path::new("/proc/driver/nvidia").exists(),
        }
    }

    /// Only Linux has the choice; elsewhere nothing is probed.
    #[cfg(not(target_os = "linux"))]
    pub fn probe() -> Self {
        Self { render_node: true, gles: true, nvidia_proprietary: false }
    }
}

/// Whether the library WebKit's GPU renderer opens can be loaded — the exact failure of a machine without it.
#[cfg(target_os = "linux")]
fn gles_loads() -> bool {
    // SAFETY: a NUL-terminated name, a handle closed at once; called from main() before any thread exists.
    unsafe {
        let handle = libc::dlopen(c"libGLESv2.so.2".as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
        if handle.is_null() {
            return false;
        }
        libc::dlclose(handle);
        true
    }
}

/// The variables to set, given what the environment holds. `gpu` is asked only when the choice is ours.
pub fn defaults(
    get: impl Fn(&str) -> Option<String>,
    gpu: impl FnOnce() -> Gpu,
) -> Vec<(&'static str, &'static str)> {
    let mut out = Vec::new();
    if !cfg!(target_os = "linux") {
        return out;
    }
    if get("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && !gpu().dmabuf_works() {
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
    use super::{defaults, Gpu};

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            vars.iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    const GPU: Gpu = Gpu { render_node: true, gles: true, nvidia_proprietary: false };
    const NO_GPU: Gpu = Gpu { render_node: false, gles: false, nvidia_proprietary: false };

    #[test]
    #[cfg(target_os = "linux")]
    fn a_desktop_with_a_gpu_keeps_webkits_renderer_and_gets_the_portal() {
        assert_eq!(
            defaults(env(&[("XDG_CURRENT_DESKTOP", "Hyprland")]), || GPU),
            vec![("GTK_USE_PORTAL", "1")]
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn the_shared_memory_renderer_where_the_gpu_one_cannot_work() {
        let shm = vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")];
        // a virtual display: no render node, no GL ES (the CI case that left the window blank)
        assert_eq!(defaults(env(&[]), || NO_GPU), shm);
        assert_eq!(defaults(env(&[]), || Gpu { render_node: false, ..GPU }), shm);
        assert_eq!(defaults(env(&[]), || Gpu { gles: false, ..GPU }), shm);
        assert_eq!(defaults(env(&[]), || Gpu { nvidia_proprietary: true, ..GPU }), shm);
        assert_eq!(
            defaults(env(&[("XDG_CURRENT_DESKTOP", "GNOME")]), || NO_GPU),
            vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1"), ("GTK_USE_PORTAL", "1")]
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn without_a_desktop_session_gtk_is_left_off_the_portal() {
        assert!(defaults(env(&[]), || GPU).is_empty());
        assert!(defaults(env(&[("XDG_CURRENT_DESKTOP", " ")]), || GPU).is_empty());
    }

    #[test]
    fn values_the_user_set_are_kept_and_the_machine_is_not_probed() {
        let set = [
            ("XDG_CURRENT_DESKTOP", "GNOME"),
            ("GTK_USE_PORTAL", "0"),
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "0"),
        ];
        assert!(defaults(env(&set), || panic!("probed although the user chose")).is_empty());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn the_probe_runs_on_this_machine() {
        // whatever this machine has, probing it must not fail or hang
        let gpu = Gpu::probe();
        assert_eq!(gpu.dmabuf_works(), gpu.render_node && gpu.gles && !gpu.nvidia_proprietary);
    }
}
