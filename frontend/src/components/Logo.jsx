export function LogoMark({ className = 'h-9 w-9' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#1E40AF" />
      <rect x="14" y="18" width="36" height="10" rx="3" fill="#FFFFFF" />
      <rect x="14" y="34" width="22" height="12" rx="3" fill="#F97316" />
      <circle cx="44" cy="40" r="6" fill="#FFFFFF" />
    </svg>
  );
}

export function Logo({ dark = false, className = '' }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <div className="leading-tight">
        <div className={`text-lg font-extrabold tracking-tight ${dark ? 'text-white' : 'text-pos-royal'}`}>
          ATC <span className="text-pos-orange">POS</span>
        </div>
        <div className={`text-[10px] font-medium uppercase tracking-[0.18em] ${dark ? 'text-blue-200' : 'text-slate-400'}`}>
          by ATC Infocom
        </div>
      </div>
    </div>
  );
}
