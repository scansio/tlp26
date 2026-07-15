interface LogoProps {
  /** 'horizontal' = icon mark + TLP26 wordmark side by side (default)
   *  'icon'       = icon mark only (for collapsed sidebar / favicons) */
  variant?: 'horizontal' | 'icon';
  /** Height in px — width scales proportionally */
  height?: number;
  className?: string;
}

export function Logo({ variant = 'horizontal', height = 40, className }: LogoProps) {
  if (variant === 'icon') {
    const w = height;
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={w}
        height={height}
        viewBox="0 0 512 512"
        aria-label="TLP26"
        className={className}
      >
        <defs>
          <linearGradient id="tlp-icon-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#0c0e1a"/>
            <stop offset="100%" stopColor="#101428"/>
          </linearGradient>
        </defs>
        <rect width="512" height="512" rx="90" ry="90" fill="url(#tlp-icon-bg)"/>
        <rect x="90" y="0" width="332" height="5" rx="2.5" fill="#6366f1" opacity="0.95"/>
        <ellipse cx="256" cy="360" rx="160" ry="60" fill="#6366f1" opacity="0.07"/>
        <text
          x="256" y="248"
          fontFamily="'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif"
          fontSize="164" fontWeight="800" fill="#ffffff"
          textAnchor="middle" letterSpacing="-6"
        >TLP</text>
        <text
          x="256" y="384"
          fontFamily="'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif"
          fontSize="120" fontWeight="700" fill="#6366f1"
          textAnchor="middle" letterSpacing="-4"
        >26</text>
      </svg>
    );
  }

  // Horizontal: icon mark (square) + wordmark
  // ViewBox: 0 0 220 56 — icon occupies 0..44, gap 12, wordmark 56..220
  const scale = height / 56;
  const w = Math.round(220 * scale);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={w}
      height={height}
      viewBox="0 0 220 56"
      aria-label="TLP26"
      className={className}
    >
      <defs>
        <linearGradient id="tlp-logo-bg" x1="0" y1="0" x2="44" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#0c0e1a"/>
          <stop offset="100%" stopColor="#101428"/>
        </linearGradient>
      </defs>

      {/* ── Icon mark ───────────────────────────────────────────────────── */}
      <rect x="0" y="6" width="44" height="44" rx="8" fill="url(#tlp-logo-bg)"/>
      {/* top accent */}
      <rect x="4" y="6" width="36" height="2.5" rx="1.25" fill="#6366f1"/>
      {/* TLP */}
      <text
        x="22" y="29"
        fontFamily="'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif"
        fontSize="13.5" fontWeight="800" fill="#ffffff"
        textAnchor="middle" letterSpacing="-0.5"
      >TLP</text>
      {/* 26 */}
      <text
        x="22" y="43"
        fontFamily="'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif"
        fontSize="10" fontWeight="700" fill="#6366f1"
        textAnchor="middle" letterSpacing="-0.3"
      >26</text>

      {/* ── Wordmark ─────────────────────────────────────────────────────── */}
      <text
        x="56" y="28"
        fontFamily="'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif"
        fontSize="22" fontWeight="700" fill="currentColor"
        dominantBaseline="middle" letterSpacing="-0.8"
      >TLP26</text>
    </svg>
  );
}
