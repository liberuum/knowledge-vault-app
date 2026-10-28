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

/// How many times a folder is deleted before its "Directory not empty" is reported.
const REMOVE_PASSES: usize = 25;

/// Deletes a folder, again while what is left says "Directory not empty". `remove_dir_all` lists a
/// folder while it deletes from it, and on macOS that listing now and then ends after its first
/// 2 KB batch with the rest of the folder still there: seen deleting a 200,000-file copy of the app
/// in /Applications, at one of the 446 folders that take more than one batch, a different one each
/// time. Each pass deletes what the last one missed; returns how many passes it took.
fn remove_dir_again(dir: &Path, remove: &dyn Fn(&Path) -> io::Result<()>) -> io::Result<usize> {
    let mut pass = 1;
    loop {
        match remove(dir) {
            Ok(()) => return Ok(pass),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(pass),
            Err(e) if e.kind() == io::ErrorKind::DirectoryNotEmpty && pass < REMOVE_PASSES => {
                pass += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Removes a file, a symlink or a folder; for a folder, the passes it took (`remove_dir_again`).
fn remove_counting(path: &Path) -> io::Result<usize> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => remove_dir_again(path, &|dir| std::fs::remove_dir_all(dir)),
        Ok(_) => std::fs::remove_file(path).map(|()| 1),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e),
    }
}

/// Removes a file, a symlink or a folder.
fn remove_any(path: &Path) -> io::Result<()> {
    remove_counting(path).map(|_| ())
}

/// Where a move makes the new copy (`.<name>.moving`) and where it sets the replaced one aside
/// (`.<name>.old`): beside the copy in Applications, hidden, and not named `.app`, so neither Finder
/// nor Launchpad shows them as apps.
fn beside(target: &Path) -> (PathBuf, PathBuf) {
    let dir = target.parent().unwrap_or(Path::new(""));
    let label = target.file_name().unwrap_or_default().to_string_lossy();
    (
        dir.join(format!(".{label}.moving")),
        dir.join(format!(".{label}.old")),
    )
}

/// Puts `bundle` into `dir` under its own name, replacing a copy already there. The new copy is made
/// beside it under a hidden name first, so a failed copy leaves the installed app untouched; the old
/// copy is then moved aside (and put back if the new one cannot take its place) and left for the new
/// copy to delete once it runs (`remove_leftovers`). Deleting it here kept "Moving…" up for seconds
/// longer, and a quit in that time left half of it behind for good.
pub fn install_bundle(
    bundle: &Path,
    dir: &Path,
    copy: &dyn Fn(&Path, &Path) -> io::Result<()>,
) -> Result<PathBuf, String> {
    let name = bundle.file_name().ok_or("the app has no name")?;
    let target = dir.join(name);
    let (staging, aside) = beside(&target);
    let _ = remove_any(&staging);
    if let Err(e) = copy(bundle, &staging) {
        let _ = remove_any(&staging);
        return Err(format!("could not copy it into {}: {e}", dir.display()));
    }
    let replacing = std::fs::symlink_metadata(&target).is_ok();
    if replacing {
        // A copy an earlier move set aside, should its cleanup never have run.
        if let Err(e) = remove_any(&aside) {
            let _ = remove_any(&staging);
            return Err(format!(
                "could not delete {}, left by an earlier move: {e}",
                aside.display()
            ));
        }
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
    Ok(target)
}

/// A half-made copy younger than this may still be being written by a move elsewhere: in another
/// account, or in this one while another account's copy holds the single-instance socket in /tmp (a
/// move takes a minute or two). Older, it is what a move cut short left behind.
const STALE_STAGING: Duration = Duration::from_secs(60 * 60);

/// When a folder last changed: its status-change time on Unix, which nothing can set back (ditto
/// dates a finished copy like its source, hours before on a release), else its modification time.
fn changed(m: &std::fs::Metadata) -> Option<SystemTime> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let secs = u64::try_from(m.ctime()).ok()?;
        let nanos = u32::try_from(m.ctime_nsec()).ok()?;
        Some(SystemTime::UNIX_EPOCH + Duration::new(secs, nanos))
    }
    #[cfg(not(unix))]
    {
        m.modified().ok()
    }
}

