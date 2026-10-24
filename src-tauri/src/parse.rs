use std::sync::LazyLock;

use mail_parser::{MessageParser, PartType};
use regex::Regex;

const PREVIEW_LENGTH: usize = 200;

static PREVIEW_CLEANUPS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"!\[[^\]]*\]\([^)]*\)", ""),
        (r"(?i)\[?cid:[^\s\]]+\]?", ""),
        (r"https?://[^\s]+", ""),
        (r"(?im)^(From|To|Subject|Date|Sent|Cc|Bcc):.*$", ""),
        (r"[-_]{3,}", " "),
        (r"\s+", " "),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).unwrap(), replacement))
    .collect()
});

// Short one-line preview for the inbox list, computed once when the email is stored
pub fn make_preview(body_text: &str) -> String {
    let mut text = body_text.to_string();
    for (pattern, replacement) in PREVIEW_CLEANUPS.iter() {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    text.trim().chars().take(PREVIEW_LENGTH).collect()
}

pub struct ParsedEmail {
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub date: Option<i64>,
    pub from_addr: String,
    pub from_name: String,
    pub to_addr: String,
    pub subject: String,
    pub body_html: String,
    pub body_text: String,
    pub preview: String,
}

// Message IDs are stored with angle brackets, as the Electron app's parser returned them
fn bracketed(id: &str) -> String {
    format!("<{}>", id.trim_matches(|c| c == '<' || c == '>'))
}

// Parse a raw email into the columns stored in the emails table.
// HTML is stored as-is and sanitized in the renderer right before display.
pub fn parse_raw_email(raw: &[u8]) -> Option<ParsedEmail> {
    let message = MessageParser::default().parse(raw)?;

    let from = message.from().and_then(|a| a.first());
    let from_addr = from
        .and_then(|a| a.address())
        .unwrap_or("unknown@unknown")
        .to_string();
    let from_name = from
        .and_then(|a| a.name())
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| from_addr.split('@').next().unwrap_or("").to_string());

    let to_addr = message
        .to()
        .and_then(|a| a.first())
        .and_then(|a| a.address())
        .unwrap_or("unknown@unknown")
        .to_string();

    // mail-parser converts between text and HTML when a message has only one of them.
    // Keep HTML only when the message really has an HTML part.
    let has_html = message
        .html_part(0)
        .is_some_and(|p| matches!(p.body, PartType::Html(_)));
    let body_html = if has_html {
        message.body_html(0).map(|b| b.into_owned()).unwrap_or_default()
    } else {
        String::new()
    };
    let mut body_text = message.body_text(0).map(|b| b.into_owned()).unwrap_or_default();
    if body_text.is_empty() && body_html.is_empty() {
        body_text = "(Email nemá textový obsah)".to_string();
    }

    Some(ParsedEmail {
        message_id: message.message_id().map(bracketed),
        in_reply_to: message.in_reply_to().as_text().map(bracketed),
        date: message.date().map(|d| d.to_timestamp()),
        from_addr,
        from_name,
        to_addr,
        subject: message
            .subject()
            .filter(|s| !s.is_empty())
            .unwrap_or("(Bez předmětu)")
            .to_string(),
        preview: make_preview(&body_text),
        body_html,
        body_text,
    })
}
