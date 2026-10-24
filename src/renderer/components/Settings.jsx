import { useState, useEffect } from 'react';
import { api } from '../api';

function Settings({ onClose }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [syncFromDate, setSyncFromDate] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const settings = await api.getSettings();
    if (settings.email) {
      setEmail(settings.email);
    }
    if (settings.sync_from_date) {
      setSyncFromDate(settings.sync_from_date);
    }
  };

  const handleTest = async () => {
    if (!email.trim() || !password.trim()) {
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
        setSuccess('Připojení úspěšné!');
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
    if (!email.trim() || !password.trim()) {
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
      await api.saveSettings(settingsToSave);
      setSuccess('Nastavení uloženo!');
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err) {
      setError('Chyba: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-gray-100 p-4">
      <div className="bg-white rounded shadow-lg w-full max-w-md p-6">
        <h1 className="text-xl font-bold text-gray-900 mb-4">Nastavení</h1>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email (Seznam.cz)
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vas@email.cz"
              className="input-field"
              disabled={testing || saving}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Heslo
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Vaše heslo"
              className="input-field"
              disabled={testing || saving}
            />
            <p className="mt-1 text-xs text-gray-500">
              Pokud máte 2FA, použijte aplikační heslo
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Synchronizovat od data
            </label>
            <input
              type="date"
              value={syncFromDate}
              onChange={(e) => setSyncFromDate(e.target.value)}
              className="input-field"
              disabled={testing || saving}
            />
            <p className="mt-1 text-xs text-gray-500">
              Ponechte prázdné pro všechny emaily
            </p>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded text-sm">
              {success}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              onClick={handleTest}
              className="btn-secondary flex-1"
              disabled={testing || saving}
            >
              {testing ? 'Testuji...' : 'Test připojení'}
            </button>
            <button
              onClick={handleSave}
              className="btn-primary flex-1"
              disabled={testing || saving}
            >
              {saving ? 'Ukládám...' : 'Uložit'}
            </button>
          </div>

          {!email && !password && (
            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded text-sm text-blue-800">
              <strong>První spuštění:</strong> Zadejte přihlašovací údaje Seznam.cz
            </div>
          )}

          {/* Database section */}
          <div className="border-t border-gray-200 pt-4 mt-4">
            <h3 className="text-sm font-medium text-gray-700 mb-2">Databáze</h3>
            
            <div className="space-y-2">
              <button
                onClick={async () => {
                  setReprocessing(true);
                  setError('');
                  setSuccess('');
                  try {
                    const result = await api.reprocessEmails();
                    if (result.success) {
                      setSuccess(`Přeparsováno ${result.processed} emailů`);
                    } else {
                      setError('Chyba: ' + (result.error || 'Nepodařilo se'));
                    }
                  } catch (err) {
                    setError('Chyba: ' + err.message);
                  } finally {
                    setReprocessing(false);
                  }
                }}
                className="w-full px-3 py-1.5 text-sm bg-white border border-gray-300 text-gray-700 rounded hover:bg-gray-50"
                disabled={clearing || reprocessing || testing || saving}
              >
                {reprocessing ? 'Zpracovávám...' : 'Přeparsovat emaily'}
              </button>
              <p className="text-xs text-gray-500">
                Znovu zpracuje zobrazení emailů bez stahování
              </p>
              
              <button
                onClick={async () => {
                  if (!confirm('Opravdu chcete smazat všechny emaily? Přihlašovací údaje zůstanou zachovány.')) {
                    return;
                  }
                  setClearing(true);
                  setError('');
                  setSuccess('');
                  try {
                    const result = await api.clearEmails();
                    if (result.success) {
                      setSuccess('Emaily smazány. Synchronizace začne znovu.');
                    } else {
                      setError('Chyba: ' + (result.error || 'Nepodařilo se smazat'));
                    }
                  } catch (err) {
                    setError('Chyba: ' + err.message);
                  } finally {
                    setClearing(false);
                  }
                }}
                className="w-full px-3 py-1.5 text-sm bg-white border border-red-300 text-red-600 rounded hover:bg-red-50"
                disabled={clearing || reprocessing || testing || saving}
              >
                {clearing ? 'Mažu...' : 'Smazat emaily a synchronizovat znovu'}
              </button>
              <p className="text-xs text-gray-500">
                Smaže vše a stáhne emaily znovu
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
