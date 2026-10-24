import { useState, useMemo, useRef, useEffect, useCallback } from 'react';

// Every row is one line of text, so rows have a fixed height and only the
// rows in view (plus a few extra) need to be rendered
const ROW_HEIGHT = 33;
const OVERSCAN = 10;

function Inbox({ emails, selectedEmail, onEmailClick, loading }) {
  const [sortField, setSortField] = useState('date');
  const [sortDirection, setSortDirection] = useState('desc');
  
  // Column widths in pixels
  const [colWidths, setColWidths] = useState({
    from: 160,
    subject: 220,
    preview: null, // null = flex
    date: 140,
  });
  
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const resizeObserver = useRef(null);
  
  // Callback ref: the scroll container only exists once there are emails to show
  const scrollContainerRef = useCallback((node) => {
    resizeObserver.current?.disconnect();
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

  const sortedEmails = useMemo(() => {
    if (!emails || emails.length === 0) return [];
    
    return [...emails].sort((a, b) => {
      let aVal, bVal;
      
      switch (sortField) {
        case 'from':
          aVal = (a.from_name || a.from_addr || '').toLowerCase();
          bVal = (b.from_name || b.from_addr || '').toLowerCase();
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
  }, [emails, sortField, sortDirection]);

  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastRow = Math.min(sortedEmails.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  const formatDate = (timestamp) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString('cs-CZ', { 
      day: '2-digit', 
      month: '2-digit', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const ResizeHandle = ({ col }) => (
    <div
      onMouseDown={(e) => handleResizeStart(e, col)}
      className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-400 z-10"
    />
  );

  const SortHeader = ({ field, children, width, resizable = true }) => (
    <th 
      className="relative px-3 py-2 text-left select-none border-r border-gray-200"
      style={{ width: width || 'auto' }}
    >
      <div 
        className="flex items-center gap-1 cursor-pointer hover:text-blue-600"
        onClick={() => handleSort(field)}
      >
        {children}
        {sortField === field && (
          <span className="text-blue-600">
            {sortDirection === 'asc' ? '▲' : '▼'}
          </span>
        )}
      </div>
      {resizable && <ResizeHandle col={field} />}
    </th>
  );

  if (loading && emails.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-white">
        <div className="text-center text-gray-500">
          Načítání...
        </div>
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-white">
        <div className="text-center text-gray-500">
          Žádné emaily
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="h-full overflow-auto bg-white"
    >
      <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
        <thead className="bg-gray-100 sticky top-0 border-b border-gray-300">
          <tr>
            <th className="w-6 px-2 py-2"></th>
            <SortHeader field="from" width={colWidths.from}>Od</SortHeader>
            <SortHeader field="subject" width={colWidths.subject}>Předmět</SortHeader>
            <th className="px-3 py-2 text-left text-gray-500 border-r border-gray-200">Náhled</th>
            <SortHeader field="date" width={colWidths.date} resizable={false}>Datum</SortHeader>
          </tr>
        </thead>
        <tbody>
          {firstRow > 0 && <tr style={{ height: firstRow * ROW_HEIGHT }} />}
          {sortedEmails.slice(firstRow, lastRow).map((email) => (
            <tr
              key={email.id}
              style={{ height: ROW_HEIGHT }}
              onClick={() => onEmailClick(email.id)}
              className={`cursor-pointer border-b border-gray-100 hover:bg-blue-50 ${
                selectedEmail?.id === email.id ? 'bg-blue-100' : ''
              } ${!email.is_read ? 'font-semibold bg-blue-50/50' : ''}`}
            >
              <td className="px-2 py-1.5 text-center" style={{ width: 24 }}>
                {!email.is_read && (
                  <div className="w-2 h-2 bg-blue-600 rounded-full mx-auto"></div>
                )}
              </td>
              <td 
                className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap" 
                style={{ width: colWidths.from }}
                title={email.from_addr}
              >
                {email.from_name || email.from_addr}
              </td>
              <td 
                className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap" 
                style={{ width: colWidths.subject }}
                title={email.subject}
              >
                {email.subject || '(Bez předmětu)'}
              </td>
              <td className="px-3 py-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-gray-500 font-normal">
                {email.preview || '—'}
              </td>
              <td 
                className="px-3 py-1.5 whitespace-nowrap text-gray-600 text-right"
                style={{ width: colWidths.date }}
              >
                {formatDate(email.date)}
              </td>
            </tr>
          ))}
          {lastRow < sortedEmails.length && (
            <tr style={{ height: (sortedEmails.length - lastRow) * ROW_HEIGHT }} />
          )}
        </tbody>
      </table>
    </div>
  );
}

export default Inbox;
