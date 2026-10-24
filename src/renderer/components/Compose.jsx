import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

// The original email under the reply, each line prefixed with "> "
function quoteOriginal(email) {
  const date = new Date(email.date * 1000).toLocaleString('cs-CZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const sender = email.from_name ? `${email.from_name} <${email.from_addr}>` : email.from_addr;
  const quoted = (email.body_text || '')
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `\n\nDne ${date} napsal(a) ${sender}:\n${quoted}`;
}

function Compose({ replyTo, initialTo = '', onClose, onSent }) {
  const textRef = useRef(null);
  // The window is created fresh each time it opens, so a reply can be filled in right away
  const [to, setTo] = useState(replyTo ? replyTo.from_addr : initialTo);
  const [subject, setSubject] = useState(() => {
    if (!replyTo) return '';
    return replyTo.subject.startsWith('Re:') ? replyTo.subject : `Re: ${replyTo.subject}`;
  });
  const [text, setText] = useState(() => (replyTo ? quoteOriginal(replyTo) : ''));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  // Start typing above the quoted email
  useEffect(() => {
    const textarea = textRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(0, 0);
    textarea.scrollTop = 0;
  }, []);

  const handleSend = async () => {
    if (!to.trim() || !subject.trim() || !text.trim()) {
      setError('Vyplňte všechna pole');
      return;
    }

    setSending(true);
    setError('');

    try {
      const result = await api.sendEmail({
        to: to.trim(),
        subject: subject.trim(),
        text: text.trim(),
        replyToId: replyTo?.id || null,
      });

      if (result.success) {
        onSent();
      } else {
        setError(result.error || 'Chyba při odesílání');
      }
    } catch (err) {
      setError('Chyba: ' + err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col m-4">
        {/* Header */}
        <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <h2 className="font-semibold text-gray-900">
            {replyTo ? 'Odpovědět' : 'Nový email'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            disabled={sending}
          >
            ×
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="flex items-center gap-2">
            <label className="w-16 text-sm text-gray-600">Komu:</label>
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:border-blue-500"
              disabled={sending || !!replyTo}
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="w-16 text-sm text-gray-600">Předmět:</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:border-blue-500"
              disabled={sending}
            />
          </div>

          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full px-2 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:border-blue-500 h-48 resize-none"
            placeholder="Napište zprávu..."
            disabled={sending}
          />

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-200 flex items-center justify-end gap-2 bg-gray-50">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded hover:bg-gray-50"
            disabled={sending}
          >
            Zrušit
          </button>
          <button
            onClick={handleSend}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            disabled={sending}
          >
            {sending ? 'Odesílám...' : 'Odeslat'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Compose;
