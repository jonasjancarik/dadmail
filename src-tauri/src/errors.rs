// Turn errors from the mail libraries into messages Dad can act on.
// The original text is logged, so the details are still in the log file.

pub const WRONG_PASSWORD: &str = "Seznam nepřijal přihlašovací údaje. Zkontrolujte heslo v Nastavení (tlačítko ⚙).";
pub const SECURE_CONNECTION: &str =
    "Zabezpečené spojení se Seznamem se nepodařilo navázat. Zkontrolujte, že má počítač správné datum a čas.";
pub const BAD_RECIPIENT: &str = "Adresa příjemce je neplatná nebo neexistuje. Zkontrolujte ji a zkuste to znovu.";
pub const NO_CONNECTION: &str =
    "Nepodařilo se spojit se Seznamem. Zkontrolujte připojení k internetu, DadMail to za chvíli zkusí znovu.";
pub const SOMETHING_WENT_WRONG: &str = "Něco se nepovedlo. Zkuste to prosím za chvíli znovu.";

pub fn describe(raw: &str) -> String {
    // Already one of these messages
    if [WRONG_PASSWORD, SECURE_CONNECTION, BAD_RECIPIENT, NO_CONNECTION, SOMETHING_WENT_WRONG].contains(&raw) {
        return raw.to_string();
    }
    log::error!("{raw}");
    let text = raw.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));

    let message = if has(&["authenticationfailed", "authentication failed", "invalid credentials", "login failed", "(535)", " 535 "]) {
        WRONG_PASSWORD
    } else if has(&["certificate", "tls", "ssl", "handshake"]) {
        SECURE_CONNECTION
    } else if has(&["recipient", "(550)", "(553)", "mailbox unavailable"]) {
        BAD_RECIPIENT
    } else if has(&[
        "lookup", "dns", "nodename", "connection refused", "unreachable", "timed out", "timeout",
        "connection reset", "broken pipe", "network", "connection error", "os error",
    ]) {
        NO_CONNECTION
    } else {
        SOMETHING_WENT_WRONG
    };
    message.to_string()
}

#[cfg(test)]
mod tests {
    use super::describe;

    #[test]
    fn library_errors_become_clear_messages() {
        assert!(describe("No Response: [AUTHENTICATIONFAILED] Invalid credentials").contains("heslo"));
        assert!(describe("permanent error (535): 5.7.8 Authentication failed").contains("heslo"));
        assert!(describe("failed to lookup address information: nodename nor servname provided").contains("internetu"));
        assert!(describe("deadline has elapsed (timeout)").contains("internetu"));
        assert_eq!(describe(super::WRONG_PASSWORD), super::WRONG_PASSWORD);
        assert!(describe("permanent error (550): 5.1.1 Recipient address rejected").contains("příjemce"));
        assert!(describe("something odd").starts_with("Něco se nepovedlo"));
    }
}
