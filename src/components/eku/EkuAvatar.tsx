import React from 'react';
import type { EkuAvatarEmotion } from '../../types/eku';

interface EkuAvatarProps {
  emotion?: EkuAvatarEmotion;
  size?: 'sm' | 'md' | 'lg';
}

export const EkuAvatar: React.FC<EkuAvatarProps> = ({
  emotion = 'idle',
  size = 'md',
}) => {
  const dim = size === 'sm' ? 34 : size === 'lg' ? 56 : 48;

  const isListening = emotion === 'listening';
  const isThinking = emotion === 'thinking';
  const isSpeaking = emotion === 'speaking';
  const isSuccess = emotion === 'success';
  const isError = emotion === 'error';

  const antennaColor = isError
    ? '#F43F5E'
    : isListening
    ? 'var(--df-break-accent)'
    : 'var(--df-accent)';

  return (
    <div
      className={`relative inline-flex items-center justify-center ${
        size !== 'sm' ? 'animate-eku-float' : ''
      }`}
      style={{ width: dim, height: dim }}
      aria-hidden="true"
    >
      {isListening && (
        <span
          className="absolute inset-0 animate-ping rounded-full opacity-35"
          style={{ backgroundColor: 'var(--df-break-accent)' }}
        />
      )}
      {isSuccess && (
        <span
          className="absolute inset-0 rounded-full opacity-25 blur-[2px]"
          style={{ backgroundColor: 'var(--df-accent)' }}
        />
      )}

      <svg
        viewBox="0 0 64 64"
        width={dim}
        height={dim}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="relative drop-shadow-sm"
      >
        {/* Antenna */}
        <line
          x1="32"
          y1="7"
          x2="32"
          y2="14"
          stroke="var(--df-border-strong)"
          strokeWidth="2.8"
          strokeLinecap="round"
        />
        <circle
          cx="32"
          cy="6"
          r="3.5"
          fill={antennaColor}
          className={isThinking || isListening ? 'animate-pulse' : ''}
        />

        {/* Side ear pods */}
        <rect
          x="5"
          y="27"
          width="5"
          height="13"
          rx="2.5"
          fill="var(--df-border-strong)"
        />
        <rect
          x="54"
          y="27"
          width="5"
          height="13"
          rx="2.5"
          fill="var(--df-border-strong)"
        />

        {/* Head shell */}
        <rect
          x="10"
          y="14"
          width="44"
          height="38"
          rx="14"
          fill="var(--df-surface)"
          stroke={isError ? '#F43F5E' : isListening ? 'var(--df-break-accent)' : 'var(--df-border-strong)'}
          strokeWidth="2.4"
        />

        {/* Rounded visor */}
        <rect
          x="15"
          y="20"
          width="34"
          height="24"
          rx="9"
          fill="var(--df-cta)"
        />

        {/* Expressive Eyes */}
        {isSuccess ? (
          <g stroke="var(--df-accent)" strokeWidth="2.6" strokeLinecap="round">
            <path d="M21 31 Q24.5 26 28 31" />
            <path d="M36 31 Q39.5 26 43 31" />
          </g>
        ) : isError ? (
          <g stroke="#FB7185" strokeWidth="2.5" strokeLinecap="round">
            <path d="M22 27 L27 32 M27 27 L22 32" />
            <path d="M37 27 L42 32 M42 27 L37 32" />
          </g>
        ) : (
          <g
            className={
              isThinking
                ? 'animate-eku-scan'
                : emotion === 'idle'
                ? 'animate-eku-blink'
                : ''
            }
          >
            <ellipse
              cx="24.5"
              cy="30"
              rx={isListening ? 3.5 : 3.1}
              ry={isListening ? 4.2 : 3.7}
              fill={isListening ? 'var(--df-break-accent)' : 'var(--df-accent)'}
            />
            <ellipse
              cx="39.5"
              cy="30"
              rx={isListening ? 3.5 : 3.1}
              ry={isListening ? 4.2 : 3.7}
              fill={isListening ? 'var(--df-break-accent)' : 'var(--df-accent)'}
            />
            <circle cx="25.5" cy="28.6" r="1" fill="var(--df-surface)" opacity="0.85" />
            <circle cx="40.5" cy="28.6" r="1" fill="var(--df-surface)" opacity="0.85" />
          </g>
        )}

        {/* Expressive Mouth / Voice Equalizer */}
        {isSpeaking ? (
          <g fill="var(--df-accent)">
            <rect x="25" y="36.5" width="2.2" height="5" rx="1.1" className="animate-eku-wave-1" />
            <rect x="29" y="35.5" width="2.2" height="6.5" rx="1.1" className="animate-eku-wave-2" />
            <rect x="33" y="35.5" width="2.2" height="6.5" rx="1.1" className="animate-eku-wave-3" />
            <rect x="37" y="36.5" width="2.2" height="5" rx="1.1" className="animate-eku-wave-1" />
          </g>
        ) : isThinking ? (
          <g fill="var(--df-accent)" opacity="0.9">
            <circle cx="27" cy="39" r="1.4" />
            <circle cx="32" cy="39" r="1.4" />
            <circle cx="37" cy="39" r="1.4" />
          </g>
        ) : isError ? (
          <path
            d="M27 40 Q32 37 37 40"
            stroke="#FB7185"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M27.5 38 Q32 41.2 36.5 38"
            stroke={isListening ? 'var(--df-break-accent)' : 'var(--df-accent)'}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        )}

        {/* Cute mini torso base */}
        <rect
          x="22"
          y="53"
          width="20"
          height="6"
          rx="3"
          fill="var(--df-surface-muted)"
          stroke="var(--df-border-strong)"
          strokeWidth="1.8"
        />
      </svg>
    </div>
  );
};
