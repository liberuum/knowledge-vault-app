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

#[cfg(unix)]
fn launch_appimage(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
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
