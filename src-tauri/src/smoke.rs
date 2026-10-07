//! Plan 6: `KV_SMOKE=1` turns a launch into a check — the installed app exits 0 once the engine
//! reported ready, the host page answered on its port and the page called the shell over IPC (stopping the engine gracefully on the
//! way out), or 1 after 90 s. scripts/smoke-app.mjs and CI drive it.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::sidecar::SidecarState;

/// 90 s, or KV_SMOKE_SECS: a first launch on Windows also unpacks the engine (engine_archive.rs).
fn deadline(secs: Option<&str>) -> Duration {
    Duration::from_secs(secs.and_then(|s| s.parse().ok()).unwrap_or(90))
}

/// Set when the host page called `host_loaded` over IPC.
#[derive(Default)]
pub struct HostLoaded(pub AtomicBool);

/// `GET /` on 127.0.0.1:<port> answers 200.
pub fn host_answers(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    // With the port: the page server refuses any other Host (its DNS-rebinding guard).
    let request = format!("GET / HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 32];
    let n = stream.read(&mut head).unwrap_or(0);
    let line = String::from_utf8_lossy(&head[..n]);
    line.starts_with("HTTP/1.") && line.split_whitespace().nth(1) == Some("200")
}

pub fn watch(app: AppHandle, host_port: u16) {
    let started = Instant::now();
    let limit = deadline(std::env::var("KV_SMOKE_SECS").ok().as_deref());
    loop {
        let ready = app
            .state::<Mutex<SidecarState>>()
            .lock()
            .unwrap()
            .ready
            .is_some();
        // The window loaded the page and the page reached the shell over IPC (review minor 3).
        let loaded = app.state::<HostLoaded>().0.load(Ordering::SeqCst);
        if ready && loaded && host_answers(host_port) {
            println!(
                "[smoke] ok: the engine is ready, the host answered on {host_port} and the page reached the shell after {:.1} s",
                started.elapsed().as_secs_f64()
            );
            crate::quit(&app);
            return;
        }
        if started.elapsed() > limit {
            eprintln!(
                "[smoke] failed: engine ready = {ready}, page reached the shell = {loaded}, host answering = {} after {} s",
                host_answers(host_port),
                limit.as_secs()
            );
            crate::sidecar::stop_sidecar_blocking(&app);
            app.exit(1);
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_deadline_is_90_seconds_unless_kv_smoke_secs_says_otherwise() {
        assert_eq!(super::deadline(None), std::time::Duration::from_secs(90));
        assert_eq!(
            super::deadline(Some("300")),
            std::time::Duration::from_secs(300)
        );
        assert_eq!(
            super::deadline(Some("soon")),
            std::time::Duration::from_secs(90)
        );
    }

    use super::host_answers;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn serve_once(status: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 256];
                let _ = s.read(&mut buf);
                let _ = s.write_all(
                    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes(),
                );
            }
        });
        port
    }

    #[test]
    fn its_request_passes_the_page_servers_host_check() {
        // The page server refuses a Host without its port (DNS-rebinding guard); the check must not trip it.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 256];
            let n = s.read(&mut buf).unwrap();
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        assert!(host_answers(port));
        let request = seen.join().unwrap();
        let host = request
            .lines()
            .find_map(|l| l.strip_prefix("Host: "))
            .map(str::trim);
        assert!(
            crate::host_server::allowed_host(host, port),
            "sent {host:?}"
        );
    }

    #[test]
    fn a_page_that_answers_200_is_up_anything_else_is_not() {
        assert!(host_answers(serve_once("200 OK")));
        assert!(!host_answers(serve_once("404 Not Found")));
        let unused = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(!host_answers(unused));
    }
}
