// A small set of line icons drawn for DadMail, all on a 24px grid with the same stroke

const PATHS = {
  compose: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  reply: (
    <>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h10a6 6 0 0 1 6 6v1" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6 7l1 13h10l1-13" />
    </>
  ),
  paperclip: <path d="M16.5 7.5l-7.8 7.8a2 2 0 0 0 2.8 2.8l8-8a4 4 0 0 0-5.6-5.6l-8 8a6 6 0 0 0 8.5 8.5L20 15.4" />,
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M5 20h14" />
    </>
  ),
  open: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 6.5L12 13l8.5-6.5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4L2.5 20h19L12 4z" />
      <path d="M12 10v4.5M12 17.5v.01" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.75" />
      <path d="M21 16l-5-5-9 8.5" />
    </>
  ),
  back: (
    <>
      <path d="M10 6l-6 6 6 6" />
      <path d="M4 12h16" />
    </>
  ),
  send: (
    <>
      <path d="M4 12L20 4l-5 16-3-7-8-1z" />
      <path d="M12 13l8-9" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4" rx="1" />
      <path d="M5 8.5v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-10" />
      <path d="M10 12.5h4" />
    </>
  ),
  forward: (
    <>
      <path d="M15 7l5 5-5 5" />
      <path d="M20 12H10a6 6 0 0 0-6 6v1" />
    </>
  ),
  print: (
    <>
      <path d="M7 9V4h10v5" />
      <rect x="4" y="9" width="16" height="7" rx="1.5" />
      <path d="M7 14h10v6H7z" />
    </>
  ),
  unread: (
    <>
      <rect x="3" y="5" width="15" height="13" rx="2" />
      <path d="M3.5 6.5L10.5 12l3.5-2.7" />
      <circle cx="19" cy="6" r="2.5" fill="currentColor" stroke="none" />
    </>
  ),
  restore: (
    <>
      <path d="M4 12a8 8 0 1 0 2.34-5.66" />
      <path d="M4 4v5h5" />
    </>
  ),
};

function Icon({ name, className = 'w-5 h-5' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export default Icon;
