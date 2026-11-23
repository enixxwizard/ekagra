import React from 'react';
import { BiIcon } from '../ui/BiIcon';

interface RecurringScopeModalProps {
  isOpen: boolean;
  actionLabel: string;
  activityTitle: string;
  onSelectScope: (scope: 'single' | 'series') => void;
  onCancel: () => void;
}

export const RecurringScopeModal: React.FC<RecurringScopeModalProps> = ({
  isOpen,
  actionLabel,
  activityTitle,
  onSelectScope,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      style={{ backgroundColor: 'var(--df-backdrop)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="recurring-scope-title"
    >
      <div className="animate-sheet-up w-full rounded-t-3xl border border-[var(--df-border)] bg-[var(--df-surface)] sm:max-w-sm sm:rounded-3xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <div className="flex items-center gap-2">
            <BiIcon name="repeat" className="text-[15px] text-[var(--df-accent-soft-fg)]" />
            <h2 id="recurring-scope-title" className="font-display text-base font-bold text-[var(--df-text)]">
              {actionLabel} repeat
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded-xl p-1.5 text-[var(--df-text-muted)] transition-colors hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
          >
            <BiIcon name="x-lg" className="text-[14px]" />
          </button>
        </div>

        <div className="space-y-3 px-6 pt-2 pb-6">
          <p className="text-xs text-[var(--df-text-muted)]">
            <span className="font-semibold text-[var(--df-text)]">{activityTitle}</span> repeats. Apply this to:
          </p>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => onSelectScope('single')}
              className="w-full rounded-2xl border border-[var(--df-border)] px-4 py-3 text-left text-sm font-semibold text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)]"
            >
              Just this day
              <span className="block text-xs font-normal text-[var(--df-text-muted)]">
                Keep other days as they are.
              </span>
            </button>

            <button
              type="button"
              onClick={() => onSelectScope('series')}
              className="w-full rounded-2xl border border-[var(--df-border)] px-4 py-3 text-left text-sm font-semibold text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)]"
            >
              All repeats
              <span className="block text-xs font-normal text-[var(--df-text-muted)]">
                Update the whole series.
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
