use crate::backoff::{CrashWindow, restart_delay_ms};
use crate::config::{AppPaths, LocalProtection, Ports};
use crate::log_tail::{LogTail, RotatingLog};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyInfo {
    pub port: u16,
    pub control_port: u16,
    pub control_token: String,
}

/// Everything a respawn needs — recorded at spawn so the Terminated handler can start the engine again.
#[derive(Clone)]
pub struct SpawnParams {
    pub paths: AppPaths,
    pub ports: Ports,
    pub token: String,
    pub app_version: String,
}

/// The engine refused to start, and said why (`{"event":"fatal","reason":…,"message":…}`).
#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FatalInfo {
    pub reason: String,
    pub message: String,
}

pub struct SidecarState {
    pub ready: Option<ReadyInfo>,
    pub child: Option<CommandChild>,
    /// True from spawn until the Terminated event — the only reliable "is it alive".
    pub running: bool,
    pub exit_code: Option<i32>,
    pub spawn: Option<SpawnParams>,
    /// The engine printed a restart line (the protection switch): its exit is a respawn, not a stop.
    pub restart_requested: bool,
    /// The shell is stopping the engine (window closed, app quitting): no exit is ever respawned.
    pub stopping: bool,
    /// The engine announced its own shutdown (POST /shutdown): its exit is not a crash.
    pub shutdown_requested: bool,
    /// Crash-restart attempt (0 after a healthy start); 4 means the supervisor gave up.
    pub attempt: u32,
    /// Set while a delayed respawn is pending.
    pub delay_ms: Option<u64>,
    pub fatal: Option<FatalInfo>,
    /// Windows' first launch of a version: the engine is being unpacked (engine_archive.rs); shown as starting.
    pub preparing: bool,
    pub crashes: CrashWindow,
    pub tail: LogTail,
    pub log: Option<RotatingLog>,
    started_at: Instant,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            ready: None,
            child: None,
            running: false,
            exit_code: None,
            spawn: None,
            restart_requested: false,
            stopping: false,
            shutdown_requested: false,
            attempt: 0,
            delay_ms: None,
            fatal: None,
            preparing: false,
            crashes: CrashWindow::new(120_000),
            tail: LogTail::new(50),
            log: None,
            started_at: Instant::now(),
        }
    }
}

impl SidecarState {
    /// "Try again" after the supervisor gave up (or the engine refused to start): a clean slate —
    /// no crash count, no refusal, no exit code — so the next exits are judged afresh.
    pub fn reset_for_retry(&mut self) {
        self.attempt = 0;
        self.fatal = None;
        self.exit_code = None;
        self.delay_ms = None;
        self.stopping = false;
        self.shutdown_requested = false;
        self.restart_requested = false;
        self.crashes = CrashWindow::new(120_000);
    }

    fn now_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
    fn record_line(&mut self, line: &str) {
        self.tail.push(line);
        if let Some(log) = self.log.as_mut() {
            log.write_line(line.trim_end());
        }
    }
}

/// What an exit means (spec §9): the protection switch restarts at once; the shell stopping or the
/// engine's own shutdown is an exit; a crash is respawned with backoff until the window gives up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitAction {
    Restart,
    Respawn { delay_ms: u64 },
    GaveUp,
    Exited,
}

/// An engine that refused to start and said why (fatal) will refuse again — no backoff, the
/// supervisor gives up at once and the host shows the message.
pub fn decide_exit(
    restart_requested: bool,
    stopping: bool,
    shutdown_requested: bool,
    fatal: bool,
    attempt: u32,
) -> ExitAction {
    if stopping || shutdown_requested {
        return ExitAction::Exited;
    }
    if fatal {
        return ExitAction::GaveUp;
    }
    if restart_requested {
        return ExitAction::Restart;
    }
    match restart_delay_ms(attempt) {
        Some(delay_ms) => ExitAction::Respawn { delay_ms },
        None => ExitAction::GaveUp,
    }
}

