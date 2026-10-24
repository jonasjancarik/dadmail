// The email password lives in the system's password store
// (Windows Credential Manager, macOS Keychain), not in the database

const SERVICE: &str = "DadMail";

fn entry(email: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, email)
}

pub fn get_password(email: &str) -> Option<String> {
    match entry(email).and_then(|e| e.get_password()) {
        Ok(password) => Some(password),
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
        .map_err(|e| format!("Heslo se nepodařilo uložit: {e}"))
}
