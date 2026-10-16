//! Installing a downloaded update (host/src/components/UpdateNotice.tsx). The engine has put the new
//! release's installer in the Downloads folder (sidecar/src/app-update.ts); the shell opens it and
//! quits, so the installer can replace the app. Only this app's release installers are opened.

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Installer {
    /// macOS: the disk image, opened in Finder (drag the app onto Applications).
    Dmg,
    /// Windows: the setup program.
    Setup,
    /// Linux, installed from the package: opened by the desktop's software installer.
    Deb,
    /// Linux, run from an AppImage: the new AppImage is the new app.
    AppImage,
}

/// What a file is, by the names the release workflow gives them (`Knowledge-Vault_<version>_<os>…`);
/// anything else is not an installer of this app and is refused.
pub fn installer_kind(name: &str) -> Option<Installer> {
    let rest = name.strip_prefix("Knowledge-Vault_")?;
    if rest.is_empty()
        || !rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return None;
    }
    if rest.ends_with(".dmg") {
        Some(Installer::Dmg)
    } else if rest.ends_with("-setup.exe") {
        Some(Installer::Setup)
    } else if rest.ends_with(".deb") {
        Some(Installer::Deb)
    } else if rest.ends_with(".AppImage") {
        Some(Installer::AppImage)
    } else {
        None
    }
}

/// Opens the installer. The disk image, the setup and the package go to the desktop's own handler.
/// An AppImage is started a moment after this app has gone: one instance runs at a time, so started
/// at once it would hand itself to this one and exit.
pub fn launch(path: &Path, kind: Installer) -> Result<(), String> {
    match kind {
        Installer::AppImage => launch_appimage(path),
        _ => tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string()),
    }
}

/// Puts the downloaded AppImage where the running one is installed: copied beside it under a
/// temporary name, then renamed over it. A rename leaves the running app's mounted file intact (it
/// keeps the old inode), and the launcher the person uses — a menu entry, a symlink — now starts the
/// new version. Started from the download alone, the next start from the menu would be the old app,
/// which cannot open data the new one has already opened. Returns where the new app now lives.
#[cfg(unix)]
pub fn install_appimage(downloaded: &Path, running: &Path) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let target =
        std::fs::canonicalize(running).map_err(|e| format!("{}: {e}", running.display()))?;
    let source =
        std::fs::canonicalize(downloaded).map_err(|e| format!("{}: {e}", downloaded.display()))?;
    if target == source {
        return Ok(target);
    }
    let dir = target.parent().ok_or("the installed app has no folder")?;
    let name = target.file_name().ok_or("the installed app has no name")?;
    let temp = dir.join(format!(".{}.update", name.to_string_lossy()));
    let result = (|| {
        std::fs::copy(&source, &temp)?;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755))?;
        std::fs::File::open(&temp)?.sync_all()?;
        std::fs::rename(&temp, &target)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("could not replace {}: {e}", target.display()));
    }
    Ok(target)
}

#[cfg(unix)]
fn launch_appimage(downloaded: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    // The AppImage runtime names the file this app was started from. Replace it, so every way of
    // starting the app starts the new version; if that is impossible (a read-only folder), the
    // download still runs, as before.
    let path = match std::env::var_os("APPIMAGE") {
        Some(running) => install_appimage(downloaded, Path::new(&running)).unwrap_or_else(|e| {
            eprintln!("[update] {e}; starting the downloaded AppImage instead");
            downloaded.to_path_buf()
        }),
        None => downloaded.to_path_buf(),
    };
    let path = path.as_path();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;
    std::process::Command::new("sh")
        .arg("-c")
        .arg("sleep 2; exec \"$0\"")
        .arg(path)
        // This AppImage's own runtime variables describe the old mount, not the new one.
        .env_remove("APPIMAGE")
        .env_remove("APPDIR")
        .env_remove("ARGV0")
        .env_remove("OWD")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // Its own process group: the app's shutdown does not take it along.
        .process_group(0)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn launch_appimage(_path: &Path) -> Result<(), String> {
    Err("An AppImage runs on Linux only.".into())
}

#[cfg(test)]
mod tests {
    use super::{Installer, installer_kind};

    #[cfg(unix)]
    #[test]
    fn an_update_replaces_the_installed_appimage_behind_its_launcher() {
        let dir = std::env::temp_dir().join(format!("kv-update-{}", std::process::id()));
        let apps = dir.join("Applications");
        let downloads = dir.join("Downloads");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::create_dir_all(&downloads).unwrap();
        let installed = apps.join("KnowledgeVault-0.2.2.AppImage");
        std::fs::write(&installed, b"old").unwrap();
        let launcher = apps.join("KnowledgeVault.AppImage");
        std::os::unix::fs::symlink(&installed, &launcher).unwrap();
        let downloaded = downloads.join("Knowledge-Vault_0.2.4_Linux_x86-64.AppImage");
        std::fs::write(&downloaded, b"new").unwrap();

        let at = super::install_appimage(&downloaded, &launcher).unwrap();
        assert_eq!(at, std::fs::canonicalize(&installed).unwrap());
        assert_eq!(std::fs::read(&launcher).unwrap(), b"new");
        assert!(!apps.join(".KnowledgeVault-0.2.2.AppImage.update").exists());
        // started from the download itself: nothing to move
        assert_eq!(
            super::install_appimage(&downloaded, &downloaded).unwrap(),
            std::fs::canonicalize(&downloaded).unwrap()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_release_installers_by_name() {
        assert_eq!(
            installer_kind("Knowledge-Vault_0.2.2_macOS_Apple-silicon.dmg"),
            Some(Installer::Dmg)
        );
        assert_eq!(
            installer_kind("Knowledge-Vault_0.2.2_Windows_x64-setup.exe"),
            Some(Installer::Setup)
        );
        assert_eq!(
            installer_kind("Knowledge-Vault_0.2.2_Linux_x86-64.deb"),
            Some(Installer::Deb)
        );
        assert_eq!(
            installer_kind("Knowledge-Vault_0.2.2_Linux_x86-64.AppImage"),
            Some(Installer::AppImage)
        );
    }

    #[test]
    fn anything_else_is_refused() {
        for name in [
            "Knowledge-Vault_0.2.2_macOS_Apple-silicon.app.tar.gz",
            "Knowledge-Vault_0.2.2_Windows_x64.exe",
            "Other_0.2.2_macOS.dmg",
            "Knowledge-Vault_",
            "Knowledge-Vault_../../evil.dmg",
            "Knowledge-Vault_a b.dmg",
            "knowledge-vault_0.2.2.dmg",
        ] {
            assert_eq!(installer_kind(name), None, "{name}");
        }
    }
}