/// What the host sees: `starting`, `ready`, `restarting` (a crash, respawn pending), `exited`,
/// `gave_up` (a crash loop) or `stopping`; with the attempt, the pending delay, a fatal reason and the tail.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub state: &'static str,
    pub ready: Option<ReadyInfo>,
    pub code: Option<i32>,
    pub attempt: u32,
    pub delay_ms: Option<u64>,
    pub fatal: Option<FatalInfo>,
    pub log_tail: Vec<String>,
    /// Windows' first launch of a version: the engine archive is being unpacked (shown by the page as its first stage).
    pub preparing: bool,
}

pub fn status_of(
    ready: Option<ReadyInfo>,
    running: bool,
    code: Option<i32>,
    attempt: u32,
    delay_ms: Option<u64>,
    fatal: Option<FatalInfo>,
    stopping: bool,
) -> SidecarStatus {
    let state = if stopping {
        "stopping"
    } else if ready.is_some() {
        "ready"
    } else if delay_ms.is_some() {
        "restarting"
    } else if running {
        "starting"
    } else if attempt >= 4 {
        "gave_up"
    } else {
        "exited"
    };
    SidecarStatus {
        state,
        ready,
        code,
        attempt,
        delay_ms,
        fatal,
        log_tail: Vec::new(),
        preparing: false,
    }
}

fn snapshot(app: &AppHandle) -> SidecarStatus {
    let st = app.state::<Mutex<SidecarState>>();
    let st = st.lock().unwrap();
    let mut status = status_of(
        st.ready.clone(),
        st.running,
        st.exit_code,
        st.attempt,
        st.delay_ms,
        st.fatal.clone(),
        st.stopping,
    );
    status.log_tail = st.tail.lines();
    status.preparing = st.preparing;
    if st.preparing && status.state == "exited" {
        status.state = "starting";
    }
    status
}

/// Windows: the engine is being unpacked before its first start (shown as starting), or no longer is.
pub fn set_preparing(app: &AppHandle, preparing: bool) {
    app.state::<Mutex<SidecarState>>().lock().unwrap().preparing = preparing;
    emit_status(app);
}

/// The engine could not be started at all (e.g. its archive would not unpack): the page shows the reason.
pub fn report_fatal(app: &AppHandle, reason: &str, message: String) {
    {
        let st = app.state::<Mutex<SidecarState>>();
        let mut st = st.lock().unwrap();
        st.preparing = false;
        st.fatal = Some(FatalInfo {
            reason: reason.to_string(),
            message,
        });
    }
    emit_status(app);
}

/// One engine output line, for the landing's start-up stages. Only sent while the engine is
/// not ready: the page derives "what is starting" from it and ignores it afterwards.
fn emit_log(app: &AppHandle, line: &str) {
    let _ = app.emit("sidecar:log", line.trim_end());
}

fn emit_status(app: &AppHandle) {
    let status = snapshot(app);
    crate::tray::refresh(app, status.state);
    let _ = app.emit("sidecar:status", status);
}

pub struct SidecarEnv;
impl SidecarEnv {
    pub fn build(
        paths: &AppPaths,
        ports: &Ports,
        token: &str,
        app_version: &str,
        protection: &LocalProtection,
    ) -> Vec<(String, String)> {
        let mut env = vec![
            (
                "KV_DATA_DIR".into(),
                paths.data_dir.to_string_lossy().into_owned(),
            ),
            ("KV_PORT".into(), ports.sidecar.to_string()),
            ("KV_CONTROL_PORT".into(), ports.control.to_string()),
            ("KV_CONTROL_TOKEN".into(), token.to_string()),
            (
                "KV_HOST_ORIGIN".into(),
                format!("http://127.0.0.1:{}", ports.host),
            ),
            ("KV_APP_VERSION".into(), app_version.to_string()),
            ("KV_STDIN_STOP".into(), "1".into()),
        ];
        // Spec §4.4: protected only with an administrator (the sidecar refuses KV_PROTECTED without one).
        if protection.protected
            && let Some(admin) = protection
                .admin_address
                .as_deref()
                .filter(|a| !a.is_empty())
        {
            env.push(("KV_PROTECTED".into(), "1".into()));
            env.push(("KV_ADMIN_ADDRESS".into(), admin.to_string()));
        }
        env
    }
}

