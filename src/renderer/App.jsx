import { useState, useEffect, useRef, useCallback } from 'react';
import Inbox from './components/Inbox';
import EmailView from './components/EmailView';
import Compose from './components/Compose';
import Settings from './components/Settings';
import SearchBar from './components/SearchBar';
import { api } from './api';
import { initZoom, handleZoomKey } from './zoom';
import Icon from './components/Icon';

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

function App() {
  const [emails, setEmails] = useState([]);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [showCompose, setShowCompose] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [replyToEmail, setReplyToEmail] = useState(null);
  const [composeTo, setComposeTo] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchQueryRef = useRef('');
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState({});
  const [syncStatus, setSyncStatus] = useState({ status: 'idle', message: '' });
  // A newer DadMail version, and whether it is being installed
  const [update, setUpdate] = useState(null);
  const [paneHeight, setPaneHeight] = useState(300); // pixels for top pane
  const isDraggingPane = useRef(false);
  const containerRef = useRef(null);

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
    document.addEventListener('keydown', handleZoomKey);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleZoomKey);
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
          setSyncStatus({ status: 'success', message: `+${count} nových` });
          setTimeout(() => {
            setSyncStatus(prev => prev.status === 'success' ? { status: 'idle', message: '' } : prev);
          }, 3000);
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
    setSettings(loadedSettings);
    initZoom(loadedSettings.zoom);
    if (!loadedSettings.email || loadedSettings.has_password !== '1') {
      setShowSettings(true);
    }
  };

  const loadEmails = async () => {
    setLoading(true);
    try {
      // Read the query from a ref so sync-triggered reloads keep the current search
      const loadedEmails = await api.getEmails(searchQueryRef.current);
      setEmails(loadedEmails);
    } catch (error) {
      console.error('Error loading emails:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailClick = async (emailId) => {
    const email = await api.getEmail(emailId);
    setSelectedEmail(email);
    // Opening marks the email as read; update the list locally instead of reloading it
    setEmails(prev => prev.map(e => (e.id === emailId && !e.is_read ? { ...e, is_read: 1 } : e)));
  };

  // Check Seznam for new mail now, like Thunderbird's "Načíst zprávy"
  const checkMail = () => {
    api.syncNow();
    loadEmails();
  };

  const handleReply = (email) => {
    setReplyToEmail(email);
    setShowCompose(true);
  };

  // An email address clicked inside an email
  const handleWriteTo = (address) => {
    setReplyToEmail(null);
    setComposeTo(address);
    setShowCompose(true);
  };

  const handleComposeClose = () => {
    setShowCompose(false);
    setReplyToEmail(null);
    setComposeTo('');
  };

  const handleEmailSent = () => {
    handleComposeClose();
    loadEmails();
  };

  const handleDelete = async () => {
    if (selectedEmail) {
      await api.deleteEmail(selectedEmail.id);
      setSelectedEmail(null);
      loadEmails();
    }
  };

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

  return (
    <div className="h-screen flex flex-col bg-ink-100">
      <header className="h-14 shrink-0 bg-white border-b border-ink-200 px-4 flex items-center gap-3">
        <div className="flex items-center gap-2.5 pr-2 shrink-0">
          <img src="/app-icon.png" alt="" className="w-7 h-7" />
          <span className="text-lg font-semibold tracking-tight text-ink-900">DadMail</span>
        </div>

        <button onClick={() => setShowCompose(true)} className="btn-primary">
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

      {/* Main Content - Vertical Split */}
      <main ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        {/* Email List (Top) */}
        <div style={{ height: paneHeight }} className="min-h-[100px] overflow-hidden flex-shrink-0 bg-white">
          <Inbox
            emails={emails}
            selectedEmail={selectedEmail}
            onEmailClick={handleEmailClick}
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
              email={selectedEmail}
              onReply={handleReply}
              onDelete={handleDelete}
              onWriteTo={handleWriteTo}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-ink-400">
              <Icon name="mail" className="w-10 h-10" />
              <p className="text-base text-ink-500">Klikněte na email v seznamu nahoře a zobrazí se tady.</p>
            </div>
          )}
        </div>
      </main>

      {/* Compose Modal */}
      {showCompose && (
        <Compose
          replyTo={replyToEmail}
          initialTo={composeTo}
          onClose={handleComposeClose}
          onSent={handleEmailSent}
        />
      )}
    </div>
  );
}

export default App;
