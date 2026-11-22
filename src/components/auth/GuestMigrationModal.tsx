import React from 'react';
import { AlertTriangle, Check, HardDriveDownload, X } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';

export const GuestMigrationModal: React.FC = () => {
  const {
    user,
    migrationStatus,
    migrationSummary,
    migrationError,
    migrationResult,
    confirmGuestMigration,
    skipGuestMigration,
  } = useAuth();

  if (
    migrationStatus === 'idle' ||
    migrationStatus === 'completed' ||
    !migrationSummary?.hasData
  ) {
    return null;
  }

  const totalItems =
    migrationSummary.tasksCount +
    migrationSummary.activitiesCount +
    migrationSummary.focusSessionsCount +
    migrationSummary.habitsCount +
    migrationSummary.notesCount +
    migrationSummary.quotationsCount;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      style={{ backgroundColor: 'var(--df-backdrop)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="guest-migration-title"
    >
      <div className="animate-sheet-up w-full rounded-t-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-6 sm:max-w-md sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--df-border)] sm:hidden" />

        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]">
              <HardDriveDownload className="h-4.5 w-4.5" />
            </span>
            <div>
              <h2
                id="guest-migration-title"
                className="font-display text-lg font-bold text-[var(--df-text)]"
              >
                Import local guest data?
              </h2>
              <p className="text-xs text-[var(--df-text-muted)]">
                {user?.email || 'Your DayFlow account'}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={migrationStatus === 'migrating'}
            onClick={skipGuestMigration}
            aria-label="Close"
            className="rounded-lg p-1 text-[var(--df-text-muted)] hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-[var(--df-text-muted)]">
          We found <span className="font-semibold text-[var(--df-text)]">{totalItems}</span>{' '}
          saved items stored locally on this browser from Guest Mode. Importing merges new items into your account without overwriting existing cloud data or creating duplicates.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3.5 text-xs text-[var(--df-text)]">
          <div className="flex justify-between">
            <span className="text-[var(--df-text-muted)]">Activities</span>
            <span className="font-mono font-semibold tabular-nums">{migrationSummary.activitiesCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--df-text-muted)]">Tasks</span>
            <span className="font-mono font-semibold tabular-nums">{migrationSummary.tasksCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--df-text-muted)]">Focus sessions</span>
            <span className="font-mono font-semibold tabular-nums">{migrationSummary.focusSessionsCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--df-text-muted)]">Habits</span>
            <span className="font-mono font-semibold tabular-nums">{migrationSummary.habitsCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--df-text-muted)]">Quick notes</span>
            <span className="font-mono font-semibold tabular-nums">{migrationSummary.notesCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--df-text-muted)]">PDF quotes</span>
            <span className="font-mono font-semibold tabular-nums">{migrationSummary.quotationsCount}</span>
          </div>
        </div>

        {migrationError && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{migrationError}</p>
          </div>
        )}

        {migrationResult && (
          <p className="mt-3 text-xs font-medium text-[var(--df-accent-soft-fg)]">
            Imported {migrationResult.importedActivities + migrationResult.importedTasks} core items.
          </p>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={migrationStatus === 'migrating'}
            onClick={skipGuestMigration}
            className="min-h-[42px] rounded-xl border border-[var(--df-border)] px-4 text-xs font-semibold text-[var(--df-text-muted)] transition-colors hover:border-[var(--df-border-strong)] hover:text-[var(--df-text)] disabled:opacity-50"
          >
            Keep separate &amp; skip
          </button>
          <button
            type="button"
            disabled={migrationStatus === 'migrating'}
            onClick={() => void confirmGuestMigration()}
            className="inline-flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-4 text-xs font-semibold text-[var(--df-accent-fg)] transition-all hover:brightness-95 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            {migrationStatus === 'migrating'
              ? 'Importing...'
              : migrationStatus === 'failed'
              ? 'Retry import'
              : 'Import to my account'}
          </button>
        </div>
      </div>
    </div>
  );
};
