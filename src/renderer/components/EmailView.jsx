import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { api } from '../api';

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

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} MB`;
}

const FRAME_STYLE = `
  body {
    font-size: 14px;
    line-height: 1.5;
    max-width: 100%;
    padding: 12px;
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    word-wrap: break-word;
    overflow-x: hidden;
    color: #333;
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
    color: #0066cc;
  }
  pre, code {
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  body.plain-text {
    white-space: pre-wrap;
  }
`;

function EmailView({ email, onReply, onDelete, onWriteTo }) {
  const iframeRef = useRef(null);
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
    doc.write(`
      <!DOCTYPE html>
      <html lang="cs">
        <head>
          <meta charset="UTF-8">
          <meta http-equiv="Content-Security-Policy" content="${framePolicy(showImages)}">
          <style>${FRAME_STYLE}</style>
        </head>
        <body>${sanitizedHtml}</body>
      </html>
    `);
    doc.close();

    if (!email.body_html) {
      // Plain text goes in as text, so anything that looks like HTML is shown literally
      doc.body.className = 'plain-text';
      doc.body.textContent = email.body_text || '';
    }

    // Show where each link really goes when hovering over it
    doc.querySelectorAll('a[href]').forEach((link) => {
      link.title = link.getAttribute('href');
    });
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

  const formatDate = (timestamp) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('cs-CZ', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

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

  return (
    <div className="h-full flex flex-col">
      {/* Email Header - Compact */}
      <div className="bg-gray-50 border-b border-gray-200 px-4 py-2">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-gray-900 truncate">
              {email.subject || '(Bez předmětu)'}
            </h2>
            <div className="text-sm text-gray-600 mt-1">
              <span className="font-medium">Od:</span>{' '}
              {email.from_name && <span className="font-medium text-gray-900">{email.from_name} </span>}
              <span className="text-gray-800">&lt;{email.from_addr}&gt;</span>
              <span className="mx-2">|</span>
              <span className="font-medium">Komu:</span> {email.to_addr}
              <span className="mx-2">|</span>
              <span className="text-gray-500">{formatDate(email.date)}</span>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => onReply(email)}
              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Odpovědět
            </button>
            <button
              onClick={onDelete}
              className="px-3 py-1 text-sm bg-white border border-gray-300 text-red-600 rounded hover:bg-red-50"
            >
              Smazat
            </button>
          </div>
        </div>

        {suspiciousDomain && (
          <div className="mt-2 px-3 py-2 rounded bg-amber-100 border border-amber-300 text-amber-900 text-sm">
            <strong>Pozor:</strong> jméno odesílatele uvádí „{suspiciousDomain}“, ale email přišel z adresy{' '}
            <strong>{email.from_addr}</strong>. Může jít o podvod. Neklikejte na odkazy a nikam nezadávejte hesla
            ani čísla karet.
          </div>
        )}

        {attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.index}
                className="flex items-center gap-2 px-2 py-1 bg-white border border-gray-300 rounded text-sm"
              >
                <span aria-hidden="true">📎</span>
                <span className="font-medium text-gray-800">{attachment.file_name}</span>
                <span className="text-gray-500">{formatSize(attachment.size)}</span>
                {!attachment.risky && (
                  <button
                    onClick={() => openAttachment(attachment)}
                    className="px-2 py-0.5 text-blue-700 hover:bg-blue-50 rounded"
                  >
                    Otevřít
                  </button>
                )}
                <button
                  onClick={() => saveAttachment(attachment)}
                  className="px-2 py-0.5 text-blue-700 hover:bg-blue-50 rounded"
                >
                  Uložit
                </button>
              </div>
            ))}
          </div>
        )}
        {attachments.some((a) => a.risky) && (
          <div className="mt-1 text-xs text-gray-600">
            Některé přílohy mohou spustit program, proto je DadMail neotevře. Uložte je jen tehdy, když odesílatele znáte
            a přílohu jste čekali.
          </div>
        )}
        {attachmentMessage && (
          <div className={`mt-1 text-sm ${attachmentMessage.error ? 'text-red-700' : 'text-green-700'}`}>
            {attachmentMessage.text}
          </div>
        )}

        {hasRemoteImages && !showImages && (
          <div className="mt-2 flex items-center gap-3 text-sm text-gray-700">
            <span>Obrázky z internetu jsou skryté, aby odesílatel nepoznal, že jste email otevřeli.</span>
            <button
              onClick={() => setShowImages(true)}
              className="px-2 py-0.5 bg-white border border-gray-300 rounded hover:bg-gray-50"
            >
              Zobrazit obrázky
            </button>
          </div>
        )}
      </div>

      {/* Email Body */}
      <div className="flex-1 overflow-hidden">
        {email.body_html || email.body_text ? (
          <iframe
            // A new frame when images are allowed: a document's rules can only get stricter
            key={`${email.id}-${showImages}`}
            ref={iframeRef}
            sandbox="allow-same-origin"
            className="w-full h-full border-0"
            title="Obsah emailu"
          />
        ) : (
          <div className="p-4 text-center text-gray-400">
            Tento email nemá obsah
          </div>
        )}
      </div>
    </div>
  );
}

export default EmailView;
