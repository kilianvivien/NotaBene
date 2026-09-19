//! Apple Foundation Models through the `fm` command shipped with macOS 27.
//!
//! The HTTP protocol stays in the shared TypeScript provider layer. This module
//! only owns the platform work: preflight, the `fm serve` child process, exact
//! token counts near the context limit, and cleanup when NotaBene exits.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

const FM_PATH: &str = "/usr/bin/fm";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const START_TIMEOUT: Duration = Duration::from_secs(5);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(350);
const LOG_ROTATE_BYTES: u64 = 1_000_000;
const MAX_TOKEN_COUNT_CHARS: usize = 2_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppleFmModelState {
    Available,
    NotEligible,
    IntelligenceOff,
    NotReady,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleFmPreflight {
    installed: bool,
    os_ok: bool,
    licensed: bool,
    model: AppleFmModelState,
    detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleFmStatus {
    running: bool,
    port: Option<u16>,
    managed: bool,
    error: Option<String>,
}

struct AppleFmServer {
    child: Option<Child>,
    port: u16,
}

impl AppleFmServer {
    fn managed(&self) -> bool {
        self.child.is_some()
    }
}

pub struct AppleFmShared {
    server: Mutex<Option<AppleFmServer>>,
    operation: AsyncMutex<()>,
}

impl Default for AppleFmShared {
    fn default() -> Self {
        Self {
            server: Mutex::new(None),
            operation: AsyncMutex::new(()),
        }
    }
}

pub fn init(app: &AppHandle) {
    app.manage(AppleFmShared::default());
}

fn first_line(output: &Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn parse_model_state(success: bool, detail: &str) -> AppleFmModelState {
    if success {
        return AppleFmModelState::Available;
    }
    let normalized = detail.to_ascii_lowercase();
    if normalized.contains("not eligible")
        || normalized.contains("device not eligible")
        || normalized.contains("unsupported device")
    {
        AppleFmModelState::NotEligible
    } else if normalized.contains("apple intelligence")
        && (normalized.contains("disabled") || normalized.contains("turned off"))
    {
        AppleFmModelState::IntelligenceOff
    } else if normalized.contains("downloading")
        || normalized.contains("not ready")
        || normalized.contains("preparing")
    {
        AppleFmModelState::NotReady
    } else {
        AppleFmModelState::Unknown
    }
}

fn wait_for_output(mut child: Child, timeout: Duration) -> Result<Output, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(|error| error.to_string()),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("fm command timed out".into());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn run_fm(args: &[&str], stdin: Option<&str>) -> Result<Output, String> {
    let mut command = Command::new(FM_PATH);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not run fm: {error}"))?;
    if let Some(text) = stdin {
        child
            .stdin
            .take()
            .ok_or_else(|| "fm stdin was unavailable".to_string())?
            .write_all(text.as_bytes())
            .map_err(|error| format!("could not write to fm: {error}"))?;
    }
    wait_for_output(child, COMMAND_TIMEOUT)
}

fn preflight_blocking() -> AppleFmPreflight {
    let installed = cfg!(target_os = "macos") && Path::new(FM_PATH).is_file();
    if !installed {
        return AppleFmPreflight {
            installed: false,
            os_ok: false,
            licensed: false,
            model: AppleFmModelState::Unknown,
            detail: None,
        };
    }

    let license = match run_fm(&["license", "--status"], None) {
        Ok(output) => output,
        Err(error) => {
            return AppleFmPreflight {
                installed: true,
                os_ok: true,
                licensed: false,
                model: AppleFmModelState::Unknown,
                detail: Some(error),
            }
        }
    };
    if !license.status.success() {
        return AppleFmPreflight {
            installed: true,
            os_ok: true,
            licensed: false,
            model: AppleFmModelState::Unknown,
            detail: first_line(&license),
        };
    }

    match run_fm(&["available", "--model", "system"], None) {
        Ok(output) => {
            let detail = first_line(&output);
            AppleFmPreflight {
                installed: true,
                os_ok: true,
                licensed: true,
                model: parse_model_state(output.status.success(), detail.as_deref().unwrap_or("")),
                detail,
            }
        }
        Err(error) => AppleFmPreflight {
            installed: true,
            os_ok: true,
            licensed: true,
            model: AppleFmModelState::Unknown,
            detail: Some(error),
        },
    }
}

#[tauri::command]
pub async fn apple_fm_preflight() -> Result<AppleFmPreflight, String> {
    tauri::async_runtime::spawn_blocking(preflight_blocking)
        .await
        .map_err(|error| format!("Apple model preflight failed: {error}"))
}

fn pick_port(preferred: Option<u16>) -> Result<u16, String> {
    if let Some(port) = preferred {
        if port == 0 {
            return Err("the Apple model port must be between 1 and 65535".into());
        }
        return Ok(port);
    }
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|error| format!("could not select an Apple model port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("could not read the Apple model port: {error}"))
}

fn log_file(app: &AppHandle) -> Result<std::fs::File, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("could not resolve the log directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create the log directory: {error}"))?;
    let current = directory.join("apple-fm.log");
    let previous = directory.join("apple-fm.log.1");
    if current
        .metadata()
        .is_ok_and(|metadata| metadata.len() >= LOG_ROTATE_BYTES)
    {
        let _ = fs::remove_file(&previous);
        fs::rename(&current, &previous)
            .map_err(|error| format!("could not rotate the Apple model log: {error}"))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(current)
        .map_err(|error| format!("could not open the Apple model log: {error}"))
}

fn spawn_server(app: &AppHandle, port: u16) -> Result<Child, String> {
    let log = log_file(app)?;
    let stderr = log
        .try_clone()
        .map_err(|error| format!("could not clone the Apple model log: {error}"))?;
    Command::new(FM_PATH)
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| format!("could not start fm serve: {error}"))
}

#[derive(serde::Deserialize)]
struct HealthResponse {
    models: Vec<HealthModel>,
}

#[derive(serde::Deserialize)]
struct HealthModel {
    name: String,
    available: bool,
}

async fn healthy(port: u16) -> bool {
    crate::tls::ensure_provider();
    let client = match reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() {
        Ok(client) => client,
        Err(_) => return false,
    };
    let response = match client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        _ => return false,
    };
    response.json::<HealthResponse>().await.is_ok_and(|health| {
        health
            .models
            .iter()
            .any(|model| model.name == "system" && model.available)
    })
}

fn terminate(mut server: AppleFmServer) {
    if let Some(mut child) = server.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn preflight_error(preflight: &AppleFmPreflight) -> Option<String> {
    if !preflight.installed || !preflight.os_ok {
        Some("apple_fm_not_installed".into())
    } else if !preflight.licensed {
        Some("apple_fm_not_licensed".into())
    } else {
        match preflight.model {
            AppleFmModelState::Available => None,
            AppleFmModelState::NotEligible => Some("apple_fm_not_eligible".into()),
            AppleFmModelState::IntelligenceOff => Some("apple_fm_intelligence_off".into()),
            AppleFmModelState::NotReady => Some("apple_fm_not_ready".into()),
            AppleFmModelState::Unknown => Some(
                preflight
                    .detail
                    .clone()
                    .unwrap_or_else(|| "apple_fm_unavailable".into()),
            ),
        }
    }
}

#[tauri::command]
pub async fn apple_fm_start(
    app: AppHandle,
    state: State<'_, AppleFmShared>,
    port: Option<u16>,
) -> Result<u16, String> {
    let _operation = state.operation.lock().await;
    let preflight = apple_fm_preflight().await?;
    if let Some(error) = preflight_error(&preflight) {
        return Err(error);
    }

    let existing = state
        .server
        .lock()
        .map_err(|_| "Apple model state poisoned")?
        .take();
    if let Some(mut server) = existing {
        let alive = match server.child.as_mut() {
            Some(child) => child.try_wait().is_ok_and(|status| status.is_none()),
            None => true,
        };
        if alive && healthy(server.port).await {
            let existing_port = server.port;
            *state
                .server
                .lock()
                .map_err(|_| "Apple model state poisoned")? = Some(server);
            return Ok(existing_port);
        }
        tauri::async_runtime::spawn_blocking(move || terminate(server))
            .await
            .map_err(|error| format!("could not stop the stale Apple model: {error}"))?;
    }

    let port = pick_port(port)?;
    if healthy(port).await {
        *state
            .server
            .lock()
            .map_err(|_| "Apple model state poisoned")? = Some(AppleFmServer { child: None, port });
        return Ok(port);
    }

    let spawn_app = app.clone();
    let mut child = tauri::async_runtime::spawn_blocking(move || spawn_server(&spawn_app, port))
        .await
        .map_err(|error| format!("could not start the Apple model: {error}"))??;
    let started = Instant::now();
    while started.elapsed() < START_TIMEOUT {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("could not inspect fm serve: {error}"))?
        {
            return Err(format!(
                "fm serve exited before it became ready ({status}); see apple-fm.log"
            ));
        }
        if healthy(port).await {
            *state
                .server
                .lock()
                .map_err(|_| "Apple model state poisoned")? = Some(AppleFmServer {
                child: Some(child),
                port,
            });
            return Ok(port);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let _ = child.kill();
    let _ = child.wait();
    Err("fm serve did not become ready within five seconds; see apple-fm.log".into())
}

#[tauri::command]
pub async fn apple_fm_stop(state: State<'_, AppleFmShared>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    let server = state
        .server
        .lock()
        .map_err(|_| "Apple model state poisoned")?
        .take();
    if let Some(server) = server {
        tauri::async_runtime::spawn_blocking(move || terminate(server))
            .await
            .map_err(|error| format!("could not stop the Apple model: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn apple_fm_status(state: State<'_, AppleFmShared>) -> Result<AppleFmStatus, String> {
    let snapshot = {
        let mut guard = state
            .server
            .lock()
            .map_err(|_| "Apple model state poisoned")?;
        let Some(server) = guard.as_mut() else {
            return Ok(AppleFmStatus {
                running: false,
                port: None,
                managed: false,
                error: None,
            });
        };
        let alive = match server.child.as_mut() {
            Some(child) => child.try_wait().is_ok_and(|status| status.is_none()),
            None => true,
        };
        if !alive {
            *guard = None;
            return Ok(AppleFmStatus {
                running: false,
                port: None,
                managed: false,
                error: Some("fm serve exited unexpectedly; see apple-fm.log".into()),
            });
        }
        (server.port, server.managed())
    };

    if healthy(snapshot.0).await {
        Ok(AppleFmStatus {
            running: true,
            port: Some(snapshot.0),
            managed: snapshot.1,
            error: None,
        })
    } else {
        Ok(AppleFmStatus {
            running: false,
            port: Some(snapshot.0),
            managed: snapshot.1,
            error: Some("fm serve is not answering".into()),
        })
    }
}

#[tauri::command]
pub async fn apple_fm_count_tokens(text: String) -> Result<u32, String> {
    if text.chars().count() > MAX_TOKEN_COUNT_CHARS {
        return Err("refusing to count more than 2,000,000 characters".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_fm(&["count-tokens", "-q"], Some(&text))?;
        if !output.status.success() {
            return Err(first_line(&output).unwrap_or_else(|| "fm token count failed".into()));
        }
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .find_map(|part| part.parse::<u32>().ok())
            .ok_or_else(|| "fm returned no token count".into())
    })
    .await
    .map_err(|error| format!("Apple token count failed: {error}"))?
}

pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<AppleFmShared>() else {
        return;
    };
    let server = state.server.lock().ok().and_then(|mut guard| guard.take());
    if let Some(server) = server {
        terminate(server);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_a_free_loopback_port() {
        let port = pick_port(None).expect("port");
        assert_ne!(port, 0);
        TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("selected port is free");
    }

    #[test]
    fn preserves_a_preferred_port() {
        assert_eq!(pick_port(Some(1976)).expect("port"), 1976);
        assert!(pick_port(Some(0)).is_err());
    }

    #[test]
    fn maps_stable_preflight_wording() {
        assert_eq!(
            parse_model_state(false, "This device is not eligible"),
            AppleFmModelState::NotEligible
        );
        assert_eq!(
            parse_model_state(false, "Apple Intelligence is disabled"),
            AppleFmModelState::IntelligenceOff
        );
        assert_eq!(
            parse_model_state(false, "The model is still downloading"),
            AppleFmModelState::NotReady
        );
        assert_eq!(
            parse_model_state(false, "Something new"),
            AppleFmModelState::Unknown
        );
        assert_eq!(
            parse_model_state(true, "System model available"),
            AppleFmModelState::Available
        );
    }
}
