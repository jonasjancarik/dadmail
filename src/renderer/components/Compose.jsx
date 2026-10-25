import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Icon from './Icon';

const formatDate = (timestamp) =>
  new Date(timestamp * 1000).toLocaleString('cs-CZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const senderOf = (email) => (email.from_name ? `${email.from_name} <${email.from_addr}>` : email.from_addr);

// The original email under the reply, each line prefixed with "> "
function quoteOriginal(email) {
  const quoted = (email.body_text || '')
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `\n\nDne ${formatDate(email.date)} napsal(a) ${senderOf(email)}:\n${quoted}`;
}

// The forwarded email below the new text, with the header lines email programs use
function forwardOriginal(email) {
  return [
    '',
    '',
    '---------- Přeposlaná zpráva ----------',
    `Od: ${senderOf(email)}`,
    `Datum: ${formatDate(email.date)}`,
    `Předmět: ${email.subject}`,
    `Komu: ${email.to_addr}`,
    '',
    (email.body_text || '').trim(),
  ].join('\n');
}

function withPrefix(prefix, subject) {
  return subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix} ${subject}`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / 1024 / 1024).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} MB`;
}

// Same limit as the backend: attachments grow by a third when sent
const MAX_ATTACHMENTS = 20 * 1024 * 1024;

