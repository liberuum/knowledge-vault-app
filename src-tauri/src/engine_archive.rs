//! Windows: the installer carries the engine as one archive, `engine.tar` (scripts/lib/pack-engine.mjs) — its
//! nested node_modules pass the 260-character path limit of the installer builder. On first launch of each
//! version the shell unpacks it into `<local-data>/engine/<key>/` (std and Node both handle long paths) and
//! starts the engine from there. Linux and macOS ship the folder and never get here.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The archive in the installed app's resources, when this build ships one.
pub fn archived_engine(resource_dir: &Path) -> Option<PathBuf> {
    let file = resource_dir.join("engine.tar");
    file.is_file().then_some(file)
}

/// The unpacked engine: its root (`…/sidecar`), and whether this launch unpacked it (so the shell can
/// say how long that took) or found it from an earlier launch.
pub struct Unpacked {
    pub root: PathBuf,
    pub unpacked_now: bool,
}

/// Every `files` entries, the unpack reports where it is: `(entries so far, total entries)`. The
/// total is counted from the archive first (one pass over the headers, no data read), so the page can
/// show "12,000 of 38,700" rather than a count that climbs towards nothing.
const PROGRESS_EVERY: u64 = 2_000;

/// Unpack `archive` under `base` once per app version and archive. The unpack goes straight into its
/// final folder and the `.complete` marker is written last, so a half-made one is never used: a folder
/// without the marker is removed and redone.
///
/// No folder rename: on Windows, real-time antivirus is still scanning the ~37 000 files it has just
/// seen written and holds them open, so renaming their folder fails with "access denied" — the first
/// start after every update did, and a restart (scan finished) worked. Other versions' folders are not
/// touched here: `remove_other_versions` runs once the engine is up, so the first start of a version
/// pays for the unpack alone and not for deleting the previous version's files past the antivirus too.
pub fn unpack(
    archive: &Path,
    base: &Path,
    version: &str,
    progress: &mut dyn FnMut(u64, u64),
) -> io::Result<Unpacked> {
    let key = format!("{version}-{}", fs::metadata(archive)?.len());
    let dest = base.join(&key);
    let root = dest.join("sidecar");
    if dest.join(".complete").is_file() {
        return Ok(Unpacked {
            root,
            unpacked_now: false,
        });
    }
    if dest.exists() {
        remove_dir_all_retrying(&dest)?;
    }
    fs::create_dir_all(&dest)?;
    let total = tar::Archive::new(fs::File::open(archive)?)
        .entries()?
        .filter_map(Result::ok)
        .count() as u64;
    // The same unpack `tar::Archive::unpack` does — every entry in order, directories applied last so
    // a read-only one cannot shadow the files inside it — with a count on the way.
    let mut ar = tar::Archive::new(fs::File::open(archive)?);
    let mut directories = Vec::new();
    let mut done = 0u64;
    for entry in ar.entries()? {
        let mut entry = entry?;
        if entry.header().entry_type().is_dir() {
            directories.push(entry);
        } else {
            entry.unpack_in(&dest)?;
        }
        done += 1;
        if done.is_multiple_of(PROGRESS_EVERY) {
            progress(done, total);
        }
    }
    directories.sort_by(|a, b| b.path_bytes().cmp(&a.path_bytes()));
    for mut dir in directories {
        dir.unpack_in(&dest)?;
    }
    progress(total, total);
    fs::write(dest.join(".complete"), &key)?;
    Ok(Unpacked {
        root,
        unpacked_now: true,
    })
}

/// Every other version's folder under `base` — the previous version the update replaced, a `.partial`
/// from the old scheme — removed best effort, and first marked incomplete, so a removal cut short
/// (the app quit, the antivirus held a file) leaves a folder the next launch never mistakes for a
/// usable engine. Called once the engine is up; see `unpack`.
pub fn remove_other_versions(base: &Path, root: &Path) {
    let keep = root.parent().and_then(Path::file_name);
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        if Some(entry.file_name().as_os_str()) == keep {
            continue;
        }
        let path = entry.path();
        let _ = fs::remove_file(path.join(".complete"));
        if let Err(e) = remove_dir_all_retrying(&path) {
            eprintln!(
                "[shell] the previous engine version at {} could not be removed yet: {e}",
                path.display()
            );
        }
    }
}

