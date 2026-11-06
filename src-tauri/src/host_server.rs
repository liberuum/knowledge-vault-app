//! Plan 6 (review I3/I4): an installed app serves its host page itself, on 127.0.0.1 only.
//! The listener is bound *before* the window exists — a busy port is never a blank window, and
//! no other program can be holding the port the window loads. The port is kept between launches
//! (the page's origin holds the theme, layouts and chat settings in its storage), with an
//! app-specific default far from common development ports.

use std::convert::Infallible;
use std::net::{SocketAddr, TcpListener};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;

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

/// A file of the host page by request path: its bytes and MIME type.
pub type Lookup = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

/// Serves the embedded host until the process ends.
pub fn serve<R: tauri::Runtime>(listener: TcpListener, port: u16, assets: tauri::AssetResolver<R>) {
    serve_with(
        listener,
        port,
        Arc::new(move |path: &str| assets.get(path.to_string()).map(|a| (a.bytes, a.mime_type))),
    );
}

/// Serves `lookup`'s files until the process ends, each connection on its own task. WebKit opens
/// six connections to the page at once and keeps them open; the thread pool this replaces could
/// queue one behind threads that each held another, and its files waited 60 s for an answer — on
/// macOS a window that stayed blank (0.2.6's release check, and 0.2.5 when the timing was wrong).
pub fn serve_with(listener: TcpListener, port: u16, lookup: Lookup) {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("host-page")
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("[shell] the host server could not start: {e}");
            return;
        }
    };
    runtime.block_on(async move {
        let listener = match listener
            .set_nonblocking(true)
            .and_then(|()| tokio::net::TcpListener::from_std(listener))
        {
            Ok(listener) => listener,
            Err(e) => {
                eprintln!("[shell] the host server could not start: {e}");
                return;
            }
        };
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(e) => {
                    // Out of descriptors, or a connection gone before it was accepted: keep serving.
                    eprintln!("[shell] the host server could not accept a connection: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let _ = stream.set_nodelay(true);
            let lookup = lookup.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req| respond(req, port, lookup.clone()));
                let mut http = http1::Builder::new();
                // As before: a connection stays open until WebKit closes it. hyper's default
                // closes an idle one after 30 s, which races a request WebKit sends on it.
                http.header_read_timeout(None::<Duration>);
                let _ = http.serve_connection(TokioIo::new(stream), service).await;
            });
        }
    });
}

async fn respond(
    req: Request<Incoming>,
    port: u16,
    lookup: Lookup,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok());
    if !allowed_host(host, port) {
        return Ok(plain(StatusCode::FORBIDDEN, "Forbidden"));
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        let mut resp = plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
        resp.headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return Ok(resp);
    }
    // The query is not part of the file's name.
    let path = req.uri().path().to_string();
    // An embedded file is decompressed as it is read: off the connections' tasks.
    let found = tokio::task::spawn_blocking(move || lookup(&path))
        .await
        .ok()
        .flatten();
    let Some((bytes, mime)) = found else {
        return Ok(plain(StatusCode::NOT_FOUND, "Not found"));
    };
    let mut resp = Response::new(Full::new(Bytes::from(bytes)));
    let headers = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&mime) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    Ok(resp)
}

