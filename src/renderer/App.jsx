import { useState, useEffect, useRef, useCallback } from 'react';
import Inbox from './components/Inbox';
import EmailView from './components/EmailView';
import Compose from './components/Compose';
import Settings from './components/Settings';
import SearchBar from './components/SearchBar';

function App() {
  const [emails, setEmails] = useState([]);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [showCompose, setShowCompose] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [replyToEmail, setReplyToEmail] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const searchQueryRef = useRef('');
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState({});
  const [syncStatus, setSyncStatus] = useState({ status: 'idle', message: '' });
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
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unsubscribers = [];

    const init = async () => {
      let retries = 0;
      while (!window.electronAPI && retries < 10) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retries++;
      }
      
      if (!window.electronAPI) {
        console.error('electronAPI not available');
        setLoading(false);
        return;
      }
      
      await loadSettings();
      await loadEmails();
      if (cancelled) return;

      unsubscribers.push(window.electronAPI.onEmailsUpdated((count) => {
        loadEmails();
        if (count > 0) {
          setSyncStatus({ status: 'success', message: `+${count} nových` });
          setTimeout(() => {
            setSyncStatus(prev => prev.status === 'success' ? { status: 'idle', message: '' } : prev);
          }, 3000);
        }
      }));

      if (window.electronAPI.onSyncStatus) {
        unsubscribers.push(window.electronAPI.onSyncStatus((status) => {
          setSyncStatus(status);
        }));
      }
    };

    init();
    return () => {
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
    if (window.electronAPI) {
      const loadedSettings = await window.electronAPI.getSettings();
      setSettings(loadedSettings);
      if (!loadedSettings.email || !loadedSettings.password) {
        setShowSettings(true);
      }
    }
  };

  const loadEmails = async () => {
    if (window.electronAPI) {
      setLoading(true);
      try {
        // Read the query from a ref so sync-triggered reloads keep the current search
        const loadedEmails = await window.electronAPI.getEmails(searchQueryRef.current);
        setEmails(loadedEmails);
      } catch (error) {
        console.error('Error loading emails:', error);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleEmailClick = async (emailId) => {
    if (window.electronAPI) {
      const email = await window.electronAPI.getEmail(emailId);
      setSelectedEmail(email);
      // Opening marks the email as read; update the list locally instead of reloading it
      setEmails(prev => prev.map(e => (e.id === emailId && !e.is_read ? { ...e, is_read: 1 } : e)));
    }
  };

  const handleReply = (email) => {
    setReplyToEmail(email);
    setShowCompose(true);
  };

  const handleComposeClose = () => {
    setShowCompose(false);
    setReplyToEmail(null);
  };

  const handleEmailSent = () => {
    setShowCompose(false);
    setReplyToEmail(null);
    loadEmails();
  };

  const handleDelete = async () => {
    if (selectedEmail && window.electronAPI) {
      await window.electronAPI.deleteEmail(selectedEmail.id);
      setSelectedEmail(null);
      loadEmails();
    }
  };

  if (!window.electronAPI && loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500">Načítání...</div>
      </div>
    );
  }

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

  return (
    <div className="h-screen flex flex-col bg-gray-100 text-sm">
      {/* Compact Toolbar */}
      <header className="bg-gray-200 border-b border-gray-300 px-3 py-1.5 flex items-center gap-3">
        <span className="font-bold text-gray-800">DadMail</span>
        
        {/* Sync Status */}
        {syncStatus.message && (
          <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-xs ${
            syncStatus.status === 'syncing' ? 'bg-blue-100 text-blue-700' :
            syncStatus.status === 'success' ? 'bg-green-100 text-green-700' :
            syncStatus.status === 'error' ? 'bg-red-100 text-red-700' :
            'bg-gray-100 text-gray-600'
          }`}>
            {syncStatus.status === 'syncing' && (
              <div className="animate-spin rounded-full h-3 w-3 border border-blue-600 border-t-transparent"></div>
            )}
            <span>{syncStatus.message}</span>
            {syncStatus.status === 'syncing' && syncStatus.progress !== undefined && (
              <div className="w-16 h-1 bg-blue-200 rounded-full">
                <div 
                  className="h-full bg-blue-600 rounded-full transition-all"
                  style={{ width: `${syncStatus.progress}%` }}
                ></div>
              </div>
            )}
          </div>
        )}
        
        <div className="flex-1" />
        
        {/* Search */}
        <div className="w-64">
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Hledat..."
          />
        </div>
        
        {/* Action Buttons */}
        <button
          onClick={() => loadEmails()}
          className="px-2 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50"
          title="Aktualizovat"
        >
          ⟳
        </button>
        <button
          onClick={() => setShowCompose(true)}
          className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Nový email
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="px-2 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50"
        >
          ⚙
        </button>
      </header>

      {/* Main Content - Vertical Split */}
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden">
        {/* Email List (Top) */}
        <div style={{ height: paneHeight }} className="min-h-[100px] overflow-hidden flex-shrink-0">
          <Inbox
            emails={emails}
            selectedEmail={selectedEmail}
            onEmailClick={handleEmailClick}
            loading={loading}
          />
        </div>

        {/* Resizable Divider */}
        <div
          onMouseDown={handlePaneMouseDown}
          className="h-1.5 bg-gray-300 hover:bg-blue-400 cursor-ns-resize flex-shrink-0 transition-colors"
        />

        {/* Email Content (Bottom) */}
        <div className="flex-1 overflow-hidden bg-white">
          {selectedEmail ? (
            <EmailView
              email={selectedEmail}
              onReply={handleReply}
              onDelete={handleDelete}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400">
              Vyberte email
            </div>
          )}
        </div>
      </div>

      {/* Compose Modal */}
      {showCompose && (
        <Compose
          replyTo={replyToEmail}
          onClose={handleComposeClose}
          onSent={handleEmailSent}
        />
      )}
    </div>
  );
}

export default App;