/// What a move left beside `bundle`, deleted by the copy that now runs there: the old copy it set
/// aside, and a half-made copy from a move cut short (a quit during "Moving…"). Called at every start
/// from Applications, so a cleanup that fails or is cut short is tried again at the next one; a copy
/// macOS still translocates never calls it, and the next move clears what is left (`install_bundle`).
/// Returns what was there and how it went, in how many passes; nothing when there was nothing.
pub fn remove_leftovers(bundle: &Path, now: SystemTime) -> Vec<(PathBuf, io::Result<usize>)> {
    let (staging, aside) = beside(bundle);
    let mut removed = Vec::new();
    if std::fs::symlink_metadata(&aside).is_ok() {
        let result = remove_counting(&aside);
        removed.push((aside, result));
    }
    let stale = std::fs::symlink_metadata(&staging)
        .ok()
        .and_then(|m| changed(&m))
        .and_then(|at| now.duration_since(at).ok())
        .is_some_and(|age| age >= STALE_STAGING);
    if stale {
        let result = remove_counting(&staging);
        removed.push((staging, result));
    }
    removed
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
        // the next start reads the clock after the move wrote the marker; read before, an APFS
        // timestamp (nanoseconds) is later than `now` and the marker would look like the future
        let now = SystemTime::now();
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
    fn replaces_the_copy_the_dock_opens_and_its_first_start_clears_the_old_one() {
        let root = scratch("replace");
        let image = root.join("image");
        let new = bundle(&image, "new");
        let system = root.join("Applications");
        let old = bundle(&system, "old");
        let at = install_into_applications(&new, &system, None, &copy_tree).unwrap();
        assert_eq!(at, old);
        assert_eq!(content(&at), "new");
        assert_eq!(content(&new), "new", "the source is untouched");
        let names = || {
            let mut names: Vec<_> = std::fs::read_dir(&system)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        // the old copy waits beside the new one, hidden, for the new one to start
        assert_eq!(names(), [".Knowledge Vault.app.old", "Knowledge Vault.app"]);
        assert_eq!(content(&system.join(".Knowledge Vault.app.old")), "old");

        let removed = remove_leftovers(&at, SystemTime::now());
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].0, system.join(".Knowledge Vault.app.old"));
        assert!(removed[0].1.is_ok());
        assert_eq!(names(), ["Knowledge Vault.app"], "nothing left behind");
        assert!(
            remove_leftovers(&at, SystemTime::now()).is_empty(),
            "the next start finds nothing to do"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_copy_cut_short_is_cleared_once_no_move_can_still_be_writing_it() {
        let root = scratch("cut-short");
        let system = root.join("Applications");
        let app = bundle(&system, "new");
        let staging = system.join(".Knowledge Vault.app.moving");
        std::fs::create_dir_all(staging.join("Contents")).unwrap();
        let now = SystemTime::now();
        assert!(
            remove_leftovers(&app, now).is_empty(),
            "a move may still be writing it"
        );
        assert!(staging.exists());
        let later = now + STALE_STAGING + Duration::from_secs(1);
        let removed = remove_leftovers(&app, later);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].0, staging);
        assert!(removed[0].1.is_ok());
        assert!(!staging.exists());
        assert_eq!(content(&app), "new", "the app itself is never touched");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_cleanup_that_fails_says_why_and_is_tried_again_at_the_next_start() {
        use std::os::unix::fs::PermissionsExt;
        // SAFETY: geteuid has no preconditions and cannot fail.
        if unsafe { libc::geteuid() } == 0 {
            return; // root deletes whatever the permissions say
        }
        let root = scratch("cleanup-fails");
        let system = root.join("Applications");
        let app = bundle(&system, "new");
        let aside = system.join(".Knowledge Vault.app.old");
        let locked = aside.join("Contents/Resources");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("main.js"), "old").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let removed = remove_leftovers(&app, SystemTime::now());
        assert_eq!(removed.len(), 1);
        assert!(
            removed[0].1.is_err(),
            "the failure is reported, not swallowed"
        );
        assert!(aside.exists());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let removed = remove_leftovers(&app, SystemTime::now());
        assert_eq!(removed.len(), 1);
        assert!(removed[0].1.is_ok(), "the next start finishes the job");
        assert!(!aside.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_folder_whose_listing_ends_early_is_deleted_in_more_passes() {
        let root = scratch("passes");
        let dir = root.join(".Knowledge Vault.app.old");
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a.js", "b.js", "c.js"] {
            std::fs::write(dir.join(name), "old").unwrap();
        }
        // a delete whose listing ends after one entry, as macOS's now and then does after 2 KB
        let one_per_pass = |d: &Path| -> io::Result<()> {
            match std::fs::read_dir(d)?.next() {
                Some(entry) => {
                    std::fs::remove_file(entry?.path())?;
                    Err(io::Error::from(io::ErrorKind::DirectoryNotEmpty))
                }
                None => std::fs::remove_dir(d),
            }
        };
        assert_eq!(remove_dir_again(&dir, &one_per_pass).unwrap(), 4);
        assert!(!dir.exists());

        // a folder that never empties is reported after the last pass; any other failure at once
        let calls = std::cell::Cell::new(0);
        let never_empties = |_: &Path| -> io::Result<()> {
            calls.set(calls.get() + 1);
            Err(io::Error::from(io::ErrorKind::DirectoryNotEmpty))
        };
        let err = remove_dir_again(&root, &never_empties).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::DirectoryNotEmpty);
        assert_eq!(calls.get(), REMOVE_PASSES);
        calls.set(0);
        let denied = |_: &Path| -> io::Result<()> {
            calls.set(calls.get() + 1);
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        };
        let err = remove_dir_again(&root, &denied).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(calls.get(), 1);
        let gone = |_: &Path| -> io::Result<()> { Err(io::Error::from(io::ErrorKind::NotFound)) };
        assert_eq!(
            remove_dir_again(&root, &gone).unwrap(),
            1,
            "already gone is done"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_finished_copy_dated_like_its_source_is_still_a_move_under_way() {
        let root = scratch("dated");
        let system = root.join("Applications");
        let app = bundle(&system, "new");
        let staging = system.join(".Knowledge Vault.app.moving");
        std::fs::create_dir_all(staging.join("Contents")).unwrap();
        // what ditto does once the copy is complete: the source's dates, here a release two days old
        let built = SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60);
        std::fs::File::open(&staging)
            .unwrap()
            .set_modified(built)
            .unwrap();
        let removed = remove_leftovers(&app, SystemTime::now());
        assert!(
            removed.is_empty(),
            "a move may still be lifting the quarantine or swapping it in"
        );
        assert!(staging.exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_beside_the_app_is_removed_not_followed() {
        let root = scratch("link");
        let system = root.join("Applications");
        let app = bundle(&system, "new");
        let elsewhere = bundle(&root.join("elsewhere"), "keep");
        let aside = system.join(".Knowledge Vault.app.old");
        std::os::unix::fs::symlink(&elsewhere, &aside).unwrap();
        let removed = remove_leftovers(&app, SystemTime::now());
        assert_eq!(removed.len(), 1);
        assert!(removed[0].1.is_ok());
        assert!(std::fs::symlink_metadata(&aside).is_err());
        assert_eq!(content(&elsewhere), "keep", "only the link goes");
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
