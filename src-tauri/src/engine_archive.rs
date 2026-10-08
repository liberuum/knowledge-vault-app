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

/// Unpack `archive` under `base` once per app version and archive, and return the engine's root
/// (`…/sidecar`). The unpack goes straight into its final folder and the `.complete` marker is written
/// last, so a half-made one is never used: a folder without the marker is removed and redone.
///
/// No folder rename: on Windows, real-time antivirus is still scanning the ~37 000 files it has just
/// seen written and holds them open, so renaming their folder fails with "access denied" — the first
/// start after every update did, and a restart (scan finished) worked. Removals are retried for the
/// same reason. Other versions' folders are removed afterwards, best effort.
pub fn unpack(archive: &Path, base: &Path, version: &str) -> io::Result<PathBuf> {
    let key = format!("{version}-{}", fs::metadata(archive)?.len());
    let dest = base.join(&key);
    let root = dest.join("sidecar");
    if !dest.join(".complete").is_file() {
        if dest.exists() {
            remove_dir_all_retrying(&dest)?;
        }
        fs::create_dir_all(&dest)?;
        tar::Archive::new(fs::File::open(archive)?).unpack(&dest)?;
        fs::write(dest.join(".complete"), &key)?;
    }
    if let Ok(entries) = fs::read_dir(base) {
        for entry in entries.flatten() {
            if entry.file_name() != key.as_str() {
                let _ = remove_dir_all_retrying(&entry.path());
            }
        }
    }
    Ok(root)
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
        let root = unpack(&archive, &base, "0.1.0").unwrap();
        assert!(root.join("dist/main.js").is_file());
        assert_eq!(
            fs::read_to_string(root.parent().unwrap().join(&rel)).unwrap(),
            "module.exports = 1;\n"
        );
        // a second launch reuses it: a file added to the unpacked engine is still there
        fs::write(root.join("marker"), "x").unwrap();
        assert_eq!(unpack(&archive, &base, "0.1.0").unwrap(), root);
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
        fs::create_dir_all(base.join("0.1.0-123").join("sidecar")).unwrap();
        let root = unpack(&archive, &base, "0.2.0").unwrap();
        assert!(root.join("dist/main.js").is_file());
        assert!(
            !root.join("half").exists(),
            "the interrupted unpack was redone, not reused"
        );
        let left: Vec<String> = fs::read_dir(&base)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(left, vec![key]);
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
