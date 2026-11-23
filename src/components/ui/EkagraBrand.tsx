import React from 'react';

interface EkagraMarkProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<EkagraMarkProps['size']>, string> = {
  sm: 'h-7 w-7',
  md: 'h-9 w-9',
  lg: 'h-11 w-11',
};

/**
 * Original geometric Ekagra mark: single-pointed focus aperture ring + precision center core
 * crafted to stay crisp at 16px, 28px, and hero sizes on light and dark charcoal surfaces.
 */
export const EkagraMark: React.FC<EkagraMarkProps> = ({
  size = 'sm',
  className = '',
}) => (
  <svg
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
    className={`${SIZE_CLASSES[size]} shrink-0 ${className}`}
  >
    <rect
      x="2"
      y="2"
      width="60"
      height="60"
      rx="16"
      fill="#141513"
      stroke="#2C2D28"
      strokeWidth="2.5"
    />
    <path
      d="M32 13C42.4934 13 51 21.5066 51 32C51 42.4934 42.4934 51 32 51C21.5066 51 13 42.4934 13 32C13 24.4744 17.3755 17.9718 23.7279 14.8927"
      stroke="#B9E769"
      strokeWidth="4"
      strokeLinecap="round"
    />
    <path
      d="M32 19V24M32 40V45M19 32H24M40 32H45"
      stroke="#B9E769"
      strokeWidth="2.75"
      strokeLinecap="round"
      strokeOpacity="0.75"
    />
    <circle cx="32" cy="32" r="5.25" fill="#B9E769" />
  </svg>
);

interface EkagraLogoProps {
  size?: 'sm' | 'md';
  showTagline?: boolean;
  className?: string;
}

export const EkagraLogo: React.FC<EkagraLogoProps> = ({
  size = 'sm',
  showTagline = false,
  className = '',
}) => (
  <div className={`inline-flex items-center gap-2.5 ${className}`}>
    <EkagraMark size={size} />
    <div className="leading-none">
      <span
        className={`block font-display font-bold tracking-[-0.025em] text-[var(--df-text)] whitespace-nowrap ${
          size === 'md' ? 'text-xl' : 'text-lg'
        }`}
      >
        Ekagra
      </span>
      {showTagline && (
        <span className="mt-0.5 block text-[10px] font-medium tracking-wide text-[var(--df-text-muted)]">
          Single-pointed focus
        </span>
      )}
    </div>
  </div>
);
