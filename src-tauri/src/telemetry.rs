// Error reports for Jonáš (telemetry/ in the repository has the receiving Worker).
// A report holds the kind of error, a scrubbed message, the app version and the OS.
// Never email content or addresses: addresses and home-folder paths are removed here,
// and the Worker removes addresses again.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use rusqlite::Connection;
use serde_json::json;

use crate::db;

const ENDPOINT: &str = "https://dadmail-telemetry.jonas-jancarik.workers.dev/report";
const MAX_MESSAGE: usize = 1000;
// The same error is sent at most this often; repeats in between are counted
const REPEAT_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const MAX_REPORTS_PER_RUN: usize = 30;

static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)[^\s<>"'()@,;:]+@[^\s<>"'()@,;:]+\.[a-z]{2,}"#).unwrap());
// Windows user names may contain spaces, so a Windows path runs to the next backslash
static WINDOWS_HOME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)([A-Z]:\\Users\\)[^\\"'\r\n]+"#).unwrap());
static UNIX_HOME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(/Users/|/home/)[^/\s"']+"#).unwrap());

struct State {
    enabled: bool,
    install_id: String,
    sent: usize,
    // (kind, message) -> when last sent, and repeats since
    seen: HashMap<(String, String), (Instant, u32)>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| {
    Mutex::new(State { enabled: false, install_id: String::new(), sent: 0, seen: HashMap::new() })
});

pub fn scrub(message: &str) -> String {
    let text = EMAIL.replace_all(message, "<email>");
    let text = WINDOWS_HOME.replace_all(&text, "${1}<user>");
    let text = UNIX_HOME.replace_all(&text, "${1}<user>");
    text.chars().take(MAX_MESSAGE).collect()
}

fn random_id() -> String {
    // RandomState is seeded from the operating system's random source
    let part = || RandomState::new().build_hasher().finish();
    format!("{:016x}{:016x}", part(), part())
}

fn os_description() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

pub fn is_enabled(conn: &Connection) -> bool {
    db::get_setting(conn, "telemetry").ok().flatten().as_deref() != Some("off")
}

// Read the setting and the installation ID; call at start and when the setting changes
pub fn configure(conn: &Connection) {
    let install_id = match db::get_setting(conn, "install_id").ok().flatten() {
        Some(id) => id,
        None => {
            let id = random_id();
            let _ = db::set_setting(conn, "install_id", &id);
            id
        }
    };
    let mut state = STATE.lock().unwrap();
    state.enabled = is_enabled(conn);
    state.install_id = install_id;
}

// Send a report in the background. kind: sync, send, crash, ui, update or other.
pub fn report(kind: &str, message: &str) {
    let message = scrub(message);
    let (install_id, count) = {
        let mut state = STATE.lock().unwrap();
        if !state.enabled || state.install_id.is_empty() || state.sent >= MAX_REPORTS_PER_RUN {
            return;
        }
        let key = (kind.to_string(), message.clone());
        let now = Instant::now();
        let count = match state.seen.get_mut(&key) {
            Some((last, repeats)) if now.duration_since(*last) < REPEAT_INTERVAL => {
                *repeats += 1;
                return;
            }
            Some((last, repeats)) => {
                let count = *repeats + 1;
                *last = now;
                *repeats = 0;
                count
            }
            None => {
                state.seen.insert(key, (now, 0));
                1
            }
        };
        state.sent += 1;
        (state.install_id.clone(), count)
    };
    let body = json!({
        "install_id": install_id,
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": os_description(),
        "kind": kind,
        "message": message,
        "count": count,
    });
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().tls_backend_native().timeout(Duration::from_secs(10)).build() {
            Ok(client) => client,
            Err(e) => return log::warn!("Could not create the reporting client: {e}"),
        };
        match client.post(ENDPOINT).json(&body).send().await {
            Ok(response) if response.status().is_success() => log::info!("Sent an error report"),
            Ok(response) => log::warn!("Error report was refused: {}", response.status()),
            Err(e) => log::warn!("Could not send an error report: {e}"),
        }
    });
}

fn crash_file(data_dir: &Path) -> PathBuf {
    data_dir.join("crash-report.txt")
}

// A crash cannot reliably send anything, so it is written down and sent at the next start
pub fn install_panic_hook(data_dir: PathBuf) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        let _ = std::fs::write(crash_file(&data_dir), format!("{message}{location}"));
        default_hook(info);
    }));
}

pub fn send_crash_from_last_run(data_dir: &Path) {
    let path = crash_file(data_dir);
    if let Ok(message) = std::fs::read_to_string(&path) {
        let _ = std::fs::remove_file(&path);
        report("crash", &message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_never_contain_addresses_or_user_names() {
        assert_eq!(
            scrub("permanent error (550): 5.1.1 <Jana.Novakova@seznam.cz> Recipient address rejected"),
            "permanent error (550): 5.1.1 <<email>> Recipient address rejected"
        );
        assert_eq!(
            scrub(r"cannot read C:\Users\Jiri Novak\Pictures\foto.jpg"),
            r"cannot read C:\Users\<user>\Pictures\foto.jpg"
        );
        assert_eq!(scrub("/Users/jiri/Library/x"), "/Users/<user>/Library/x");
        assert_eq!(scrub(&"x".repeat(5000)).len(), MAX_MESSAGE);
    }
}
