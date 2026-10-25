import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { api } from '../api';
import { handleShortcutKey } from '../shortcuts';
import Icon from './Icon';

const SANITIZE_OPTIONS = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'img', 'hr', 'blockquote', 'pre', 'code'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'style'],
  ALLOW_DATA_ATTR: false,
};

// Rules for the email frame: no scripts, and pictures from the internet only when allowed.
// Embedded pictures (data:) always show. The frame also inherits the app's own policy
// (app.security.csp in src-tauri/tauri.conf.json), which must allow these images.
const framePolicy = (allowRemoteImages) =>
  `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${allowRemoteImages ? ' https: http:' : ''}`;

const REMOTE_IMAGE = /<img[^>]+src=["']?https?:|url\(\s*["']?https?:/i;

// If the sender's name mentions a domain (e.g. "Banka info@banka.cz") that differs
// from the address the email really came from, return that domain
function mismatchedSenderDomain(name, address) {
  const baseDomain = (domain) => domain.toLowerCase().split('.').slice(-2).join('.');
  const actual = baseDomain(address.split('@').pop() || '');
  const mentioned = (name || '').match(/[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/gi) || [];
  for (const text of mentioned) {
    const domain = baseDomain(text.split('@').pop());
    if (domain !== actual) return domain;
  }
  return null;
}

function formatDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleString('cs-CZ', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} MB`;
}

const FRAME_STYLE = `
  body {
    font-size: 15px;
    line-height: 1.6;
    max-width: 100%;
    padding: 16px 24px 32px;
    margin: 0;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    word-wrap: break-word;
    overflow-x: hidden;
    color: #1e293b;
  }
  * {
    max-width: 100%;
    box-sizing: border-box;
  }
  img {
    max-width: 100%;
    height: auto;
  }
  table {
    max-width: 100%;
    overflow-x: auto;
    display: block;
  }
  a {
    color: #1d4ed8;
  }
  pre, code {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .print-header {
    display: none;
  }
  @media print {
    .print-header {
      display: block;
      margin: 0 0 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid #cbd5e1;
      font-size: 13px;
      color: #334155;
      white-space: normal;
    }
    .print-header h1 {
      font-size: 18px;
      margin: 0 0 6px;
      color: #0f172a;
    }
  }
  body.plain-text {
    white-space: pre-wrap;
    max-width: 75ch;
  }
`;

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const EmailView = forwardRef(function EmailView(
  { email, folderRole, onReply, onForward, onDelete, onRestore, onToggleRead, onWriteTo },
  ref
) {
  const iframeRef = useRef(null);

  // Print just the email, with subject, sender and date on top (shown only on paper)
  const print = () => iframeRef.current?.contentWindow?.print();
  useImperativeHandle(ref, () => ({ print }));
  const [showImages, setShowImages] = useState(false);
  const [attachmentMessage, setAttachmentMessage] = useState(null);

  const sanitizedHtml = email?.body_html ? DOMPurify.sanitize(email.body_html, SANITIZE_OPTIONS) : '';
  const hasRemoteImages = REMOTE_IMAGE.test(sanitizedHtml);

  useEffect(() => {
    setShowImages(false);
    setAttachmentMessage(null);
  }, [email?.id]);

  useEffect(() => {
    if (!email || !iframeRef.current) return;
    const doc = iframeRef.current.contentDocument || iframeRef.current.contentWindow.document;

    doc.open();
    // Trimmed: whitespace after </body> would end up inside the body, visible in plain-text emails
    doc.write(`
      <!DOCTYPE html>
      <html lang="cs">
        <head>
          <meta charset="UTF-8">
          <meta http-equiv="Content-Security-Policy" content="${framePolicy(showImages)}">
          <style>${FRAME_STYLE}</style>
        </head>
        <body><div class="print-header"><h1>${escapeHtml(email.subject || '')}</h1>Od: ${escapeHtml(
          email.from_name ? `${email.from_name} <${email.from_addr}>` : email.from_addr
        )}<br>Komu: ${escapeHtml(email.to_addr)}<br>${escapeHtml(formatDate(email.date))}</div>${sanitizedHtml}</body>
      </html>
    `.trim());
    doc.close();

    if (!email.body_html) {
      // Plain text goes in as text, so anything that looks like HTML is shown literally
      doc.body.className = 'plain-text';
      doc.body.append(email.body_text || '');
    }

    // Show where each link really goes when hovering over it
    doc.querySelectorAll('a[href]').forEach((link) => {
      link.title = link.getAttribute('href');
    });
    doc.addEventListener('keydown', handleShortcutKey);
    // Links open in the browser; email addresses open a new email in DadMail
    doc.addEventListener('click', (event) => {
      const link = event.target.closest?.('a[href]');
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute('href').trim();
      if (/^mailto:/i.test(href)) {
        onWriteTo(decodeURIComponent(href.slice(7).split('?')[0]));
      } else if (/^https?:\/\//i.test(href)) {
        api.openLink(href);
      }
    });
  }, [email, showImages, sanitizedHtml]);

  if (!email) {
    return null;
  }


  const suspiciousDomain = mismatchedSenderDomain(email.from_name, email.from_addr);
  const attachments = email.attachments || [];

  const openAttachment = async (attachment) => {
    setAttachmentMessage(null);
    const result = await api.openAttachment(email.id, attachment.index);
    if (!result.success) {
      setAttachmentMessage({ error: true, text: result.error });
    }
  };

  const saveAttachment = async (attachment) => {
    setAttachmentMessage(null);
    const result = await api.saveAttachment(email.id, attachment.index);
    setAttachmentMessage(
      result.success
        ? { error: false, text: `Uloženo do složky Stažené soubory jako ${result.fileName}` }
        : { error: true, text: `Přílohu se nepodařilo uložit: ${result.error}` }
    );
  };

  const senderName = email.from_name || email.from_addr;

  return (
    <article className="h-full flex flex-col">
      <header className="shrink-0 px-6 pt-3 pb-3 border-b border-ink-200 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onReply} className="btn-primary" title="Odpovědět (Ctrl+R)">
            <Icon name="reply" className="w-[18px] h-[18px]" />
            Odpovědět
          </button>
          <button onClick={onForward} className="btn-secondary" title="Přeposlat (Ctrl+L)">
            <Icon name="forward" className="w-[18px] h-[18px]" />
            Přeposlat
          </button>
          <button onClick={print} className="btn-quiet" title="Vytisknout (Ctrl+P)">
            <Icon name="print" className="w-[18px] h-[18px]" />
            Vytisknout
          </button>
          <button onClick={onToggleRead} className="btn-quiet" title="Přečtené / nepřečtené (M)">
            <Icon name={email.is_read ? 'unread' : 'check'} className="w-[18px] h-[18px]" />
            {email.is_read ? 'Označit jako nepřečtené' : 'Označit jako přečtené'}
          </button>
          <div className="flex-1" />
          {folderRole === 'trash' || folderRole === 'spam' ? (
            <button onClick={onRestore} className="btn-secondary">
              <Icon name="restore" className="w-[18px] h-[18px]" />
              {folderRole === 'spam' ? 'Není to spam' : 'Obnovit do doručené pošty'}
            </button>
          ) : null}
          {folderRole === 'trash' ? null : (
            <button onClick={onDelete} className="btn-danger" title="Smazat (Delete)">
              <Icon name="trash" className="w-[18px] h-[18px]" />
              Smazat
            </button>
          )}
        </div>

        <h1 className="text-xl font-semibold text-ink-900 [text-wrap:balance]">
          {email.subject || '(Bez předmětu)'}
        </h1>

        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 shrink-0 rounded-xl bg-accent-100 text-accent-800 font-semibold text-lg flex items-center justify-center"
            aria-hidden="true"
          >
            {senderName.trim().charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate">
              {email.from_name && <span className="font-semibold text-ink-900">{email.from_name} </span>}
              <span className="text-ink-600">&lt;{email.from_addr}&gt;</span>
            </div>
            <div className="text-sm text-ink-500 truncate">
              Komu: {email.to_addr} · {formatDate(email.date)}
            </div>
          </div>
        </div>

        {suspiciousDomain && (
          <div className="flex gap-3 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
            <Icon name="warning" className="w-5 h-5 mt-0.5 text-amber-600" />
            <p>
              <strong>Pozor, může jít o podvod.</strong> Jméno odesílatele uvádí „{suspiciousDomain}“, ale email
              přišel z adresy <strong>{email.from_addr}</strong>. Neklikejte na odkazy a nikam nezadávejte hesla
              ani čísla karet.
            </p>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.index}
                className="flex items-center gap-2 h-10 pl-3 pr-1 rounded-lg bg-ink-50 border border-ink-200 text-sm"
              >
                <Icon name="paperclip" className="w-4 h-4 text-ink-500" />
                <span className="font-medium text-ink-800 max-w-[16rem] truncate" title={attachment.file_name}>
                  {attachment.file_name}
                </span>
                <span className="text-ink-500 tabular-nums">{formatSize(attachment.size)}</span>
                <span className="w-px h-5 bg-ink-200 mx-1" />
                {!attachment.risky && (
                  <button onClick={() => openAttachment(attachment)} className="btn-quiet h-8 px-2.5">
                    <Icon name="open" className="w-4 h-4" />
                    Otevřít
                  </button>
                )}
                <button onClick={() => saveAttachment(attachment)} className="btn-quiet h-8 px-2.5">
                  <Icon name="download" className="w-4 h-4" />
                  Uložit
                </button>
              </div>
            ))}
          </div>
        )}
        {attachments.some((a) => a.risky) && (
          <p className="text-sm text-ink-600">
            Některé přílohy mohou spustit program, proto je DadMail neotevře. Uložte je jen tehdy, když odesílatele
            znáte a přílohu jste čekali.
          </p>
        )}
        {attachmentMessage && (
          <p className={`text-sm ${attachmentMessage.error ? 'text-red-700' : 'text-emerald-700'}`} role="status">
            {attachmentMessage.text}
          </p>
        )}

        {hasRemoteImages && !showImages && (
          <div className="flex items-center gap-3 text-sm text-ink-600">
            <Icon name="image" className="w-[18px] h-[18px] text-ink-400" />
            <span>Obrázky z internetu jsou skryté, aby odesílatel nepoznal, že jste email otevřeli.</span>
            <button onClick={() => setShowImages(true)} className="btn-secondary h-8">
              Zobrazit obrázky
            </button>
          </div>
        )}
      </header>

      {/* Email Body */}
      <div className="flex-1 overflow-hidden">
        {email.body_html || email.body_text ? (
          <iframe
            // A new frame when images are allowed: a document's rules can only get stricter
            key={`${email.id}-${showImages}`}
            ref={iframeRef}
            // allow-modals lets the email be printed; scripts stay blocked
            sandbox="allow-same-origin allow-modals"
            className="w-full h-full border-0"
            title="Obsah emailu"
          />
        ) : (
          <div className="p-6 text-center text-ink-400">
            Tento email nemá obsah
          </div>
        )}
      </div>
    </article>
  );
});

export default EmailView;
