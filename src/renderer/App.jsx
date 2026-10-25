import { useState, useEffect, useRef, useCallback } from 'react';
import Inbox from './components/Inbox';
import EmailView from './components/EmailView';
import Compose from './components/Compose';
import Settings from './components/Settings';
import SearchBar from './components/SearchBar';
import { api } from './api';
import { initZoom } from './zoom';
import { setShortcutHandler, handleShortcutKey } from './shortcuts';
import Icon from './components/Icon';

// Until the server's list arrives
const DEFAULT_FOLDERS = [
  { id: 'inbox', label: 'Doručená pošta', role: 'inbox', depth: 0, unread: 0 },
  { id: 'sent', label: 'Odeslaná pošta', role: 'sent', depth: 0, unread: 0 },
  { id: 'trash', label: 'Koš', role: 'trash', depth: 0, unread: 0 },
];

const ROLE_ICONS = { inbox: 'mail', drafts: 'compose', sent: 'send', archive: 'archive', spam: 'warning', trash: 'trash' };
// Folders of his own writing: counting unread there is noise
const NO_UNREAD_COUNT = new Set(['sent', 'drafts']);

// How long "Vrátit" stays available after deleting
const UNDO_SECONDS = 8;

// What the background sync is doing, next to the toolbar buttons
function SyncStatus({ status }) {
  if (!status.message) return null;
  const tone = {
    syncing: 'text-ink-600',
    success: 'text-emerald-700',
    error: 'text-red-700',
  }[status.status] || 'text-ink-500';
  return (
    <div className={`flex items-center gap-2 text-sm min-w-0 ${tone}`} role="status">
      {status.status === 'error' && <Icon name="warning" className="w-4 h-4" />}
      {status.status === 'success' && <Icon name="check" className="w-4 h-4" />}
      <span className="truncate">{status.message}</span>
      {status.status === 'syncing' && status.progress !== undefined && (
        <div className="w-20 h-1.5 bg-ink-200 rounded-full overflow-hidden">
          <div className="h-full bg-accent-600 rounded-full transition-all" style={{ width: `${status.progress}%` }} />
        </div>
      )}
    </div>
  );
}

