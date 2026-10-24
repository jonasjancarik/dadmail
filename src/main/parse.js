import { simpleParser } from 'mailparser';

const PREVIEW_LENGTH = 200;

// Short one-line preview for the inbox list, computed once when the email is stored
export function makePreview(bodyText) {
  let text = bodyText || '';
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[?cid:[^\s\]]+\]?/gi, '');
  text = text.replace(/https?:\/\/[^\s]+/g, '');
  text = text.replace(/^(From|To|Subject|Date|Sent|Cc|Bcc):.*$/gim, '');
  text = text.replace(/[-_]{3,}/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, PREVIEW_LENGTH);
}

// Parse a raw email into the columns stored in the emails table.
// HTML is stored as-is and sanitized in the renderer right before display.
export async function parseRawEmail(raw) {
  const parsed = await simpleParser(raw);

  const from = parsed.from?.value?.[0] || {};
  const fromAddr = from.address || 'unknown@unknown';
  const fromName = from.name || fromAddr.split('@')[0];

  const to = parsed.to?.value?.[0] || {};
  const toAddr = to.address || 'unknown@unknown';

  const subject = parsed.subject || '(Bez předmětu)';
  let bodyText = parsed.text || '';
  const bodyHtml = parsed.html || '';

  if (!bodyText && !bodyHtml) {
    bodyText = '(Email nemá textový obsah)';
  }

  return {
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    date: parsed.date ? Math.floor(parsed.date.getTime() / 1000) : null,
    fromAddr,
    fromName,
    toAddr,
    subject,
    bodyHtml,
    bodyText,
    preview: makePreview(bodyText),
  };
}
