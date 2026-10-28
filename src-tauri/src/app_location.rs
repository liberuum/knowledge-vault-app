//! Where the app runs from, and moving it into Applications (macOS).
//!
//! On macOS an update hands the person a disk image to drag onto Applications. Opened straight from
//! the disk image (or from Downloads) instead, the new version upgrades the vaults while the Dock,
//! Launchpad and Spotlight keep starting the old copy in Applications, which then refuses the
//! upgraded vaults ("This store was last opened by a newer Knowledge Vault"). The same happened on
//! Linux before an update learned to replace the AppImage it was started from (update.rs).
//!
//! The shell only says *where* it runs (`KV_APP_LOCATION`). The engine knows whether this start
//! would upgrade the store, and refuses only then (sidecar/src/app-location.ts); the window then
//! offers "Move to Applications" (this module) and "Open from here anyway". Nothing changes for an
//! app that runs from Applications, for any start that does not upgrade the store, or off macOS.
//!
//! The logic is plain Unix so it is built and tested on every platform; only `current()` and
//! `move_into_applications()` act, and only on macOS.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Location {
    /// In Applications, a folder the person chose, or not a bundle at all (Linux, Windows, development).
    Installed,
    /// On a mounted disk image: read-only, gone once it is ejected.
    DiskImage,
    /// A copy macOS made to run a downloaded app from a random path ("App Translocation"), which
    /// happens when a quarantined app is opened where it was downloaded or unpacked.
    Translocated,
    /// In the Downloads folder.
    Downloads,
}

impl Location {
    /// The value the engine receives as `KV_APP_LOCATION`; none for an installed app.
    pub fn env_value(self) -> Option<&'static str> {
        match self {
            Location::Installed => None,
            Location::DiskImage => Some("disk-image"),
            Location::Translocated => Some("translocated"),
            Location::Downloads => Some("downloads"),
        }
    }
}

/// The `.app` bundle an executable belongs to: its nearest ancestor named `*.app`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app")))
        .map(Path::to_path_buf)
}

/// Where a bundle is, from its path alone. A bundle under `/Volumes` counts as a disk image only on a
/// read-only volume, so an app kept on a writable external drive is left alone.
pub fn classify(bundle: &Path, home: Option<&Path>, read_only_volume: bool) -> Location {
    if bundle
        .components()
        .any(|c| c.as_os_str() == "AppTranslocation")
    {
        return Location::Translocated;
    }
    if bundle.starts_with("/Volumes") && read_only_volume {
        return Location::DiskImage;
    }
    if home.is_some_and(|h| bundle.starts_with(h.join("Downloads"))) {
        return Location::Downloads;
    }
    Location::Installed
}

#[cfg(unix)]
fn on_read_only_volume(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: statvfs only writes into the zeroed struct we own; the path is NUL-terminated.
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        libc::statvfs(c_path.as_ptr(), &mut st) == 0 && (st.f_flag & libc::ST_RDONLY) != 0
    }
}
#[cfg(not(unix))]
fn on_read_only_volume(_path: &Path) -> bool {
    false
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Where this app runs from. Only macOS installs by dragging onto Applications; everywhere else the
/// answer is `Installed` and nothing in this module does anything.
pub fn current() -> (Option<PathBuf>, Location) {
    if !cfg!(target_os = "macos") {
        return (None, Location::Installed);
    }
    let Some(bundle) = std::env::current_exe().ok().and_then(|exe| bundle_of(&exe)) else {
        return (None, Location::Installed);
    };
    let location = classify(&bundle, home_dir().as_deref(), on_read_only_volume(&bundle));
    (Some(bundle), location)
}

/// Written just before the moved copy is started. Should that copy still find itself somewhere
/// temporary (macOS translocated it after all), the engine is not held back a second time: today's
/// behaviour is better than a loop of "Move to Applications".
const MOVED_MARKER: &str = "moved-to-applications";
const MOVED_GRACE: Duration = Duration::from_secs(10 * 60);

pub fn note_moved(data_dir: &Path) -> io::Result<()> {
    std::fs::write(data_dir.join(MOVED_MARKER), b"")
}

fn moved_recently(data_dir: &Path, now: SystemTime) -> bool {
    std::fs::metadata(data_dir.join(MOVED_MARKER))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|at| now.duration_since(at).ok())
        .is_some_and(|age| age < MOVED_GRACE)
}