/// `{"event":"ready","port":4201,"controlPort":4202}` → (4201, 4202); anything else → None.
pub fn parse_ready_line(line: &str) -> Option<(u16, u16)> {
    let t = line.trim();
    if !t.starts_with('{') {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(t).ok()?;
    if v.get("event")?.as_str()? != "ready" {
        return None;
    }
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    let control = u16::try_from(v.get("controlPort")?.as_u64()?).ok()?;
    Some((port, control))
}

fn parse_event(line: &str) -> Option<serde_json::Value> {
    let t = line.trim();
    if !t.starts_with('{') {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(t).ok()
}

/// `{"event":"fatal","reason":…,"message":…}` — the engine refused to start and said why.
pub fn parse_fatal_line(line: &str) -> Option<FatalInfo> {
    let v = parse_event(line)?;
    if v.get("event")?.as_str()? != "fatal" {
        return None;
    }
    Some(FatalInfo {
        reason: v
            .get("reason")
            .and_then(|r| r.as_str())
            .unwrap_or("")
            .to_string(),
        message: v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// `{"event":"shutdown"}` — the engine is stopping on request; its exit is not a crash.
pub fn parse_shutdown_line(line: &str) -> bool {
    parse_event(line)
        .and_then(|v| {
            v.get("event")
                .and_then(|e| e.as_str())
                .map(|e| e == "shutdown")
        })
        .unwrap_or(false)
}

/// `{"event":"restart",…}` — the engine wants to be started again (the protection switch changed its environment).
pub fn parse_restart_line(line: &str) -> bool {
    let t = line.trim();
    if !t.starts_with('{') {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(t)
        .ok()
        .and_then(|v| {
            v.get("event")
                .and_then(|e| e.as_str())
                .map(|e| e == "restart")
        })
        .unwrap_or(false)
}

/// Spawn `node <dist/main.js>` (bundled or PATH's) with the env, cwd = the engine's root; relay readiness and exit as `sidecar:status` events.
/// The protection section is read from config.json at every spawn, so a respawn picks up the switch.
pub fn spawn_sidecar(
    app: &AppHandle,
    paths: &AppPaths,
    ports: Ports,
    token: String,
    app_version: &str,
) -> tauri::Result<()> {
    let protection = LocalProtection::load(&paths.data_dir.join("config.json"));
    let env = SidecarEnv::build(paths, &ports, &token, app_version, &protection);
    // cwd = the engine's root: it resolves its packages from <root>/node_modules.
    // The engine's environment is scrubbed by the sidecar itself (environment.ts), whoever spawns it.
    let base = if paths.sidecar.bundled_node {
        app.shell()
            .sidecar("kv-node")
            .map_err(|e| tauri::Error::Anyhow(e.into()))?
    } else {
        app.shell().command("node")
    };
    let mut cmd = base
        .args([paths.sidecar.main.to_string_lossy().as_ref()])
        .current_dir(&paths.sidecar.cwd);
    for (k, v) in env {
        cmd = cmd.env(k, v);
    }
    let (mut rx, child) = cmd.spawn().map_err(|e| tauri::Error::Anyhow(e.into()))?;
    {
        let state = app.state::<Mutex<SidecarState>>();
        let mut st = state.lock().unwrap();
        st.child = Some(child);
        st.running = true;
        st.exit_code = None;
        st.ready = None;
        st.restart_requested = false;
        st.shutdown_requested = false;
        st.delay_ms = None;
        st.fatal = None;
        if st.log.is_none() {
            st.log = RotatingLog::open(
                &paths.data_dir.join("logs").join("sidecar.log"),
                10 * 1024 * 1024,
                5,
            )
            .ok();
        }
        let attempt = st.attempt;
        st.record_line(&format!("--- start attempt {attempt}"));
        st.spawn = Some(SpawnParams {
            paths: paths.clone(),
            ports,
            token: token.clone(),
            app_version: app_version.to_string(),
        });
    }
    emit_status(app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let state = handle.state::<Mutex<SidecarState>>();
                    let mut st = state.lock().unwrap();
                    st.record_line(&line);
                    if st.ready.is_none() {
                        emit_log(&handle, &line);
                    }
                    if let Some((port, control_port)) = parse_ready_line(&line) {
                        st.ready = Some(ReadyInfo {
                            port,
                            control_port,
                            control_token: token.clone(),
                        });
                        // The crash count is the window's (two minutes), not a healthy start's: an engine
                        // that comes up and then crashes every half-minute must still be reported.
                        st.delay_ms = None;
                        drop(st);
                        emit_status(&handle);
                    } else if parse_restart_line(&line) {
                        st.restart_requested = true;
                        println!("[shell] the engine asked to be restarted");
                    } else if let Some(fatal) = parse_fatal_line(&line) {
                        eprintln!("[shell] the engine refused to start: {}", fatal.message);
                        st.fatal = Some(fatal);
                    } else if parse_shutdown_line(&line) {
                        st.shutdown_requested = true;
                    } else {
                        print!("[sidecar] {line}");
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let starting = {
                        let state = handle.state::<Mutex<SidecarState>>();
                        let mut st = state.lock().unwrap();
                        st.record_line(&line);
                        st.ready.is_none()
                    };
                    if starting {
                        emit_log(&handle, &line);
                    }
                    eprint!("[sidecar] {line}")
                }
                CommandEvent::Terminated(payload) => {
                    let (action, params) = {
                        let state = handle.state::<Mutex<SidecarState>>();
                        let mut st = state.lock().unwrap();
                        st.ready = None;
                        st.child = None;
                        st.running = false;
                        st.exit_code = payload.code;
                        let fatal = st.fatal.is_some();
                        let crash = !st.restart_requested && !st.stopping && !st.shutdown_requested;
                        let attempt = if fatal {
                            4 // reads as gave_up
                        } else if crash {
                            let now = st.now_ms();
                            st.crashes.record(now)
                        } else {
                            st.attempt
                        };
                        let action = decide_exit(
                            st.restart_requested,
                            st.stopping,
                            st.shutdown_requested,
                            fatal,
                            attempt,
                        );
                        st.restart_requested = false;
                        // A planned restart (the protection switch, a backup) respawns at once: it is
                        // "starting", never a flash of "the engine stopped, exit code 0".
                        if matches!(action, ExitAction::Restart) {
                            st.running = true;
                        }
                        st.attempt = attempt;
                        st.delay_ms = match action {
                            ExitAction::Respawn { delay_ms } => Some(delay_ms),
                            _ => None,
                        };
                        st.record_line(&format!("--- exited code {:?}: {action:?}", payload.code));
                        (action, st.spawn.clone())
                    };
                    emit_status(&handle);
                    match (action, params) {
                        (ExitAction::Restart, Some(p)) => {
                            println!("[shell] restarting the engine");
                            if let Err(e) =
                                spawn_sidecar(&handle, &p.paths, p.ports, p.token, &p.app_version)
                            {
                                eprintln!("[shell] could not restart the engine: {e}");
                                mark_exited(&handle);
                            }
                        }
                        (ExitAction::Respawn { delay_ms }, Some(p)) => {
                            println!("[shell] the engine crashed; restarting in {delay_ms} ms");
                            let h = handle.clone();
                            tauri::async_runtime::spawn_blocking(move || {
                                std::thread::sleep(Duration::from_millis(delay_ms));
                                let stopping =
                                    h.state::<Mutex<SidecarState>>().lock().unwrap().stopping;
                                if stopping {
                                    return;
                                }
                                if let Err(e) =
                                    spawn_sidecar(&h, &p.paths, p.ports, p.token, &p.app_version)
                                {
                                    eprintln!("[shell] could not restart the engine: {e}");
                                    mark_exited(&h);
                                }
                            });
                        }
                        (ExitAction::GaveUp, _) => {
                            eprintln!("[shell] the engine keeps stopping; giving up");
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    });
    Ok(())
}

const STOP_POLLS: u32 = 75;
const STOP_POLL_MS: u64 = 200;

/// Keep waiting for a graceful exit while the child is alive and the 15 s grace period (75 × 200 ms) has not run out.
pub fn keep_waiting(running: bool, polls: u32) -> bool {
    running && polls < STOP_POLLS
}

/// A respawn that could not happen: the engine is reported as exited.
fn mark_exited(app: &AppHandle) {
    {
        let state = app.state::<Mutex<SidecarState>>();
        let mut st = state.lock().unwrap();
        st.running = false;
        st.delay_ms = None;
        if st.exit_code.is_none() {
            st.exit_code = Some(1);
        }
    }
    emit_status(app);
}

/// Take the child and ask it to stop (a `stop` line; its stdin EOF is the other request). From here on
/// every exit is a stop, never a respawn.
fn begin_stop(app: &AppHandle) -> Option<CommandChild> {
    let child = {
        let state = app.state::<Mutex<SidecarState>>();
        let mut st = state.lock().unwrap();
        st.stopping = true;
        st.delay_ms = None;
        st.child.take()
    };
    emit_status(app);
    if let Some(mut child) = child {
        let _ = child.write(b"stop\n");
        return Some(child);
    }
    None
}

/// Wait for the child to terminate within the grace period, then kill whatever is left. Keyed on the
/// child's life, not on readiness — a sidecar still booting (first-run initdb, the moment a kill hurts
/// most) gets the same grace period.
fn finish_stop(app: &AppHandle, child: CommandChild) {
    let mut polls = 0;
    while keep_waiting(
        app.state::<Mutex<SidecarState>>().lock().unwrap().running,
        polls,
    ) {
        std::thread::sleep(Duration::from_millis(STOP_POLL_MS));
        polls += 1;
    }
    let _ = child.kill();
    emit_status(app);
}

/// Start the engine again after the supervisor gave up — the strip's "Try again".
pub fn retry_sidecar(app: &AppHandle) -> Result<(), String> {
    let params = {
        let state = app.state::<Mutex<SidecarState>>();
        let mut st = state.lock().unwrap();
        if st.running {
            return Ok(());
        }
        st.reset_for_retry();
        st.running = true; // reads as "starting" until the spawn's own events take over
        st.spawn.clone()
    };
    emit_status(app);
    let p = params.ok_or("The engine was never started by this window (the dev loop runs it).")?;
    spawn_sidecar(app, &p.paths, p.ports, p.token, &p.app_version).map_err(|e| {
        mark_exited(app);
        e.to_string()
    })
}

/// Graceful stop on the current thread (the process is exiting and must wait for the engine).
pub fn stop_sidecar_blocking(app: &AppHandle) {
    if let Some(child) = begin_stop(app) {
        finish_stop(app, child);
    }
}

#[tauri::command]
pub fn sidecar_info(state: tauri::State<'_, Mutex<SidecarState>>) -> SidecarStatus {
    let st = state.lock().unwrap();
    let mut status = status_of(
        st.ready.clone(),
        st.running,
        st.exit_code,
        st.attempt,
        st.delay_ms,
        st.fatal.clone(),
        st.stopping,
    );
    status.log_tail = st.tail.lines();
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::LocalProtection;
    use std::path::PathBuf;

    fn ready() -> ReadyInfo {
        ReadyInfo {
            port: 4201,
            control_port: 4202,
            control_token: "t".into(),
        }
    }

    #[test]
    fn status_is_starting_then_ready_then_exited_with_the_code() {
        assert_eq!(
            status_of(None, true, None, 0, None, None, false).state,
            "starting"
        );
        let s = status_of(Some(ready()), true, None, 0, None, None, false);
        assert_eq!(s.state, "ready");
        assert_eq!(s.ready.map(|r| r.port), Some(4201));
        let s = status_of(None, false, Some(1), 0, None, None, false);
        assert_eq!(s.state, "exited");
        assert_eq!(s.code, Some(1));
        // A sidecar adopted from the dev loop was never spawned here: ready, not running — still "ready".
        assert_eq!(
            status_of(Some(ready()), false, None, 0, None, None, false).state,
            "ready"
        );
    }

    #[test]
    fn stop_waits_only_while_the_child_lives_and_within_the_grace_period() {
        assert!(keep_waiting(true, 0));
        assert!(keep_waiting(true, 74));
        assert!(!keep_waiting(true, 75));
        assert!(!keep_waiting(false, 0));
    }

    #[test]
    fn parses_the_ready_line_and_skips_everything_else() {
        assert_eq!(
            parse_ready_line(r#"{"event":"ready","port":4201,"controlPort":4202}"#),
            Some((4201, 4202))
        );
        assert_eq!(
            parse_ready_line("[15:23:40] [switchboard] Registered /graphql"),
            None
        );
        assert_eq!(
            parse_ready_line("(node:1) [DEP0205] DeprecationWarning"),
            None
        );
        assert_eq!(parse_ready_line(r#"{"event":"other","port":1}"#), None);
        assert_eq!(parse_ready_line(""), None);
    }

    #[test]
    fn env_carries_the_data_dir_intact_and_every_kv_variable() {
        let paths = AppPaths {
            data_dir: PathBuf::from("/tmp/Knowledge Vault äö/data"),
            sidecar: crate::config::SidecarLaunch::for_build(
                true,
                std::path::Path::new("/app"),
                std::path::Path::new("/repo"),
            ),
        };
        let ports = Ports {
            host: 4200,
            sidecar: 4301,
            control: 4302,
        };
        let env = SidecarEnv::build(&paths, &ports, "tok", "0.1.0", &LocalProtection::default());
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        assert_eq!(
            get("KV_DATA_DIR").as_deref(),
            Some("/tmp/Knowledge Vault äö/data")
        );
        assert_eq!(get("KV_PORT").as_deref(), Some("4301"));
        assert_eq!(get("KV_CONTROL_PORT").as_deref(), Some("4302"));
        assert_eq!(get("KV_CONTROL_TOKEN").as_deref(), Some("tok"));
        assert_eq!(
            get("KV_HOST_ORIGIN").as_deref(),
            Some("http://127.0.0.1:4200")
        );
        assert_eq!(get("KV_APP_VERSION").as_deref(), Some("0.1.0"));
        assert_eq!(get("KV_STDIN_STOP").as_deref(), Some("1"));
        assert!(get("KV_PROTECTED").is_none());
        assert!(get("KV_ADMIN_ADDRESS").is_none());
    }

    #[test]
    fn env_carries_protection_only_with_an_administrator() {
        let paths = AppPaths {
            data_dir: PathBuf::from("/data"),
            sidecar: crate::config::SidecarLaunch::for_build(
                true,
                std::path::Path::new("/app"),
                std::path::Path::new("/repo"),
            ),
        };
        let ports = Ports {
            host: 4200,
            sidecar: 4201,
            control: 4202,
        };
        let protected = LocalProtection {
            protected: true,
            admin_address: Some("0xabc".into()),
        };
        let env = SidecarEnv::build(&paths, &ports, "tok", "0.1.0", &protected);
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        assert_eq!(get("KV_PROTECTED").as_deref(), Some("1"));
        assert_eq!(get("KV_ADMIN_ADDRESS").as_deref(), Some("0xabc"));
        let half = LocalProtection {
            protected: true,
            admin_address: None,
        };
        let env = SidecarEnv::build(&paths, &ports, "tok", "0.1.0", &half);
        assert!(
            env.iter()
                .all(|(k, _)| k != "KV_PROTECTED" && k != "KV_ADMIN_ADDRESS")
        );
    }

    #[test]
    fn exit_actions_cover_switch_restart_crash_backoff_give_up_stop_and_shutdown() {
        // the protection switch: an immediate restart, never counted as a crash
        assert_eq!(
            decide_exit(true, false, false, false, 0),
            ExitAction::Restart
        );
        // the shell is stopping: always an exit
        assert_eq!(decide_exit(true, true, false, false, 0), ExitAction::Exited);
        assert_eq!(
            decide_exit(false, true, false, false, 2),
            ExitAction::Exited
        );
        // a shutdown the engine announced (POST /shutdown): an exit, not a crash
        assert_eq!(
            decide_exit(false, false, true, false, 0),
            ExitAction::Exited
        );
        // crashes: backoff by attempt, then give up
        assert_eq!(
            decide_exit(false, false, false, false, 1),
            ExitAction::Respawn { delay_ms: 1_000 }
        );
        assert_eq!(
            decide_exit(false, false, false, false, 3),
            ExitAction::Respawn { delay_ms: 16_000 }
        );
        assert_eq!(
            decide_exit(false, false, false, false, 4),
            ExitAction::GaveUp
        );
        // a fatal refusal: no retries, the message is what the user needs
        assert_eq!(
            decide_exit(false, false, false, true, 1),
            ExitAction::GaveUp
        );
        assert_eq!(decide_exit(true, false, false, true, 0), ExitAction::GaveUp);
        assert_eq!(decide_exit(false, true, false, true, 0), ExitAction::Exited);
        assert!(parse_restart_line(
            r#"{"event":"restart","reason":"protection"}"#
        ));
        assert!(!parse_restart_line(
            r#"{"event":"ready","port":4201,"controlPort":4202}"#
        ));
    }

    #[test]
    fn parses_fatal_and_shutdown_lines() {
        let f = parse_fatal_line(
            r#"{"event":"fatal","reason":"store-too-new","message":"This store was last opened by a newer Knowledge Vault"}"#,
        )
        .unwrap();
        assert_eq!(f.reason, "store-too-new");
        assert!(f.message.starts_with("This store"));
        assert!(parse_fatal_line(r#"{"event":"ready","port":1,"controlPort":2}"#).is_none());
        assert!(parse_shutdown_line(r#"{"event":"shutdown"}"#));
        assert!(!parse_shutdown_line("[sidecar] shutdown complete"));
    }

    #[test]
    fn retry_starts_from_a_clean_slate() {
        let mut st = SidecarState {
            attempt: 4,
            fatal: Some(FatalInfo {
                reason: "store-in-use".into(),
                message: "m".into(),
            }),
            exit_code: Some(78),
            stopping: true,
            ..SidecarState::default()
        };
        st.crashes.record(1);
        st.crashes.record(2);
        st.reset_for_retry();
        assert_eq!(st.attempt, 0);
        assert!(st.fatal.is_none() && st.exit_code.is_none() && !st.stopping);
        assert_eq!(st.crashes.record(3), 1, "the crash count starts over");
    }

    #[test]
    fn status_states() {
        let s = status_of(None, true, None, 2, Some(4_000), None, false);
        assert_eq!(s.state, "restarting");
        assert_eq!(s.attempt, 2);
        let s = status_of(None, false, Some(1), 4, None, None, false);
        assert_eq!(s.state, "gave_up");
        let s = status_of(None, false, None, 0, None, None, true);
        assert_eq!(s.state, "stopping");
        let s = status_of(None, false, Some(1), 1, None, None, false);
        assert_eq!(s.state, "exited");
    }
}
