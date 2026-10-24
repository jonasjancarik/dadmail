use lettre::message::header::ContentType;
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
        .to(email.to.parse().map_err(|e| format!("Neplatný příjemce: {e}"))?)
        .subject(email.subject);
    if let Some(id) = email.in_reply_to {
        builder = builder.in_reply_to(id.clone()).references(id);
    }
    let message = builder
        .header(ContentType::TEXT_PLAIN)
        .body(email.text)
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
    mailer.send(message).await.map_err(|e| e.to_string())?;
    Ok(sent)
}