// mode: 'new', 'reply' or 'forward'; source: the email replied to or forwarded
function Compose({ mode = 'new', source = null, initialTo = '', onClose, onSent }) {
  const textRef = useRef(null);
  const reply = mode === 'reply' && source;
  const forward = mode === 'forward' && source;
  // The window is created fresh each time it opens, so a reply or forward can be filled in right away
  const [to, setTo] = useState(reply ? source.from_addr : initialTo);
  const [subject, setSubject] = useState(() => {
    if (reply) return withPrefix('Re:', source.subject);
    if (forward) return withPrefix('Fwd:', source.subject);
    return '';
  });
  const [text, setText] = useState(() => (reply ? quoteOriginal(source) : forward ? forwardOriginal(source) : ''));
  const [attachments, setAttachments] = useState(() =>
    forward
      ? (source.attachments || []).map((a) => ({ kind: 'original', emailId: source.id, index: a.index, name: a.file_name, size: a.size }))
      : []
  );
  const [contacts, setContacts] = useState([]);
  const [restoredDraft, setRestoredDraft] = useState(false);
  // Only save a draft once something was actually written
  const [dirty, setDirty] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const edit = (setter) => (value) => {
    setter(value);
    setDirty(true);
  };

  // Start typing above the quoted email
  useEffect(() => {
    const textarea = textRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(0, 0);
    textarea.scrollTop = 0;
  }, []);

  // Suggestions for "Komu", and a draft left from last time for this same email
  useEffect(() => {
    api.getContacts().then(setContacts);
    api.getDraft().then((draft) => {
      if (!draft) return;
      const sameEmail = draft.mode === mode && (draft.sourceId ?? null) === (source?.id ?? null);
      if (!sameEmail || (mode === 'new' && initialTo)) return;
      setTo(draft.to);
      setSubject(draft.subject);
      setText(draft.text);
      setAttachments(draft.attachments || []);
      setRestoredDraft(true);
    });
  }, []);

  // Save the draft shortly after typing stops
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      api.saveDraft({ mode, sourceId: source?.id ?? null, to, subject, text, attachments });
    }, 600);
    return () => clearTimeout(timer);
  }, [dirty, to, subject, text, attachments]);

  const discard = () => {
    api.saveDraft(null);
    onClose();
  };

  // Esc closes the window (but not while sending); the draft stays saved
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !sending) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sending, onClose]);

  const addFiles = async () => {
    const files = await api.pickFiles();
    if (files.length === 0) return;
    setAttachments((prev) => [...prev, ...files.map((f) => ({ kind: 'file', path: f.path, name: f.name, size: f.size }))]);
    setDirty(true);
  };

  const removeAttachment = (index) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);
  const tooBig = totalSize > MAX_ATTACHMENTS;

  const handleSend = async () => {
    const missing = !to.trim()
      ? 'Vyplňte, komu email posíláte.'
      : !subject.trim()
        ? 'Doplňte předmět emailu.'
        : !text.trim() && attachments.length === 0
          ? 'Napište text zprávy.'
          : null;
    if (missing) {
      setError(missing);
      return;
    }
    if (tooBig) {
      setError('Přílohy jsou dohromady moc velké. Poslat jde nejvýš 20 MB, zkuste jich poslat méně.');
      return;
    }

    setSending(true);
    setError('');

    try {
      const result = await api.sendEmail({
        to: to.trim(),
        subject: subject.trim(),
        text: text.trim(),
        replyToId: reply ? source.id : null,
        attachments: attachments.map((a) =>
          a.kind === 'file' ? { kind: 'file', path: a.path } : { kind: 'original', emailId: a.emailId, index: a.index }
        ),
      });

      if (result.success) {
        api.saveDraft(null);
        onSent();
      } else {
        setError(result.error || 'Email se nepodařilo odeslat.');
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
            {reply ? 'Odpověď' : forward ? 'Přeposlat email' : 'Nový email'}
          </h2>
          <button onClick={onClose} className="btn-quiet w-9 px-0" disabled={sending} aria-label="Zavřít" title="Zavřít">
            <Icon name="close" className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {restoredDraft && (
            <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-accent-50 border border-accent-100 text-sm text-accent-900">
              <Icon name="compose" className="w-[18px] h-[18px] text-accent-700" />
              <span className="flex-1">Pokračujete v rozepsaném emailu.</span>
              <button onClick={discard} className="btn-quiet h-8 text-accent-800">
                Zahodit a začít znovu
              </button>
            </div>
          )}

          <div className="flex items-center gap-3">
            <label htmlFor="compose-to" className="w-20 text-sm font-medium text-ink-600">Komu</label>
            <input
              id="compose-to"
              type="text"
              inputMode="email"
              autoComplete="off"
              list="compose-contacts"
              value={to}
              onChange={(e) => edit(setTo)(e.target.value)}
              className="input-field disabled:bg-ink-50 disabled:text-ink-600"
              placeholder="Začněte psát jméno nebo adresu"
              disabled={sending || !!reply}
            />
            <datalist id="compose-contacts">
              {contacts.map((c) => (
                <option key={c.address} value={c.name ? `${c.name} <${c.address}>` : c.address} />
              ))}
            </datalist>
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="compose-subject" className="w-20 text-sm font-medium text-ink-600">Předmět</label>
            <input
              id="compose-subject"
              type="text"
              value={subject}
              onChange={(e) => edit(setSubject)(e.target.value)}
              className="input-field"
              disabled={sending}
            />
          </div>

          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => edit(setText)(e.target.value)}
            className="w-full h-72 px-3 py-2.5 text-base leading-relaxed bg-white border border-ink-300 rounded-lg resize-none
              placeholder:text-ink-400 focus:outline-none focus:border-accent-600 focus:ring-2 focus:ring-accent-100"
            placeholder="Napište zprávu…"
            aria-label="Text zprávy"
            disabled={sending}
          />

          {attachments.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <div key={`${a.name}-${i}`} className="flex items-center gap-2 h-9 pl-3 pr-1 rounded-lg bg-ink-50 border border-ink-200 text-sm">
                    <Icon name="paperclip" className="w-4 h-4 text-ink-500" />
                    <span className="font-medium text-ink-800 max-w-[14rem] truncate" title={a.name}>{a.name}</span>
                    <span className="text-ink-500 tabular-nums">{formatSize(a.size)}</span>
                    <button
                      onClick={() => removeAttachment(i)}
                      className="btn-quiet h-7 w-7 px-0"
                      aria-label={`Odebrat přílohu ${a.name}`}
                      title="Odebrat přílohu"
                      disabled={sending}
                    >
                      <Icon name="close" className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
              <p className={`text-xs ${tooBig ? 'text-red-700' : 'text-ink-500'}`}>
                Přílohy celkem {formatSize(totalSize)}
                {tooBig && ' – to je víc, než jde poslat (nejvýš 20 MB).'}
              </p>
            </div>
          )}

          {error && (
            <div className="flex gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm" role="alert">
              <Icon name="warning" className="w-[18px] h-[18px]" />
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 shrink-0 border-t border-ink-200 bg-ink-50 flex items-center gap-2">
          <button onClick={addFiles} className="btn-secondary" disabled={sending}>
            <Icon name="paperclip" className="w-[18px] h-[18px]" />
            Přiložit soubor
          </button>
          <button onClick={discard} className="btn-quiet text-red-700 hover:text-red-800" disabled={sending}>
            Zahodit
          </button>
          <div className="flex-1" />
          <button onClick={onClose} className="btn-secondary" disabled={sending} title="Rozepsaný email zůstane uložený">
            Zavřít
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
