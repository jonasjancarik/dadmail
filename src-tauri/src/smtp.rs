use lettre::message::header::ContentType;
use lettre::message::{Attachment, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

pub struct OutgoingEmail {
    pub from: String,
    pub password: String,
    pub to: String,
    pub subject: String,
    pub text: String,
    // Message-ID of the email being replied to, for threading
    pub in_reply_to: Option<String>,
    // File name and contents
    pub attachments: Vec<(String, Vec<u8>)>,
}

// A sent email, kept so a copy can be saved to the Sent folder
pub struct SentEmail {
    pub message_id: String,
    pub raw: Vec<u8>,
}

pub async fn send_email(email: OutgoingEmail) -> Result<SentEmail, String> {
    let mut builder = Message::builder()
        .message_id(None)
        .from(email.from.parse().map_err(|e| format!("Neplatný odesílatel: {e}"))?)
        .to(email.to.parse().map_err(|_| crate::errors::BAD_RECIPIENT.to_string())?)
        .subject(email.subject);
    if let Some(id) = email.in_reply_to {
        builder = builder.in_reply_to(id.clone()).references(id);
    }
    let message = if email.attachments.is_empty() {
        builder.header(ContentType::TEXT_PLAIN).body(email.text)
    } else {
        let mut parts = MultiPart::mixed().singlepart(SinglePart::plain(email.text));
        for (name, contents) in email.attachments {
            let mime = mime_guess::from_path(&name).first_or_octet_stream().to_string();
            let content_type = ContentType::parse(&mime).unwrap_or(ContentType::parse("application/octet-stream").unwrap());
            parts = parts.singlepart(Attachment::new(name).body(contents, content_type));
        }
        builder.multipart(parts)
    }
    .map_err(|e| e.to_string())?;

    // relay() connects on port 465 with TLS
    let mailer = AsyncSmtpTransport::<Tokio1Executor>::relay("smtp.seznam.cz")
        .map_err(|e| e.to_string())?
        .credentials(Credentials::new(email.from, email.password))
        .build();
    let sent = SentEmail {
        message_id: message.headers().get_raw("Message-ID").unwrap_or_default().to_string(),
        raw: message.formatted(),
    };
    mailer
        .send(message)
        .await
        .map_err(|e| crate::errors::describe(&e.to_string()))?;
    Ok(sent)
}
