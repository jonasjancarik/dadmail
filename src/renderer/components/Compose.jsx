import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Icon from './Icon';

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

  // Esc closes the window (but not while sending)
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !sending) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sending, onClose]);

  const handleSend = async () => {
    const missing = !to.trim()
      ? 'Vyplňte, komu email posíláte.'
      : !subject.trim()
        ? 'Doplňte předmět emailu.'
        : !text.trim()
          ? 'Napište text zprávy.'
          : null;
    if (missing) {
      setError(missing);
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 backdrop-blur-[2px] p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compose-title"
    >
      <div className="bg-white rounded-2xl shadow-dialog w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 h-14 shrink-0 border-b border-ink-200 flex items-center justify-between">
          <h2 id="compose-title" className="text-lg font-semibold text-ink-900">
            {replyTo ? 'Odpověď' : 'Nový email'}
          </h2>
          <button onClick={onClose} className="btn-quiet w-9 px-0" disabled={sending} aria-label="Zavřít" title="Zavřít">
            <Icon name="close" className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          <div className="flex items-center gap-3">
            <label htmlFor="compose-to" className="w-20 text-sm font-medium text-ink-600">Komu</label>
            <input
              id="compose-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="input-field disabled:bg-ink-50 disabled:text-ink-600"
              placeholder="adresa@seznam.cz"
              disabled={sending || !!replyTo}
            />
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="compose-subject" className="w-20 text-sm font-medium text-ink-600">Předmět</label>
            <input
              id="compose-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="input-field"
              disabled={sending}
            />
          </div>

          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full h-72 px-3 py-2.5 text-base leading-relaxed bg-white border border-ink-300 rounded-lg resize-none
              placeholder:text-ink-400 focus:outline-none focus:border-accent-600 focus:ring-2 focus:ring-accent-100"
            placeholder="Napište zprávu…"
            aria-label="Text zprávy"
            disabled={sending}
          />

          {error && (
            <div className="flex gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm" role="alert">
              <Icon name="warning" className="w-[18px] h-[18px]" />
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 shrink-0 border-t border-ink-200 bg-ink-50 flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-secondary" disabled={sending}>
            Zrušit
          </button>
          <button onClick={handleSend} className="btn-primary px-5" disabled={sending}>
            <Icon name="send" className="w-[18px] h-[18px]" />
            {sending ? 'Odesílám…' : 'Odeslat'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Compose;