function FolderList({ folder, folders, onSelect }) {
  return (
    <nav className="w-60 shrink-0 bg-ink-50 border-r border-ink-200 p-2 space-y-0.5 overflow-y-auto" aria-label="Složky">
      {folders.map((f) => {
        const active = f.id === folder;
        const unread = NO_UNREAD_COUNT.has(f.role) ? 0 : f.unread;
        return (
          <button
            key={f.id}
            onClick={() => onSelect(f.id)}
            aria-current={active ? 'page' : undefined}
            style={{ paddingLeft: `${12 + f.depth * 16}px` }}
            className={`w-full h-10 pr-3 flex items-center gap-3 rounded-lg text-left transition-colors ${
              active ? 'bg-accent-100 text-accent-900 font-semibold' : 'text-ink-700 hover:bg-ink-100'
            }`}
          >
            <Icon
              name={ROLE_ICONS[f.role] || 'folder'}
              className={`w-[18px] h-[18px] ${active ? 'text-accent-700' : 'text-ink-500'}`}
            />
            <span className="flex-1 truncate">{f.label}</span>
            {unread > 0 && (
              <span className="min-w-6 px-1.5 rounded-md bg-accent-700 text-white text-xs font-semibold text-center tabular-nums">
                {unread}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

function App() {
  const [folder, setFolder] = useState('inbox');
  const folderRef = useRef('inbox');
  const [emails, setEmails] = useState([]);
  const [folders, setFolders] = useState(DEFAULT_FOLDERS);
  const [selectedEmail, setSelectedEmail] = useState(null);
  // What the compose window was opened for: { mode: 'new' | 'reply' | 'forward', email?, to? }
  const [compose, setCompose] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchQueryRef = useRef('');
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState({ status: 'idle', message: '' });
  // A newer DadMail version, and whether it is being installed
  const [update, setUpdate] = useState(null);
  // The "Vrátit" bar after deleting
  const [undo, setUndo] = useState(null);
  const undoTimer = useRef(null);
  const [paneHeight, setPaneHeight] = useState(300); // pixels for top pane
  const isDraggingPane = useRef(false);
  const containerRef = useRef(null);
  const emailViewRef = useRef(null);
  // The list in its current sort order, for moving with the arrow keys
  const sortedIds = useRef([]);

  const handlePaneMouseDown = useCallback((e) => {
    e.preventDefault();
    isDraggingPane.current = true;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDraggingPane.current || !containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const newHeight = e.clientY - containerRect.top;
      // Clamp between 100px and container height - 100px
      const clampedHeight = Math.max(100, Math.min(newHeight, containerRect.height - 100));
      setPaneHeight(clampedHeight);
    };

    const handleMouseUp = () => {
      isDraggingPane.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleShortcutKey);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleShortcutKey);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unsubscribers = [];

    const init = async () => {
      // The inbox first: reading settings can wait for the system password store
      loadEmails();
      await loadSettings();
      if (cancelled) return;

      unsubscribers.push(api.onEmailsUpdated((count) => {
        loadEmails();
        if (count > 0) {
          setSyncStatus({ status: 'success', message: count === 1 ? 'Přišel nový email' : `Přišly nové emaily: ${count}` });
          setTimeout(() => {
            setSyncStatus(prev => prev.status === 'success' ? { status: 'idle', message: '' } : prev);
          }, 4000);
        }
      }));

      if (api.onSyncStatus) {
        unsubscribers.push(api.onSyncStatus((status) => {
          setSyncStatus(status);
        }));
      }
    };

    init();
    // Look for a new version shortly after start, once the inbox has loaded
    const updateTimer = setTimeout(async () => {
      const version = await api.checkForUpdate();
      if (version && !cancelled) setUpdate({ version, installing: false, error: null });
    }, 10000);
    return () => {
      clearTimeout(updateTimer);
      cancelled = true;
      unsubscribers.forEach(unsubscribe => unsubscribe());
    };
  }, []);

  // Search once typing pauses instead of on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      searchQueryRef.current = searchQuery;
      loadEmails();
    }, searchQuery ? 250 : 0);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadSettings = async () => {
    const loadedSettings = await api.getSettings();
    initZoom(loadedSettings.zoom);
    if (!loadedSettings.email || loadedSettings.has_password !== '1') {
      setShowSettings(true);
    }
  };

  const loadEmails = async () => {
    setLoading(true);
    try {
      // Read folder and query from refs so sync-triggered reloads keep what is shown
      const [loadedEmails, loadedFolders] = await Promise.all([
        api.getEmails(folderRef.current, searchQueryRef.current),
        api.getFolders(),
      ]);
      setEmails(loadedEmails);
      if (loadedFolders.length > 0) setFolders(loadedFolders);
      // A folder that disappeared from the server: back to the inbox
      if (loadedFolders.length > 0 && !loadedFolders.some((f) => f.id === folderRef.current)) openFolder('inbox');
    } catch (error) {
      console.error('Error loading emails:', error);
    } finally {
      setLoading(false);
    }
  };

  const openFolder = (id) => {
    folderRef.current = id;
    setFolder(id);
    setSelectedEmail(null);
    setEmails([]);
    loadEmails();
  };

  const handleEmailClick = async (emailId) => {
    const email = await api.getEmail(emailId);
    setSelectedEmail(email);
    // Opening marks the email as read; update the list locally instead of reloading it
    setEmails(prev => prev.map(e => (e.id === emailId && !e.is_read ? { ...e, is_read: 1 } : e)));
    if (email && !email.is_read) {
      setFolders(prev => prev.map(f => (f.id === folderRef.current ? { ...f, unread: Math.max(0, f.unread - 1) } : f)));
    }
  };

  // Check Seznam for new mail now, like Thunderbird's "Načíst zprávy"
  const checkMail = () => {
    api.syncNow();
    loadEmails();
  };

  const startCompose = (mode, email = null, to = '') => setCompose({ mode, email, to });

  const handleEmailSent = () => {
    setCompose(null);
    loadEmails();
  };

  const showUndo = (email) => {
    clearTimeout(undoTimer.current);
    setUndo({ id: email.id });
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_SECONDS * 1000);
  };

  const handleDelete = async () => {
    if (!selectedEmail || folderRef.current === 'trash') return;
    // Select the next email, as Thunderbird does
    const ids = sortedIds.current;
    const next = ids[ids.indexOf(selectedEmail.id) + 1] ?? ids[ids.indexOf(selectedEmail.id) - 1];
    await api.deleteEmail(selectedEmail.id);
    showUndo(selectedEmail);
    setSelectedEmail(null);
    await loadEmails();
    if (next) handleEmailClick(next);
  };

  const handleUndo = async () => {
    clearTimeout(undoTimer.current);
    const id = undo?.id;
    setUndo(null);
    if (id) {
      await api.restoreEmail(id);
      await loadEmails();
      if (folderRef.current === 'inbox') handleEmailClick(id);
    }
  };

  const handleRestore = async () => {
    if (!selectedEmail) return;
    await api.restoreEmail(selectedEmail.id);
    setSelectedEmail(null);
    loadEmails();
  };

  const toggleRead = async () => {
    if (!selectedEmail) return;
    if (selectedEmail.is_read) {
      await api.markUnread(selectedEmail.id);
      setSelectedEmail({ ...selectedEmail, is_read: 0 });
      loadEmails();
    } else {
      handleEmailClick(selectedEmail.id);
    }
  };

  const moveSelection = (step) => {
    const ids = sortedIds.current;
    if (ids.length === 0) return;
    const index = selectedEmail ? ids.indexOf(selectedEmail.id) : -1;
    const next = ids[Math.min(Math.max(index + step, 0), ids.length - 1)];
    if (next && next !== selectedEmail?.id) handleEmailClick(next);
  };

  // Thunderbird's keys. Kept in a ref so the handler always sees the current state.
  const shortcutRef = useRef(null);
  shortcutRef.current = (event) => {
    if (compose || showSettings) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const typing = event.target.ownerDocument === document && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
    const run = (action) => {
      event.preventDefault();
      action();
    };
    if (ctrl && key === 'n') return run(() => startCompose('new'));
    if (ctrl && key === 'r' && selectedEmail) return run(() => startCompose('reply', selectedEmail));
    if (ctrl && key === 'l' && selectedEmail) return run(() => startCompose('forward', selectedEmail));
    if (ctrl && key === 'p' && selectedEmail) return run(() => emailViewRef.current?.print());
    if (typing || ctrl || event.altKey) return;
    if (event.key === 'ArrowDown') return run(() => moveSelection(1));
    if (event.key === 'ArrowUp') return run(() => moveSelection(-1));
    if (event.key === 'Delete' && selectedEmail) return run(handleDelete);
    if (key === 'm' && selectedEmail) return run(toggleRead);
  };
  useEffect(() => setShortcutHandler((event) => shortcutRef.current(event)), []);

  if (showSettings) {
    return (
      <Settings
        onClose={() => {
          setShowSettings(false);
          loadSettings();
          loadEmails();
        }}
      />
    );
  }

  const syncing = syncStatus.status === 'syncing';
  const currentRole = folders.find((f) => f.id === folder)?.role ?? null;

  return (
    <div className="h-screen flex flex-col bg-ink-100">
      <header className="h-14 shrink-0 bg-white border-b border-ink-200 px-4 flex items-center gap-3">
        <div className="flex items-center gap-2.5 pr-2 shrink-0">
          <img src="/app-icon.png" alt="" className="w-7 h-7" />
          <span className="text-lg font-semibold tracking-tight text-ink-900">DadMail</span>
        </div>

        <button onClick={() => startCompose('new')} className="btn-primary" title="Nový email (Ctrl+N)">
          <Icon name="compose" className="w-[18px] h-[18px]" />
          Nový email
        </button>
        <button onClick={checkMail} className="btn-quiet" disabled={syncing}>
          <Icon name="refresh" className={`w-[18px] h-[18px] ${syncing ? 'animate-spin' : ''}`} />
          Načíst zprávy
        </button>

        <div className="flex-1 min-w-0">
          <SyncStatus status={syncStatus} />
        </div>

        <div className="flex-1 min-w-[9rem] max-w-72">
          <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Hledat v poště" />
        </div>
        <button onClick={() => setShowSettings(true)} className="btn-quiet" title="Nastavení">
          <Icon name="settings" className="w-[18px] h-[18px]" />
          Nastavení
        </button>
      </header>

      {update && (
        <div className="shrink-0 bg-accent-50 border-b border-accent-100 px-4 py-2 flex items-center gap-3 text-sm text-accent-900">
          <Icon name="download" className="w-[18px] h-[18px] text-accent-700" />
          {update.installing ? (
            <span>Stahuji novou verzi. DadMail se za chvíli sám znovu spustí…</span>
          ) : (
            <>
              <span>Je připravená nová verze DadMail ({update.version}).</span>
              <button
                onClick={async () => {
                  setUpdate({ ...update, installing: true, error: null });
                  const result = await api.installUpdate();
                  if (!result.success) setUpdate({ ...update, installing: false, error: result.error });
                }}
                className="btn-primary h-8"
              >
                Aktualizovat
              </button>
              {update.error && <span className="text-red-700">{update.error}</span>}
            </>
          )}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <FolderList folder={folder} folders={folders} onSelect={openFolder} />

        {/* Main Content - Vertical Split */}
        <main ref={containerRef} className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Email List (Top) */}
          <div style={{ height: paneHeight }} className="min-h-[100px] overflow-hidden flex-shrink-0 bg-white">
            <Inbox
              emails={emails}
              folderRole={currentRole}
              selectedEmail={selectedEmail}
              onEmailClick={handleEmailClick}
              onSortedChange={(ids) => { sortedIds.current = ids; }}
              loading={loading}
              searchQuery={searchQuery}
            />
          </div>

          {/* Resizable Divider */}
          <div
            onMouseDown={handlePaneMouseDown}
            className="group h-2 shrink-0 cursor-ns-resize bg-ink-100 border-y border-ink-200 flex items-center justify-center"
            title="Přetažením změníte velikost"
          >
            <div className="w-10 h-1 rounded-full bg-ink-300 group-hover:bg-accent-500 transition-colors" />
          </div>

          {/* Email Content (Bottom) */}
          <div className="flex-1 overflow-hidden bg-white">
            {selectedEmail ? (
              <EmailView
                ref={emailViewRef}
                email={selectedEmail}
                onReply={() => startCompose('reply', selectedEmail)}
                onForward={() => startCompose('forward', selectedEmail)}
                onDelete={handleDelete}
                onRestore={handleRestore}
                folderRole={currentRole}
                onToggleRead={toggleRead}
                onWriteTo={(address) => startCompose('new', null, address)}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-ink-400">
                <Icon name="mail" className="w-10 h-10" />
                <p className="text-base text-ink-500">Klikněte na email v seznamu nahoře a zobrazí se tady.</p>
              </div>
            )}
          </div>
        </main>
      </div>

      {undo && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 pl-4 pr-2 h-12 rounded-xl bg-ink-900 text-white shadow-dialog" role="status">
          <Icon name="trash" className="w-[18px] h-[18px] text-ink-300" />
          <span>Email je v koši.</span>
          <button onClick={handleUndo} className="btn h-9 bg-white/10 hover:bg-white/20 text-white">
            Vrátit
          </button>
        </div>
      )}

      {compose && (
        <Compose
          mode={compose.mode}
          source={compose.email}
          initialTo={compose.to}
          onClose={() => setCompose(null)}
          onSent={handleEmailSent}
        />
      )}
    </div>
  );
}

export default App;
