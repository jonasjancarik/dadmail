import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import Icon from './Icon';

// Every row is one line of text, so rows have a fixed height and only the
// rows in view (plus a few extra) need to be rendered
const ROW_HEIGHT = 38;
const OVERSCAN = 10;

function Inbox({ emails, folderRole, selectedEmail, onEmailClick, onSortedChange, loading, searchQuery }) {
  const [sortField, setSortField] = useState('date');
  const [sortDirection, setSortDirection] = useState('desc');
  
  // Column widths in pixels
  const [colWidths, setColWidths] = useState({
    from: 160,
    subject: 220,
    preview: null, // null = flex
    date: 165,
  });
  
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const resizeObserver = useRef(null);
  
  // Callback ref: the scroll container only exists once there are emails to show
  const scrollContainerRef = useCallback((node) => {
    resizeObserver.current?.disconnect();
    scrollNode.current = node;
    if (!node) return;
    setViewportHeight(node.clientHeight);
    resizeObserver.current = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    resizeObserver.current.observe(node);
  }, []);
  
  const resizingCol = useRef(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const handleResizeStart = useCallback((e, col) => {
    e.preventDefault();
    e.stopPropagation();
    resizingCol.current = col;
    startX.current = e.clientX;
    startWidth.current = colWidths[col];
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [colWidths]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!resizingCol.current) return;
      const delta = e.clientX - startX.current;
      const newWidth = Math.max(60, startWidth.current + delta);
      setColWidths(prev => ({ ...prev, [resizingCol.current]: newWidth }));
    };

    const handleMouseUp = () => {
      resizingCol.current = null;
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

  // In sent mail and drafts the interesting person is the recipient
  const sent = folderRole === 'sent' || folderRole === 'drafts';

  const sortedEmails = useMemo(() => {
    if (!emails || emails.length === 0) return [];
    
    return [...emails].sort((a, b) => {
      let aVal, bVal;
      
      switch (sortField) {
        case 'from':
          aVal = (sent ? a.to_addr : a.from_name || a.from_addr || '').toLowerCase();
          bVal = (sent ? b.to_addr : b.from_name || b.from_addr || '').toLowerCase();
          break;
        case 'subject':
          aVal = (a.subject || '').toLowerCase();
          bVal = (b.subject || '').toLowerCase();
          break;
        case 'date':
        default:
          aVal = a.date || 0;
          bVal = b.date || 0;
          break;
      }
      
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [emails, folderRole, sortField, sortDirection]);

  const person = (email) => (sent ? email.to_addr : email.from_name || email.from_addr);

  useEffect(() => {
    onSortedChange?.(sortedEmails.map((e) => e.id));
  }, [sortedEmails]);

  // Keep the selected email in view (e.g. when moving with the arrow keys)
  const scrollNode = useRef(null);
  useEffect(() => {
    const node = scrollNode.current;
    if (!node || !selectedEmail) return;
    const index = sortedEmails.findIndex((e) => e.id === selectedEmail.id);
    if (index < 0) return;
    const top = index * ROW_HEIGHT;
    const headerHeight = 36;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + ROW_HEIGHT > node.scrollTop + node.clientHeight - headerHeight) {
      node.scrollTop = top + ROW_HEIGHT - node.clientHeight + headerHeight;
    }
  }, [selectedEmail?.id]);

  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(sortedEmails.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  const ResizeHandle = ({ col }) => (
    <div
      onMouseDown={(e) => handleResizeStart(e, col)}
      className="absolute right-0 top-2 bottom-2 w-1.5 cursor-col-resize border-r border-ink-200 hover:border-accent-500 z-10"
    />
  );

  const SortHeader = ({ field, children, width, resizable = true }) => (
    <th className="relative px-3 h-9 text-left font-medium select-none" style={{ width: width || 'auto' }}>
      <button
        className={`flex items-center gap-1 rounded hover:text-ink-900 ${sortField === field ? 'text-ink-800' : ''}`}
        onClick={() => handleSort(field)}
      >
        {children}
        {sortField === field && <span className="text-[10px] text-accent-700">{sortDirection === 'asc' ? '▲' : '▼'}</span>}
      </button>
      {resizable && <ResizeHandle col={field} />}
    </th>
  );

  if (loading && emails.length === 0) {
    return (
      <div className="h-full overflow-hidden" aria-label="Načítám emaily">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-6 px-9 border-b border-ink-100" style={{ height: ROW_HEIGHT }}>
            <div className="h-3 w-32 rounded bg-ink-100 animate-pulse" />
            <div className="h-3 w-56 rounded bg-ink-100 animate-pulse" />
            <div className="h-3 flex-1 rounded bg-ink-100/70 animate-pulse" />
            <div className="h-3 w-24 rounded bg-ink-100 animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
        <Icon name={searchQuery ? 'search' : folderRole === 'trash' ? 'trash' : 'mail'} className="w-9 h-9 text-ink-300" />
        {searchQuery ? (
          <p className="text-ink-600">Nic jsme nenašli pro „{searchQuery}“. Zkuste jiné slovo.</p>
        ) : folderRole === 'trash' ? (
          <p className="text-ink-600">Koš je prázdný.</p>
        ) : folderRole === 'spam' ? (
          <p className="text-ink-600">Žádná nevyžádaná pošta.</p>
        ) : folderRole === 'sent' ? (
          <p className="text-ink-600">Zatím tu nejsou žádné odeslané emaily.</p>
        ) : folderRole === 'inbox' ? (
          <p className="text-ink-600">Zatím tu nejsou žádné emaily. Stahují se ze Seznamu, chvíli to může trvat.</p>
        ) : (
          <p className="text-ink-600">V této složce nejsou žádné emaily.</p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="h-full overflow-auto"
    >
      <table className="w-full border-collapse" style={{ tableLayout: 'fixed' }}>
        <thead className="sticky top-0 z-20 bg-white text-xs text-ink-500 shadow-[inset_0_-1px_0_theme(colors.ink.200)]">
          <tr>
            <th className="w-7" aria-label="Nepřečtené"></th>
            <SortHeader field="from" width={colWidths.from}>{sent ? 'Komu' : 'Od'}</SortHeader>
            <SortHeader field="subject" width={colWidths.subject}>Předmět</SortHeader>
            <th className="px-3 h-9 text-left font-medium">Náhled</th>
            <SortHeader field="date" width={colWidths.date} resizable={false}>Datum</SortHeader>
          </tr>
        </thead>
        <tbody>
          {firstRow > 0 && <tr style={{ height: firstRow * ROW_HEIGHT }} />}
          {sortedEmails.slice(firstRow, lastRow).map((email) => {
            const selected = selectedEmail?.id === email.id;
            const unread = !email.is_read;
            return (
              <tr
                key={email.id}
                style={{ height: ROW_HEIGHT }}
                onClick={() => onEmailClick(email.id)}
                className={`cursor-pointer border-b border-ink-100 transition-colors ${
                  selected
                    ? 'bg-accent-50 shadow-[inset_3px_0_0_theme(colors.accent.600)]'
                    : 'hover:bg-ink-50'
                } ${unread ? 'font-semibold text-ink-900' : 'text-ink-700'}`}
              >
                <td className="text-center">
                  {unread && <span className="inline-block w-2 h-2 rounded-full bg-accent-600" title="Nepřečtený" />}
                </td>
                <td className="px-3 truncate" title={sent ? email.to_addr : email.from_addr}>
                  {person(email)}
                </td>
                <td className="px-3 truncate" title={email.subject}>
                  {email.subject || '(Bez předmětu)'}
                </td>
                <td className="px-3 truncate text-sm font-normal text-ink-500">
                  {email.preview || '—'}
                </td>
                <td className="px-3 whitespace-nowrap text-sm text-right tabular-nums text-ink-600">
                  {formatDate(email.date)}
                </td>
              </tr>
            );
          })}
          {lastRow < sortedEmails.length && (
            <tr style={{ height: (sortedEmails.length - lastRow) * ROW_HEIGHT }} />
          )}
        </tbody>
      </table>
    </div>
  );
}

// Today and yesterday by name, like Thunderbird; older emails with the full date
function formatDate(timestamp) {
  const date = new Date(timestamp * 1000);
  const time = date.toLocaleTimeString('cs-CZ', { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return `dnes ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `včera ${time}`;
  return `${date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' })} ${time}`;
}

export default Inbox;
