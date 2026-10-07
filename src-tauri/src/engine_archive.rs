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
/// (`…/sidecar`). An unpack is made in `<key>.partial` and renamed when complete, so an interrupted one is
/// redone, never used half-made. Other versions' folders are removed afterwards.
pub fn unpack(archive: &Path, base: &Path, version: &str) -> io::Result<PathBuf> {
    let key = format!("{version}-{}", fs::metadata(archive)?.len());
    let dest = base.join(&key);
    let root = dest.join("sidecar");
    if !dest.join(".complete").is_file() {
        let partial = base.join(format!("{key}.partial"));
        if partial.exists() {
            fs::remove_dir_all(&partial)?;
        }
        fs::create_dir_all(&partial)?;
        tar::Archive::new(fs::File::open(archive)?).unpack(&partial)?;
        fs::write(partial.join(".complete"), &key)?;
        if dest.exists() {
            fs::remove_dir_all(&dest)?;
        }
        fs::rename(&partial, &dest)?;
    }
    if let Ok(entries) = fs::read_dir(base) {
        for entry in entries.flatten() {
            if entry.file_name() != key.as_str() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(root)
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
        fs::create_dir_all(base.join(format!("{key}.partial")).join("sidecar")).unwrap();
        fs::create_dir_all(base.join("0.1.0-123").join("sidecar")).unwrap();
        let root = unpack(&archive, &base, "0.2.0").unwrap();
        assert!(root.join("dist/main.js").is_file());
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
