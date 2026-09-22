export function LogoMark({ className = 'h-9 w-9' }) {
  return (
    <svg viewBox="0 0 96 96" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="vxm-m" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.16" stopColor="#E6EDF8" />
          <stop offset="0.42" stopColor="#AEBCCE" />
          <stop offset="0.52" stopColor="#8494A9" />
          <stop offset="0.72" stopColor="#CBD7E6" />
          <stop offset="1" stopColor="#EEF3FA" />
        </linearGradient>
        <linearGradient id="vxm-a" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="45" y2="100">
          <stop offset="0" stopColor="#2D6BFF" />
          <stop offset="1" stopColor="#3FD3EE" />
        </linearGradient>
        <clipPath id="vxm-v">
          <path d="M0 0H26L45 42.2 64 0H90L45 100Z" />
        </clipPath>
      </defs>
      <rect width="96" height="96" rx="22" fill="#04081A" />
      <g transform="translate(23 24) scale(0.556)">
        <g clipPath="url(#vxm-v)">
          <rect x="-4" y="-4" width="98" height="108" fill="url(#vxm-m)" />
          <path d="M-10-10H26V0L45 42.2 45.6 110H-10Z" fill="url(#vxm-a)" />
        </g>
      </g>
    </svg>
  );
}

export function Logo({ dark = false, className = '' }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <div className="leading-tight">
        <div className={`text-lg font-extrabold tracking-tight ${dark ? 'text-white' : 'text-pos-ink'}`}>
          VEXO <span className="text-pos-orange">Connect</span>
        </div>
        <div className={`text-[10px] font-medium uppercase tracking-[0.18em] ${dark ? 'text-blue-200' : 'text-slate-400'}`}>
          Point of Sale
        </div>
      </div>
    </div>
  );
}