fn plain(status: StatusCode, text: &'static str) -> Response<Full<Bytes>> {
    let mut resp = Response::new(Full::new(Bytes::from_static(text.as_bytes())));
    *resp.status_mut() = status;
    resp
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

/// The server itself, over real sockets — the way WebKit talks to it.
#[cfg(test)]
mod serve_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    const PAGE: &[u8] = b"<!doctype html><title>Knowledge Vault</title>";

    fn start() -> u16 {
        let (listener, port) = bind(None, 0).unwrap();
        let lookup: Lookup = Arc::new(|path: &str| match path {
            "/" | "/index.html" => Some((PAGE.to_vec(), "text/html".to_string())),
            "/assets/app.js" => Some((vec![b'x'; 20_000], "text/javascript".to_string())),
            _ => None,
        });
        std::thread::spawn(move || serve_with(listener, port, lookup));
        port
    }

    fn connect(port: u16) -> TcpStream {
        let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s
    }

    fn get(path: &str, port: u16) -> String {
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n")
    }

    /// Reads one response: its status, its head (lowercased) and, unless it answers a HEAD, its body.
    fn read_response(
        s: &mut TcpStream,
        with_body: bool,
    ) -> std::io::Result<(u16, String, Vec<u8>)> {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if s.read(&mut byte)? == 0 {
                return Err(std::io::ErrorKind::UnexpectedEof.into());
            }
            head.push(byte[0]);
        }
        let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
        let status = head
            .split(' ')
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        let length = head
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        let mut body = vec![0; if with_body { length } else { 0 }];
        s.read_exact(&mut body)?;
        Ok((status, head, body))
    }

    #[test]
    fn answers_every_connection_of_a_burst_and_keeps_them_open() {
        // WebKit opens six connections to the page at once and keeps them open. A server that
        // leaves one unread until another closes keeps the window blank (0.2.6's macOS check).
        let port = start();
        let mut conns: Vec<TcpStream> = (0..16).map(|_| connect(port)).collect();
        for round in 0..2 {
            for c in &mut conns {
                c.write_all(get("/assets/app.js", port).as_bytes()).unwrap();
            }
            let started = Instant::now();
            for (i, c) in conns.iter_mut().enumerate() {
                let (status, _, body) = read_response(c, true).unwrap_or_else(|e| {
                    panic!(
                        "round {round}: connection {i} unanswered after {:?} ({e})",
                        started.elapsed()
                    )
                });
                assert_eq!(
                    (status, body.len()),
                    (200, 20_000),
                    "round {round}, connection {i}"
                );
            }
        }
    }

    #[test]
    fn serves_a_file_with_its_type_and_the_pages_policy() {
        let port = start();
        let mut c = connect(port);
        for path in ["/index.html", "/index.html?theme=dark", "/"] {
            c.write_all(get(path, port).as_bytes()).unwrap();
            let (status, head, body) = read_response(&mut c, true).unwrap();
            assert_eq!((status, body.as_slice()), (200, PAGE), "{path}");
            assert!(head.contains("content-type: text/html\r\n"), "{head}");
            assert!(head.contains("cache-control: no-cache\r\n"), "{head}");
            assert!(
                head.contains("x-content-type-options: nosniff\r\n"),
                "{head}"
            );
            let csp = format!("content-security-policy: {}\r\n", CSP.to_ascii_lowercase());
            assert!(head.contains(&csp), "{head}");
        }
    }

    #[test]
    fn answers_head_without_a_body_and_the_connection_carries_on() {
        let port = start();
        let mut c = connect(port);
        c.write_all(
            format!("HEAD /assets/app.js HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes(),
        )
        .unwrap();
        let (status, head, _) = read_response(&mut c, false).unwrap();
        assert_eq!(status, 200);
        assert!(head.contains("content-length: 20000\r\n"), "{head}");
        c.write_all(get("/index.html", port).as_bytes()).unwrap();
        let (status, _, body) = read_response(&mut c, true).unwrap();
        assert_eq!((status, body.as_slice()), (200, PAGE));
    }

    #[test]
    fn refuses_another_host_an_unknown_file_and_anything_but_reading() {
        let port = start();
        let mut c = connect(port);
        for (request, expected) in [
            (
                format!("GET / HTTP/1.1\r\nHost: evil.example:{port}\r\n\r\n"),
                403,
            ),
            (
                format!(
                    "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                    port.wrapping_add(1)
                ),
                403,
            ),
            (get("/nothing-here.js", port), 404),
            (
                format!("POST / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\n\r\n"),
                405,
            ),
            (get("/index.html", port), 200),
        ] {
            c.write_all(request.as_bytes()).unwrap();
            let (status, _, _) = read_response(&mut c, true).unwrap();
            assert_eq!(status, expected, "{request}");
        }
    }
}
