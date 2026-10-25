import { useState, useEffect } from 'react';
import { api } from '../api';
import { ZOOM_LEVELS, getZoom, setZoom } from '../zoom';
import Icon from './Icon';

function Settings({ onClose }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // The saved password is never sent to this screen, only which email it belongs to
  const [savedPasswordFor, setSavedPasswordFor] = useState(null);
  const [syncFromDate, setSyncFromDate] = useState('');
  const [zoom, setZoomState] = useState(getZoom());
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [reportErrors, setReportErrors] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const settings = await api.getSettings();
    if (settings.email) {
      setEmail(settings.email);
      if (settings.has_password === '1') {
        setSavedPasswordFor(settings.email);
      }
    }
    setReportErrors(settings.telemetry !== 'off');
    if (settings.sync_from_date) {
      setSyncFromDate(settings.sync_from_date);
    }
  };

  const hasSavedPassword = savedPasswordFor !== null && savedPasswordFor === email.trim();
  const missingCredentials = () => !email.trim() || (!password.trim() && !hasSavedPassword);

  const handleTest = async () => {
    if (missingCredentials()) {
      setError('Vyplňte email a heslo');
      return;
    }

    setTesting(true);
    setError('');
    setSuccess('');

    try {
      const result = await api.testConnection({
        email: email.trim(),
        password: password.trim(),
      });

      if (result.success) {
        setSuccess('Připojení funguje.');
      } else {
        setError('Připojení selhalo: ' + (result.error || 'Neznámá chyba'));
      }
    } catch (err) {
      setError('Chyba: ' + err.message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (missingCredentials()) {
      setError('Vyplňte email a heslo');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const settingsToSave = {
        email: email.trim(),
        password: password.trim(),
      };
      if (syncFromDate) {
        settingsToSave.sync_from_date = syncFromDate;
      }
      const result = await api.saveSettings(settingsToSave);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setSuccess('Uloženo.');
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err) {
      setError('Chyba: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const busy = testing || saving || clearing || reprocessing;

  const reprocess = async () => {
    setReprocessing(true);
    setError('');
    setSuccess('');
    const result = await api.reprocessEmails();
    if (result.success) {
      setSuccess(`Hotovo, zobrazení ${result.processed} emailů je obnovené.`);
    } else {
      setError(result.error || 'Nepodařilo se to.');
    }
    setReprocessing(false);
  };

  const clearAndDownload = async () => {
    setConfirmClear(false);
    setClearing(true);
    setError('');
    setSuccess('');
    const result = await api.clearEmails();
    if (result.success) {
      setSuccess('Emaily z tohoto počítače jsou smazané a stahují se znovu ze Seznamu.');
    } else {
      setError(result.error || 'Nepodařilo se to.');
    }
    setClearing(false);
  };

  return (
    <div className="min-h-screen bg-ink-100 overflow-y-auto">
      <div className="max-w-xl mx-auto px-6 py-8">
        {savedPasswordFor !== null && (
          <button onClick={onClose} className="btn-quiet -ml-3 mb-4">
            <Icon name="back" className="w-[18px] h-[18px]" />
            Zpět do pošty
          </button>
        )}

        <div className="flex items-center gap-3 mb-6">
          <img src="/app-icon.png" alt="" className="w-10 h-10" />
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Nastavení</h1>
        </div>

        {savedPasswordFor === null && !email && (
          <div className="mb-5 flex gap-3 px-4 py-3 rounded-xl bg-accent-50 border border-accent-100 text-accent-900">
            <Icon name="mail" className="w-5 h-5 mt-0.5 text-accent-700" />
            <p>Vítejte. Zadejte svou adresu na Seznamu a heslo, DadMail pak začne stahovat poštu.</p>
          </div>
        )}

        <section className="bg-white rounded-2xl shadow-soft p-6 space-y-5">
          <h2 className="text-lg font-semibold text-ink-900">Účet na Seznamu</h2>

          <div>
            <label htmlFor="settings-email" className="field-label">Emailová adresa</label>
            <input
              id="settings-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vas@seznam.cz"
              className="input-field"
              disabled={busy}
            />
          </div>

          <div>
            <label htmlFor="settings-password" className="field-label">Heslo</label>
            <input
              id="settings-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasSavedPassword ? 'Heslo je uložené, vyplňte jen pro změnu' : 'Vaše heslo'}
              className="input-field"
              disabled={busy}
            />
            <p className="field-hint">
              Pokud se na Seznam přihlašujete i kódem z telefonu, použijte heslo pro aplikace ze Seznamu.
            </p>
          </div>

          <div>
            <label htmlFor="settings-since" className="field-label">Stahovat emaily od data</label>
            <input
              id="settings-since"
              type="date"
              value={syncFromDate}
              onChange={(e) => setSyncFromDate(e.target.value)}
              className="input-field"
              disabled={busy}
            />
            <p className="field-hint">Nechte prázdné, aby se stáhly všechny emaily.</p>
          </div>

          {error && (
            <div className="flex gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm" role="alert">
              <Icon name="warning" className="w-[18px] h-[18px]" />
              {error}
            </div>
          )}
          {success && (
            <div className="flex gap-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm" role="status">
              <Icon name="check" className="w-[18px] h-[18px]" />
              {success}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={handleTest} className="btn-secondary flex-1" disabled={busy}>
              {testing ? 'Zkouším spojení…' : 'Vyzkoušet připojení'}
            </button>
            <button onClick={handleSave} className="btn-primary flex-1" disabled={busy}>
              {saving ? 'Ukládám…' : 'Uložit'}
            </button>
          </div>
        </section>

        <section className="bg-white rounded-2xl shadow-soft p-6 mt-5">
          <h2 className="text-lg font-semibold text-ink-900">Velikost textu</h2>
          <p className="text-sm text-ink-500 mt-1 mb-4">
            Změna se projeví hned. Jde to i klávesami Ctrl a + nebo Ctrl a −.
          </p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Velikost textu">
            {ZOOM_LEVELS.map((level) => {
              const active = Math.abs(level.value - zoom) < 0.01;
              return (
                <button
                  key={level.value}
                  role="radio"
                  aria-checked={active}
                  onClick={async () => setZoomState(await setZoom(level.value))}
                  className={`btn h-10 border ${
                    active
                      ? 'bg-accent-50 border-accent-600 text-accent-800'
                      : 'bg-white border-ink-200 text-ink-700 hover:bg-ink-50'
                  }`}
                  style={{ fontSize: `${Math.round(14 * level.value)}px` }}
                >
                  {level.label}
                </button>
              );
            })}
          </div>
        </section>

        <details className="group mt-5 bg-white rounded-2xl shadow-soft">
          <summary className="cursor-pointer list-none px-6 py-4 flex items-center justify-between text-ink-700 font-medium">
            Pro pokročilé
            <span className="text-ink-400 transition-transform group-open:rotate-90">›</span>
          </summary>
          <div className="px-6 pb-6 space-y-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={reportErrors}
                onChange={async (e) => {
                  setReportErrors(e.target.checked);
                  await api.saveSettings({ telemetry: e.target.checked ? 'on' : 'off' });
                }}
                className="mt-1 w-4 h-4 accent-accent-700"
              />
              <span>
                <span className="font-medium text-ink-800">Posílat hlášení o chybách</span>
                <span className="field-hint block mt-0.5">
                  Když se něco pokazí, DadMail pošle Jonášovi krátkou zprávu o tom, co selhalo. Nikdy v ní nejsou
                  emaily, jejich obsah ani adresy.
                </span>
              </span>
            </label>

            <div>
              <button onClick={reprocess} className="btn-secondary w-full" disabled={busy}>
                {reprocessing ? 'Obnovuji…' : 'Obnovit zobrazení emailů'}
              </button>
              <p className="field-hint">
                Znovu zpracuje uložené emaily, třeba když se některý zobrazuje špatně. Nic se nestahuje.
              </p>
            </div>
            <div>
              {confirmClear ? (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 space-y-3">
                  <p className="text-sm text-red-900">
                    Smazat emaily z tohoto počítače a stáhnout je znovu? Na Seznamu se nic nesmaže, ale stahování
                    může chvíli trvat.
                  </p>
                  <div className="flex gap-2">
                    <button onClick={clearAndDownload} className="btn bg-red-700 text-white hover:bg-red-800">
                      Ano, stáhnout znovu
                    </button>
                    <button onClick={() => setConfirmClear(false)} className="btn-secondary">
                      Ne
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setConfirmClear(true)} className="btn-danger w-full" disabled={busy}>
                  {clearing ? 'Mažu…' : 'Stáhnout všechny emaily znovu'}
                </button>
              )}
              <p className="field-hint">
                Smaže emaily z tohoto počítače a stáhne je ze Seznamu znovu. Na Seznamu zůstanou.
              </p>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

export default Settings;