/// The `KV_APP_LOCATION` the engine gets, if any: none once the app runs from Applications (the
/// marker is then spent), after "Open from here anyway", or right after a move (the loop guard).
pub fn engine_hint(
    location: Location,
    data_dir: &Path,
    opened_anyway: bool,
    now: SystemTime,
) -> Option<&'static str> {
    if location == Location::Installed {
        let _ = std::fs::remove_file(data_dir.join(MOVED_MARKER));
        return None;
    }
    if opened_anyway {
        return None;
    }
    if moved_recently(data_dir, now) {
        eprintln!(
            "[shell] the app was just moved but still runs from a temporary place; not asking again"
        );
        return None;
    }
    location.env_value()
}

/// Removes a file, a symlink or a folder.
fn remove_any(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Puts `bundle` into `dir` under its own name, replacing a copy already there. The new copy is made
/// beside it under a hidden name first, so a failed copy leaves the installed app untouched; the old
/// copy is moved aside and deleted only once the new one is in place, and put back if that fails.
pub fn install_bundle(
    bundle: &Path,
    dir: &Path,
    copy: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<PathBuf, String> {
    let name = bundle.file_name().ok_or("the app has no name")?;
    let label = name.to_string_lossy();
    let target = dir.join(name);
    let staging = dir.join(format!(".{label}.moving"));
    let aside = dir.join(format!(".{label}.old"));
    let _ = remove_any(&staging);
    if let Err(e) = copy(bundle, &staging) {
        let _ = remove_any(&staging);
        return Err(format!("could not copy it into {}: {e}", dir.display()));
    }
    let replacing = std::fs::symlink_metadata(&target).is_ok();
    if replacing {
        let _ = remove_any(&aside);
        if let Err(e) = std::fs::rename(&target, &aside) {
            let _ = remove_any(&staging);
            return Err(format!("could not replace {}: {e}", target.display()));
        }
    }
    if let Err(e) = std::fs::rename(&staging, &target) {
        if replacing {
            let _ = std::fs::rename(&aside, &target);
        }
        let _ = remove_any(&staging);
        return Err(format!("could not put it in {}: {e}", dir.display()));
    }
    if replacing && let Err(e) = remove_any(&aside) {
        eprintln!("[shell] the old copy stays at {}: {e}", aside.display());
    }
    Ok(target)
}

/// Moves the app into Applications. The copy the Dock opens is the one to replace, so an existing
/// copy wins: in `/Applications`, else in `~/Applications`. If it cannot be replaced (no permission),
/// that is said, rather than installing a second copy the Dock would never open. With no copy yet, the
/// app goes to `/Applications`, or to `~/Applications` when the person may not write there.
pub fn install_into_applications(
    bundle: &Path,
    system_apps: &Path,
    home: Option<&Path>,
    copy: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<PathBuf, String> {
    let name = bundle.file_name().ok_or("the app has no name")?;
    let user_apps = home.map(|h| h.join("Applications"));
    let existing = std::iter::once(system_apps.to_path_buf())
        .chain(user_apps.clone())
        .find(|dir| std::fs::symlink_metadata(dir.join(name)).is_ok());
    if let Some(dir) = existing {
        return install_bundle(bundle, &dir, copy).map_err(|e| {
            format!("Knowledge Vault {e}. Drag it from the disk image onto Applications in Finder instead; Finder asks for permission if it needs it.")
        });
    }
    match install_bundle(bundle, system_apps, copy) {
        Ok(at) => Ok(at),
        Err(first) => {
            let Some(user_apps) = user_apps else {
                return Err(format!("Knowledge Vault {first}."));
            };
            std::fs::create_dir_all(&user_apps).map_err(|e| {
                format!("Knowledge Vault {first}; and {}: {e}", user_apps.display())
            })?;
            install_bundle(bundle, &user_apps, copy)
                .map_err(|e| format!("Knowledge Vault {first}; and {e}."))
        }
    }
}

/// Copies a bundle the way Finder does (`ditto` keeps symlinks, permissions, extended attributes and
/// the code signature), then lifts the quarantine from the copy: the person has already opened this
/// very app, and a quarantined app moved by anything but Finder is translocated again on its next start.
pub fn ditto(from: &Path, to: &Path) -> io::Result<()> {
    let status = std::process::Command::new("/usr/bin/ditto")
        .arg(from)
        .arg(to)
        .status()?;
    if !status.success() {
        return Err(io::Error::other(format!("ditto exited with {status}")));
    }
    let _ = std::process::Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(to)
        .status();
    Ok(())
}

/// Opens the app at `path` once this process has exited (one instance runs at a time: started at
/// once, the new one would hand itself to this one and quit).
#[cfg(unix)]
pub fn open_after_exit(path: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$0""#)
        .arg(path)
        .arg(std::process::id().to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
#[cfg(not(unix))]
pub fn open_after_exit(_path: &Path) -> Result<(), String> {
    Err("Moving the app is for macOS only.".into())
}

/// The window's "Move to Applications": the copy, the loop guard, then the reopen. Returns where the
/// app now is; the caller quits.
pub fn move_into_applications(data_dir: Option<&Path>) -> Result<PathBuf, String> {
    let (bundle, location) = current();
    let bundle = bundle
        .filter(|_| location != Location::Installed)
        .ok_or("Knowledge Vault already runs from Applications.")?;
    let at = install_into_applications(
        &bundle,
        Path::new("/Applications"),
        home_dir().as_deref(),
        &ditto,
    )?;
    if let Some(dir) = data_dir {
        let _ = note_moved(dir);
    }
    open_after_exit(&at)?;
    Ok(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kv-location-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    /// A tiny bundle: Contents/MacOS/app with the given text.
    fn bundle(at: &Path, text: &str) -> PathBuf {
        let app = at.join("Knowledge Vault.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/app"), text).unwrap();
        app
    }
    fn content(app: &Path) -> String {
        std::fs::read_to_string(app.join("Contents/MacOS/app")).unwrap()
    }
    fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let dest = to.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_tree(&entry.path(), &dest)?;
            } else {
                std::fs::copy(entry.path(), dest)?;
            }
        }
        Ok(())
    }

    #[test]
    fn finds_the_bundle_an_executable_belongs_to() {
        let exe = Path::new(
            "/Volumes/Knowledge Vault/Knowledge Vault.app/Contents/MacOS/knowledge-vault-app",
        );
        assert_eq!(
            bundle_of(exe),
            Some(PathBuf::from(
                "/Volumes/Knowledge Vault/Knowledge Vault.app"
            ))
        );
        assert_eq!(bundle_of(Path::new("/usr/bin/knowledge-vault-app")), None);
    }

    #[test]
    fn tells_the_temporary_places_from_an_installed_app() {
        let home = Path::new("/Users/ana");
        let at = |p: &str, ro: bool| classify(Path::new(p), Some(home), ro);
        assert_eq!(
            at("/Volumes/Knowledge Vault/Knowledge Vault.app", true),
            Location::DiskImage
        );
        // a writable external drive the person keeps apps on is theirs to choose
        assert_eq!(
            at("/Volumes/Work/Apps/Knowledge Vault.app", false),
            Location::Installed
        );
        assert_eq!(
            at(
                "/private/var/folders/x1/abc/T/AppTranslocation/1F2E/d/Knowledge Vault.app",
                true
            ),
            Location::Translocated
        );
        assert_eq!(
            at("/Users/ana/Downloads/Knowledge Vault.app", false),
            Location::Downloads
        );
        assert_eq!(
            at("/Users/ana/Downloads/old/Knowledge Vault.app", false),
            Location::Downloads
        );
        assert_eq!(
            at("/Applications/Knowledge Vault.app", false),
            Location::Installed
        );
        assert_eq!(
            at("/Users/ana/Applications/Knowledge Vault.app", false),
            Location::Installed
        );
        // a folder merely named like Downloads is not the Downloads folder
        assert_eq!(
            at("/Users/ana/Downloads-old/Knowledge Vault.app", false),
            Location::Installed
        );
        assert_eq!(Location::Installed.env_value(), None);
        assert_eq!(Location::DiskImage.env_value(), Some("disk-image"));
    }

    #[test]
    fn off_macos_the_app_is_always_installed() {
        if !cfg!(target_os = "macos") {
            assert_eq!(current(), (None, Location::Installed));
        }
    }

    #[test]
    fn the_engine_hint_respects_open_anyway_and_never_loops_after_a_move() {
        let data = scratch("hint");
        let now = SystemTime::now();
        assert_eq!(
            engine_hint(Location::DiskImage, &data, false, now),
            Some("disk-image")
        );
        assert_eq!(engine_hint(Location::DiskImage, &data, true, now), None);
        note_moved(&data).unwrap();
        assert_eq!(
            engine_hint(Location::Translocated, &data, false, now),
            None,
            "just moved: not asked twice"
        );
        let later = now + MOVED_GRACE + Duration::from_secs(1);
        assert_eq!(
            engine_hint(Location::Translocated, &data, false, later),
            Some("translocated")
        );
        // running from Applications spends the marker
        assert_eq!(engine_hint(Location::Installed, &data, false, now), None);
        assert!(!data.join(MOVED_MARKER).exists());
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn replaces_the_copy_the_dock_opens_and_leaves_nothing_behind() {
        let root = scratch("replace");
        let image = root.join("image");
        let new = bundle(&image, "new");
        let system = root.join("Applications");
        let old = bundle(&system, "old");
        let at = install_into_applications(&new, &system, None, &copy_tree).unwrap();
        assert_eq!(at, old);
        assert_eq!(content(&at), "new");
        let left: Vec<_> = std::fs::read_dir(&system)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            left,
            vec![std::ffi::OsString::from("Knowledge Vault.app")],
            "no staging or old copy left"
        );
        assert_eq!(content(&new), "new", "the source is untouched");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_existing_copy_in_the_home_applications_is_the_one_replaced() {
        let root = scratch("home");
        let new = bundle(&root.join("image"), "new");
        let system = root.join("Applications");
        std::fs::create_dir_all(&system).unwrap();
        let home = root.join("home");
        let old = bundle(&home.join("Applications"), "old");
        let at = install_into_applications(&new, &system, Some(&home), &copy_tree).unwrap();
        assert_eq!(at, old);
        assert_eq!(content(&old), "new");
        assert!(
            !system.join("Knowledge Vault.app").exists(),
            "no second copy the Dock would not open"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_failed_copy_leaves_the_installed_app_as_it_was() {
        let root = scratch("fail");
        let new = bundle(&root.join("image"), "new");
        let system = root.join("Applications");
        let old = bundle(&system, "old");
        let failing = |_: &Path, to: &Path| -> io::Result<()> {
            std::fs::create_dir_all(to)?; // a half-made copy
            Err(io::Error::other("disk full"))
        };
        let err = install_into_applications(&new, &system, None, &failing).unwrap_err();
        assert!(err.contains("disk full"), "{err}");
        assert!(
            err.contains("Drag it from the disk image onto Applications"),
            "{err}"
        );
        assert_eq!(content(&old), "old");
        assert!(!system.join(".Knowledge Vault.app.moving").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn with_no_copy_yet_it_falls_back_to_the_home_applications() {
        let root = scratch("fallback");
        let new = bundle(&root.join("image"), "new");
        let system = root.join("missing-and-not-creatable/Applications"); // never created: the copy fails
        let home = root.join("home");
        let only_into_home = |from: &Path, to: &Path| -> io::Result<()> {
            if !to.starts_with(&home) {
                return Err(io::Error::from(io::ErrorKind::PermissionDenied));
            }
            copy_tree(from, to)
        };
        let at = install_into_applications(&new, &system, Some(&home), &only_into_home).unwrap();
        assert_eq!(at, home.join("Applications/Knowledge Vault.app"));
        assert_eq!(content(&at), "new");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reads_whether_a_volume_is_read_only() {
        assert!(!on_read_only_volume(&std::env::temp_dir()));
        assert!(!on_read_only_volume(Path::new("/definitely/not/here")));
    }
}
