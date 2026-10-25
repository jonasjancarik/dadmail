// The email password lives in the system's password store
// (Windows Credential Manager, macOS Keychain), not in the database.
// It is read from there once per run and then kept in memory: the store can ask the
// user for permission (macOS does for unsigned builds), and the sync needs it every cycle.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

const SERVICE: &str = "DadMail";

static CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

fn entry(email: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, email)
}

pub fn get_password(email: &str) -> Option<String> {
    // Development builds only: unsigned builds on macOS make the Keychain ask for permission
    // after every rebuild, so a password can be passed in instead
    #[cfg(debug_assertions)]
    if let Ok(password) = std::env::var("DADMAIL_PASSWORD") {
        return Some(password);
    }
    if let Some(password) = CACHE.lock().unwrap().get(email) {
        return Some(password.clone());
    }
    match entry(email).and_then(|e| e.get_password()) {
        Ok(password) => {
            CACHE.lock().unwrap().insert(email.to_string(), password.clone());
            Some(password)
        }
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            log::error!("Could not read the password from the system password store: {e}");
            None
        }
    }
}

pub fn set_password(email: &str, password: &str) -> Result<(), String> {
    entry(email)
        .and_then(|e| e.set_password(password))
        .map_err(|e| format!("Heslo se nepodařilo uložit: {e}"))?;
    CACHE.lock().unwrap().insert(email.to_string(), password.to_string());
    Ok(())
}
