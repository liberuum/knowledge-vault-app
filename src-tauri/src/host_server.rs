//! Plan 6 (review I3/I4): an installed app serves its host page itself, on 127.0.0.1 only.
//! The listener is bound *before* the window exists — a busy port is never a blank window, and
//! no other program can be holding the port the window loads. The port is kept between launches
//! (the page's origin holds the theme, layouts and chat settings in its storage), with an
//! app-specific default far from common development ports.

use std::net::{SocketAddr, TcpListener};
use std::path::Path;

/// Far from 3000/4200/5173/8080 and the engine's own 4201/4202.
pub const DEFAULT_HOST_PORT: u16 = 46420;

/// Binds 127.0.0.1: the remembered port, else the default and the 20 after it, else any free port.
pub fn bind(remembered: Option<u16>, default: u16) -> std::io::Result<(TcpListener, u16)> {
    let candidates = remembered
        .into_iter()
        .chain((0..=20u16).filter_map(|i| default.checked_add(i)))
        .chain(std::iter::once(0));
    let mut last = None;
    for port in candidates {
        match TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))) {
            Ok(l) => {
                let bound = l.local_addr()?.port();
                return Ok((l, bound));
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("no port to bind")))
}

pub fn read_port(file: &Path) -> Option<u16> {
    std::fs::read_to_string(file).ok()?.trim().parse().ok()
}

pub fn write_port(file: &Path, port: u16) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, format!("{port}\n"));
}

/// The page answers only requests addressed to it (DNS rebinding: a web page that resolves its own
/// name to 127.0.0.1 sends its own Host).
pub fn allowed_host(host: Option<&str>, port: u16) -> bool {
    matches!(host, Some(h) if h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
}

/// The main window's permissions, granted to exactly this page's origin (never `127.0.0.1:*`).
pub fn loopback_capability(default_capability_json: &str, port: u16) -> String {
    let mut c: serde_json::Value =
        serde_json::from_str(default_capability_json).expect("capabilities/default.json is JSON");
    c["identifier"] = "loopback-host".into();
    c["local"] = false.into();
    c["remote"] = serde_json::json!({ "urls": [format!("http://127.0.0.1:{port}")] });
    if let Some(obj) = c.as_object_mut() {
        obj.remove("$schema");
    }
    c.to_string()
}

/// A minimal policy that cannot break the vault app: no plugins or framing from anywhere but
/// the app itself, no base-URL hijack. The app's own content is allowed on purpose: an original
/// PDF is shown in a frame as a `blob:` of this page, which inherits this policy — and WebKit
/// treats a PDF document as embedded content (object-src) that must accept being framed here.
pub(crate) const CSP: &str = "object-src 'self' blob:; base-uri 'self'; frame-ancestors 'self'";

#[cfg(test)]
mod csp_tests {
    use super::CSP;

    #[test]
    fn allows_the_apps_own_pdf_frames_and_nothing_from_elsewhere() {
        assert!(
            CSP.contains("frame-ancestors 'self'"),
            "the app's own blob PDF must be frameable by the app"
        );
        assert!(
            CSP.contains("object-src 'self' blob:"),
            "a PDF document is embedded content"
        );
        assert!(CSP.contains("base-uri 'self'"));
        assert!(
            !CSP.contains('*') && !CSP.contains("https:") && !CSP.contains("data:"),
            "no other origin or scheme may frame or embed"
        );
    }
}

/// Serves the embedded host until the process ends.
pub fn serve<R: tauri::Runtime>(listener: TcpListener, port: u16, assets: tauri::AssetResolver<R>) {
    let server = match tiny_http::Server::from_listener(listener, None) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[shell] the host server could not start: {e}");
            return;
        }
    };
    for req in server.incoming_requests() {
        let host = req
            .headers()
            .iter()
            .find(|h| h.field.equiv("Host"))
            .map(|h| h.value.as_str().to_string());
        if !allowed_host(host.as_deref(), port) {
            let _ =
                req.respond(tiny_http::Response::from_string("Forbidden").with_status_code(403));
            continue;
        }
        let path = req
            .url()
            .split(['?', '#'])
            .next()
            .unwrap_or("/")
            .to_string();
        let Some(asset) = assets.get(path) else {
            let _ =
                req.respond(tiny_http::Response::from_string("Not found").with_status_code(404));
            continue;
        };
        let mut resp = tiny_http::Response::from_data(asset.bytes);
        for (k, v) in [
            ("Content-Type", asset.mime_type.as_str()),
            ("Cache-Control", "no-cache"),
            ("X-Content-Type-Options", "nosniff"),
            ("Content-Security-Policy", CSP),
        ] {
            if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                resp.add_header(h);
            }
        }
        let _ = req.respond(resp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_the_remembered_port_then_the_default_then_any() {
        let (a, pa) = bind(None, 0).unwrap(); // any free port
        // A remembered port that is free: one the system just handed out and released (the next port up may be taken).
        let free = {
            let (probe, p) = bind(None, 0).unwrap();
            drop(probe);
            p
        };
        let (b, pb) = bind(Some(free), pa).unwrap(); // remembered one free → it
        assert_eq!(pb, free);
        drop(b);
        let (_c, pc) = bind(Some(pa), pa).unwrap(); // remembered busy (a holds it) → the default range
        assert_ne!(pc, pa);
        drop(a);
    }

    #[test]
    fn keeps_the_port_between_launches() {
        let file = std::env::temp_dir()
            .join(format!("kv-host-port-{}", std::process::id()))
            .join("host-port");
        assert_eq!(read_port(&file), None);
        write_port(&file, 46421);
        assert_eq!(read_port(&file), Some(46421));
    }

    #[test]
    fn answers_only_requests_addressed_to_it() {
        assert!(allowed_host(Some("127.0.0.1:46420"), 46420));
        assert!(allowed_host(Some("localhost:46420"), 46420));
        assert!(!allowed_host(Some("evil.example:46420"), 46420));
        assert!(!allowed_host(Some("127.0.0.1:4201"), 46420));
        assert!(!allowed_host(None, 46420));
    }

    #[test]
    fn grants_the_window_permissions_to_this_exact_origin() {
        let json = loopback_capability(include_str!("../capabilities/default.json"), 46420);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            v["remote"]["urls"],
            serde_json::json!(["http://127.0.0.1:46420"])
        );
        assert_eq!(v["local"], false);
        assert_eq!(v["identifier"], "loopback-host");
        assert!(v["permissions"].as_array().unwrap().len() >= 2);
    }
}
