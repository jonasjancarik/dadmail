use std::sync::LazyLock;

use base64::Engine;
use mail_parser::{MessageParser, MimeHeaders, PartType};
use regex::Regex;
use serde::Serialize;

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

#[derive(Serialize)]
pub struct AttachmentInfo {
    pub index: usize,
    pub file_name: String,
    pub size: usize,
    // Opening these could run a program, so the UI only offers saving them
    pub risky: bool,
}

pub struct EmailContent {
    pub body_html: String,
    pub attachments: Vec<AttachmentInfo>,
}

fn file_name_for(part: &mail_parser::MessagePart, index: usize) -> String {
    let extension = part
        .content_type()
        .and_then(|ct| ct.subtype())
        .map(|subtype| match subtype.to_ascii_lowercase().as_str() {
            "jpeg" => "jpg".to_string(),
            "plain" => "txt".to_string(),
            "rfc822" => "eml".to_string(),
            other => other.to_string(),
        });
    let name = part.attachment_name().map(str::to_string).unwrap_or_else(|| match extension {
        Some(ext) => format!("priloha-{}.{ext}", index + 1),
        None => format!("priloha-{}", index + 1),
    });
    safe_file_name(&name)
}

// Inline images referenced from the HTML as cid:… become data: URLs, so they show
// without loading anything from the internet. Everything else is listed as an attachment.
pub fn email_content(raw: &[u8], stored_html: &str) -> EmailContent {
    let mut body_html = stored_html.to_string();
    let mut attachments = Vec::new();
    let Some(message) = MessageParser::default().parse(raw) else {
        return EmailContent { body_html, attachments };
    };

    for (index, part) in message.attachments().enumerate() {
        let content_id = part
            .content_id()
            .map(|id| id.trim_matches(|c| c == '<' || c == '>').to_string());
        let is_image = part.content_type().is_some_and(|ct| ct.ctype().eq_ignore_ascii_case("image"));
        if let Some(id) = content_id.filter(|id| is_image && body_html.contains(&format!("cid:{id}"))) {
            let ct = part.content_type().unwrap();
            let mime = format!("{}/{}", ct.ctype(), ct.subtype().unwrap_or("png")).to_ascii_lowercase();
            let data = base64::engine::general_purpose::STANDARD.encode(part.contents());
            body_html = body_html.replace(&format!("cid:{id}"), &format!("data:{mime};base64,{data}"));
            continue;
        }
        let file_name = file_name_for(part, index);
        attachments.push(AttachmentInfo {
            index,
            risky: is_risky_to_open(&file_name),
            file_name,
            size: part.contents().len(),
        });
    }
    EmailContent { body_html, attachments }
}

// File name and contents of the attachment at `index` (as listed by email_content)
pub fn attachment(raw: &[u8], index: usize) -> Option<(String, Vec<u8>)> {
    let message = MessageParser::default().parse(raw)?;
    let part = message.attachments().nth(index)?;
    Some((file_name_for(part, index), part.contents().to_vec()))
}

// A file name that is valid on Windows and macOS and cannot point outside its folder
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        "priloha".to_string()
    } else {
        cleaned.chars().take(150).collect()
    }
}

pub fn is_risky_to_open(file_name: &str) -> bool {
    const RISKY: &[&str] = &[
        "exe", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "cpl", "js", "jse", "vbs", "vbe",
        "wsf", "wsh", "ps1", "psm1", "hta", "jar", "lnk", "reg", "iso", "img", "vhd", "vhdx",
        "app", "command", "sh", "pkg", "dmg", "html", "htm", "svg",
    ];
    file_name
        .rsplit_once('.')
        .is_some_and(|(_, ext)| RISKY.contains(&ext.to_ascii_lowercase().as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMAIL_WITH_ATTACHMENTS: &str = "From: Jan Novak <jan@example.cz>\r
To: tata@seznam.cz\r
Subject: Fotky\r
Message-ID: <abc@example.cz>\r
MIME-Version: 1.0\r
Content-Type: multipart/mixed; boundary=\"outer\"\r
\r
--outer\r
Content-Type: multipart/related; boundary=\"inner\"\r
\r
--inner\r
Content-Type: text/html; charset=utf-8\r
\r
<p>Ahoj</p><img src=\"cid:logo@x\">\r
--inner\r
Content-Type: image/png\r
Content-ID: <logo@x>\r
Content-Transfer-Encoding: base64\r
\r
iVBORw0KGgo=\r
--inner--\r
--outer\r
Content-Type: application/pdf; name=\"faktura.pdf\"\r
Content-Disposition: attachment; filename=\"faktura.pdf\"\r
Content-Transfer-Encoding: base64\r
\r
JVBERi0xLjQ=\r
--outer\r
Content-Type: application/octet-stream\r
Content-Disposition: attachment; filename=\"../../evil.exe\"\r
Content-Transfer-Encoding: base64\r
\r
TVo=\r
--outer--\r
";

    #[test]
    fn inline_images_become_data_urls_and_files_are_listed() {
        let raw = EMAIL_WITH_ATTACHMENTS.as_bytes();
        let parsed = parse_raw_email(raw).unwrap();
        assert_eq!(parsed.message_id.as_deref(), Some("<abc@example.cz>"));
        let content = email_content(raw, &parsed.body_html);
        assert!(content.body_html.contains("data:image/png;base64,iVBORw0KGgo="));
        assert!(!content.body_html.contains("cid:"));
        let names: Vec<_> = content.attachments.iter().map(|a| a.file_name.as_str()).collect();
        assert_eq!(names, ["faktura.pdf", "_.._evil.exe"]);
        assert!(!content.attachments[0].risky);
        assert!(content.attachments[1].risky);

        let (name, bytes) = attachment(raw, content.attachments[0].index).unwrap();
        assert_eq!(name, "faktura.pdf");
        assert_eq!(bytes, b"%PDF-1.4");
    }

    #[test]
    fn file_names_are_made_safe() {
        assert_eq!(safe_file_name("a/b\\c:d?.pdf"), "a_b_c_d_.pdf");
        assert_eq!(safe_file_name(" .. "), "priloha");
        assert!(is_risky_to_open("Faktura.PDF.exe"));
        assert!(!is_risky_to_open("foto.JPG"));
    }

    #[test]
    fn text_only_email_has_no_html() {
        let raw = b"From: a@b.cz\r\nSubject: x\r\n\r\nAhoj <b>tati</b>\r\n";
        let parsed = parse_raw_email(raw).unwrap();
        assert!(parsed.body_html.is_empty());
        assert!(parsed.body_text.contains("Ahoj <b>tati</b>"));
    }
}