/// `remove_dir_all`, retried for up to ~10 s: a file antivirus is scanning cannot be deleted yet.
fn remove_dir_all_retrying(path: &Path) -> io::Result<()> {
    let mut last = None;
    for attempt in 0..20 {
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(std::time::Duration::from_millis(100 + 25 * attempt));
    }
    Err(last.unwrap_or_else(|| io::Error::other("could not remove the folder")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kv-engine-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A staged engine with a path longer than Windows' 260 characters, packed the way pack-engine.mjs does.
    fn archive_with_deep_path(dir: &Path) -> (PathBuf, String) {
        let deep: Vec<String> = (0..12)
            .map(|i| format!("@scope-{i}/package-with-a-long-name-{i}"))
            .collect();
        let rel = format!("sidecar/node_modules/{}/index.js", deep.join("/"));
        assert!(rel.len() > 260);
        let file = dir.join("engine.tar");
        let mut builder = tar::Builder::new(fs::File::create(&file).unwrap());
        for (path, body) in [
            ("sidecar/dist/main.js", "// engine\n"),
            (rel.as_str(), "module.exports = 1;\n"),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            builder
                .append_data(&mut header, path, body.as_bytes())
                .unwrap();
        }
        builder.finish().unwrap();
        (file, rel)
    }

    #[test]
    fn unpacks_once_and_keeps_paths_longer_than_260_characters() {
        let dir = temp("once");
        let (archive, rel) = archive_with_deep_path(&dir);
        let base = dir.join("engine");
        let mut reports = Vec::new();
        let first = unpack(&archive, &base, "0.1.0", &mut |done, total| {
            reports.push((done, total))
        })
        .unwrap();
        let root = first.root.clone();
        assert!(first.unpacked_now);
        assert!(root.join("dist/main.js").is_file());
        assert_eq!(
            fs::read_to_string(root.parent().unwrap().join(&rel)).unwrap(),
            "module.exports = 1;\n"
        );
        // the last report says it is complete, against a total counted up front
        assert_eq!(reports.last(), Some(&(2, 2)));
        // a second launch reuses it: a file added to the unpacked engine is still there, and nothing is reported
        fs::write(root.join("marker"), "x").unwrap();
        let again = unpack(&archive, &base, "0.1.0", &mut |_, _| {
            panic!("no unpack, no progress")
        })
        .unwrap();
        assert_eq!(again.root, root);
        assert!(!again.unpacked_now);
        assert!(root.join("marker").is_file());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_interrupted_unpack_is_redone_and_other_versions_go() {
        let dir = temp("redo");
        let (archive, _) = archive_with_deep_path(&dir);
        let base = dir.join("engine");
        let key = format!("0.2.0-{}", fs::metadata(&archive).unwrap().len());
        // a folder left by an interrupted unpack (no .complete marker), an old `.partial` from the
        // previous scheme, and another version's folder
        fs::create_dir_all(base.join(&key).join("sidecar").join("half")).unwrap();
        fs::create_dir_all(base.join(format!("{key}.partial")).join("sidecar")).unwrap();
        let old = base.join("0.1.0-123");
        fs::create_dir_all(old.join("sidecar")).unwrap();
        fs::write(old.join(".complete"), "0.1.0-123").unwrap();
        let root = unpack(&archive, &base, "0.2.0", &mut |_, _| {})
            .unwrap()
            .root;
        assert!(root.join("dist/main.js").is_file());
        assert!(
            !root.join("half").exists(),
            "the interrupted unpack was redone, not reused"
        );
        // the unpack itself leaves the other versions alone: the first start pays for the unpack only
        assert!(old.join(".complete").is_file());
        let listing = || -> Vec<String> {
            let mut v: Vec<String> = fs::read_dir(&base)
                .unwrap()
                .map(|e| e.unwrap().file_name().into_string().unwrap())
                .collect();
            v.sort();
            v
        };
        assert_eq!(listing().len(), 3);
        // once the engine is up, they go — marked incomplete first, so a removal cut short is never reused
        remove_other_versions(&base, &root);
        assert_eq!(listing(), vec![key]);
        // nothing else to remove is fine, and so is a base that is gone
        remove_other_versions(&base, &root);
        remove_other_versions(&dir.join("missing"), &root);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn progress_is_reported_every_two_thousand_entries_and_at_the_end() {
        let dir = temp("progress");
        let file = dir.join("engine.tar");
        let mut builder = tar::Builder::new(fs::File::create(&file).unwrap());
        for i in 0..4_500u32 {
            let path = format!("sidecar/node_modules/p{}/f{i}.js", i % 40);
            let body = b"1";
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            builder.append_data(&mut header, path, &body[..]).unwrap();
        }
        builder.finish().unwrap();
        let mut reports = Vec::new();
        unpack(&file, &dir.join("engine"), "0.3.0", &mut |d, t| {
            reports.push((d, t))
        })
        .unwrap();
        assert_eq!(
            reports,
            vec![(2_000, 4_500), (4_000, 4_500), (4_500, 4_500)]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn no_archive_in_the_resources_means_the_folder_ships() {
        let dir = temp("none");
        assert!(archived_engine(&dir).is_none());
        fs::write(dir.join("engine.tar"), b"").unwrap();
        assert_eq!(archived_engine(&dir), Some(dir.join("engine.tar")));
        fs::remove_dir_all(&dir).unwrap();
    }
}
