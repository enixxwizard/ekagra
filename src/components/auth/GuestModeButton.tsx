import React from 'react';
import { BiIcon } from '../ui/BiIcon';

interface GuestModeButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export const GuestModeButton: React.FC<GuestModeButtonProps> = ({
  onClick,
  disabled = false,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[50px] w-full items-center justify-center gap-2 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-5 text-sm font-semibold text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)] active:scale-[0.99] disabled:opacity-50"
    >
      <span>Continue as Guest</span>
      <BiIcon name="arrow-right" className="text-[15px]" />
    </button>
  );
};
