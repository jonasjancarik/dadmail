import Icon from './Icon';

function SearchBar({ value, onChange, placeholder }) {
  return (
    <div className="relative">
      <Icon name="search" className="w-[18px] h-[18px] absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Hledat v poště"
        className="w-full h-9 pl-9 pr-9 text-sm bg-ink-100 border border-transparent rounded-lg placeholder:text-ink-500
          transition-colors hover:bg-ink-200/60 focus:outline-none focus:bg-white focus:border-accent-600 focus:ring-2 focus:ring-accent-100
          [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-ink-400 hover:text-ink-700 hover:bg-ink-100"
          title="Zrušit hledání"
          aria-label="Zrušit hledání"
        >
          <Icon name="close" className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export default SearchBar;
