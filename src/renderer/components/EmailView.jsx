import { useEffect, useRef } from 'react';

function EmailView({ email, onReply, onDelete }) {
  const iframeRef = useRef(null);

  useEffect(() => {
    if (email && iframeRef.current) {
      const iframe = iframeRef.current;
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      
      if (email.body_html) {
        doc.open();
        doc.write(`
          <!DOCTYPE html>
          <html lang="cs">
            <head>
              <meta charset="UTF-8">
              <style>
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
              </style>
            </head>
            <body>
              ${email.body_html}
            </body>
          </html>
        `);
        doc.close();
      } else if (email.body_text) {
        doc.open();
        doc.write(`
          <!DOCTYPE html>
          <html lang="cs">
            <head>
              <meta charset="UTF-8">
              <style>
                body {
                  font-size: 14px;
                  line-height: 1.5;
                  padding: 12px;
                  margin: 0;
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  white-space: pre-wrap;
                  word-wrap: break-word;
                  color: #333;
                }
              </style>
            </head>
            <body>${email.body_text}</body>
          </html>
        `);
        doc.close();
      }
    }
  }, [email]);

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
              <span className="font-medium">Od:</span> {email.from_name || email.from_addr}
              {email.from_name && <span className="text-gray-400 ml-1">&lt;{email.from_addr}&gt;</span>}
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
      </div>

      {/* Email Body */}
      <div className="flex-1 overflow-hidden">
        {email.body_html || email.body_text ? (
          <iframe
            ref={iframeRef}
            sandbox="allow-same-origin"
            className="w-full h-full border-0"
            title="Email content"
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
