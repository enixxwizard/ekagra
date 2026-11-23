import React, { useMemo } from 'react';
import type { ConfirmSchedulePdfResult } from '../../context/DayFlowContext';
import type { ActivityCategory, ScheduleActivity, TimeFormat } from '../../types/dayflow';
import { formatTimeDisplay, getLocalTimeZoneName } from '../../utils/dateTime';
import { computeImportFingerprint, sanitizeIsoDate, sanitizeTime24, timeToMinutes } from '../../utils/pdfSchemaValidator';
import {
  evaluateStrictSchedulePreviewMetrics,
  type StrictScheduleSession,
  type StrictScheduleValidationResult,
} from '../../utils/strictScheduleValidator';
import { BiIcon } from '../ui/BiIcon';

const CATEGORIES: ActivityCategory[] = [
  'Study',
  'Work',
  'Deep Focus',
  'Health',
  'Personal',
  'Admin',
];

interface StrictSchedulePreviewProps {
  fileName: string;
  pageCount: number;
  analysisLabel: string;
  validation: StrictScheduleValidationResult;
  sessions: StrictScheduleSession[];
  onChangeSessions: React.Dispatch<React.SetStateAction<StrictScheduleSession[]>>;
  existingActivities: ScheduleActivity[];
  importedFingerprints: string[];
  timeFormat: TimeFormat;
  confirming: boolean;
  confirmResult: ConfirmSchedulePdfResult | null;
  onConfirmImport: () => void;
  onOpenCalendar: () => void;
}

export const StrictSchedulePreview: React.FC<StrictSchedulePreviewProps> = ({
  fileName,
  pageCount,
  analysisLabel,
  validation,
  sessions,
  onChangeSessions,
  existingActivities,
  importedFingerprints,
  timeFormat,
  confirming,
  confirmResult,
  onConfirmImport,
  onOpenCalendar,
}) => {
  const timeZone = getLocalTimeZoneName();

  const metrics = useMemo(
    () =>
      evaluateStrictSchedulePreviewMetrics(
        sessions,
        existingActivities,
        importedFingerprints,
        fileName,
        computeImportFingerprint
      ),
    [sessions, existingActivities, importedFingerprints, fileName]
  );

  const rowErrors = useMemo(() => {
    const errors = new Map<string, string>();
    for (const s of sessions) {
      if (!s.included) continue;
      if (!s.title.trim()) {
        errors.set(s.id, 'Study topic is required.');
        continue;
      }
      if (!sanitizeIsoDate(s.date)) {
        errors.set(s.id, 'Enter a valid calendar date.');
        continue;
      }
      const st = sanitizeTime24(s.startTime);
      const et = sanitizeTime24(s.endTime);
      if (!st || !et || timeToMinutes(et) <= timeToMinutes(st)) {
        errors.set(s.id, 'End time must be after start time.');
      }
    }
    return errors;
  }, [sessions]);

  const newSessionsReadyCount = Math.max(0, metrics.validSelectedCount - metrics.duplicateCount);
  const hasInvalidIncludedRow = rowErrors.size > 0;

  const updateSession = (id: string, patch: Partial<StrictScheduleSession>) => {
    onChangeSessions((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  const removeSession = (id: string) => {
    onChangeSessions((prev) => prev.filter((item) => item.id !== id));
  };

  const toggleAll = (checked: boolean) => {
    onChangeSessions((prev) => prev.map((item) => ({ ...item, included: checked })));
  };

  return (
    <section className="space-y-5 rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5 sm:p-6">
      {/* Header Summary */}
      <div className="flex flex-col justify-between gap-4 border-b border-[var(--df-border)] pb-4 sm:flex-row sm:items-start">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--df-accent-soft-fg)]">
            <BiIcon name="calendar2-check" className="text-sm" />
            <span>Valid Study Schedule Detected — Review &amp; Confirm</span>
          </div>
          <h3 className="font-display text-lg font-bold text-[var(--df-text)] sm:text-xl">
            {fileName}
          </h3>
          <p className="text-xs text-[var(--df-text-muted)]">
            <span className="font-mono tabular-nums font-semibold text-[var(--df-text)]">
              {sessions.length}
            </span>{' '}
            valid {sessions.length === 1 ? 'session' : 'sessions'} · {pageCount}{' '}
            {pageCount === 1 ? 'page' : 'pages'} · {analysisLabel} · TZ: {timeZone}
          </p>
          {validation.classification === 'mixed_with_valid_schedule' && (
            <p className="text-xs text-[var(--df-text-muted)]">
              {validation.reasonDetail}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => toggleAll(true)}
            className="inline-flex min-h-[40px] items-center rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)]"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => toggleAll(false)}
            className="inline-flex min-h-[40px] items-center rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-xs font-semibold text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
          >
            Deselect all
          </button>
        </div>
      </div>

      {/* Pre-Import Duplicate & Conflict Warnings */}
      {(metrics.duplicateCount > 0 || metrics.conflictCount > 0) && (
        <div className="space-y-2 rounded-2xl border border-amber-300 bg-amber-50/70 p-4 text-xs dark:border-amber-800/60 dark:bg-amber-950/25">
          {metrics.duplicateCount > 0 && (
            <div className="flex items-start gap-2.5 text-amber-900 dark:text-amber-200">
              <BiIcon name="exclamation-triangle-fill" className="mt-0.5 text-sm shrink-0" />
              <p>
                <span className="font-semibold">Duplicate schedule upload notice:</span>{' '}
                <span className="font-mono tabular-nums font-semibold">
                  {metrics.duplicateCount}
                </span>{' '}
                {metrics.duplicateCount === 1 ? 'session already exists' : 'sessions already exist'} in
                your calendar or previous imports and will be skipped automatically.
              </p>
            </div>
          )}
          {metrics.conflictCount > 0 && (
            <div className="flex items-start gap-2.5 text-amber-900 dark:text-amber-200">
              <BiIcon name="clock-history" className="mt-0.5 text-sm shrink-0" />
              <p>
                <span className="font-semibold">Calendar time conflict:</span>{' '}
                <span className="font-mono tabular-nums font-semibold">
                  {metrics.conflictCount}
                </span>{' '}
                {metrics.conflictCount === 1 ? 'session overlaps' : 'sessions overlap'} an existing
                scheduled event. Adjust the time below or keep both if intentional.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Editable Candidate Session List */}
      {sessions.length === 0 ? (
        <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-6 text-center text-xs text-[var(--df-text-muted)]">
          All extracted sessions were removed from preview. Upload a PDF again to inspect entries.
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => {
            const isDup = metrics.duplicateIds.has(session.id);
            const conflicts = metrics.conflictsById.get(session.id) ?? [];
            const rowErr = rowErrors.get(session.id);

            return (
              <div
                key={session.id}
                className={`rounded-2xl border p-4 transition-colors ${
                  !session.included
                    ? 'border-[var(--df-border)] bg-[var(--df-bg)]/50 opacity-65'
                    : rowErr
                    ? 'border-rose-400 bg-rose-50/40 dark:border-rose-800 dark:bg-rose-950/20'
                    : isDup
                    ? 'border-amber-300 bg-amber-50/40 dark:border-amber-800/50 dark:bg-amber-950/15'
                    : 'border-[var(--df-border)] bg-[var(--df-bg)]'
                }`}
              >
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-[auto_140px_115px_115px_minmax(0,1fr)_130px_auto] lg:items-center">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={session.included}
                      onChange={(e) => updateSession(session.id, { included: e.target.checked })}
                      aria-label={`Include ${session.title}`}
                      className="h-4 w-4 rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                    />
                    <span className="text-xs font-medium text-[var(--df-text-muted)] lg:hidden">
                      Include session
                    </span>
                  </label>

                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-[var(--df-text-muted)] lg:sr-only">
                      Date
                    </label>
                    <input
                      type="date"
                      value={session.date}
                      onChange={(e) => updateSession(session.id, { date: e.target.value })}
                      className="h-10 w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 font-mono text-xs tabular-nums text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-[var(--df-text-muted)] lg:sr-only">
                      Start time
                    </label>
                    <input
                      type="time"
                      value={session.startTime}
                      onChange={(e) => updateSession(session.id, { startTime: e.target.value })}
                      className="h-10 w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 font-mono text-xs tabular-nums text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-[var(--df-text-muted)] lg:sr-only">
                      End time
                    </label>
                    <input
                      type="time"
                      value={session.endTime}
                      onChange={(e) => updateSession(session.id, { endTime: e.target.value })}
                      className="h-10 w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 font-mono text-xs tabular-nums text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-[var(--df-text-muted)] lg:sr-only">
                      Study topic
                    </label>
                    <input
                      type="text"
                      value={session.title}
                      onChange={(e) => updateSession(session.id, { title: e.target.value })}
                      placeholder="Study topic"
                      className="h-10 w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 text-xs font-medium text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-[var(--df-text-muted)] lg:sr-only">
                      Category
                    </label>
                    <select
                      value={session.category}
                      onChange={(e) =>
                        updateSession(session.id, {
                          category: e.target.value as ActivityCategory,
                        })
                      }
                      className="h-10 w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 text-xs text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
                    >
                      {CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeSession(session.id)}
                    aria-label={`Remove ${session.title}`}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] text-[var(--df-text-muted)] hover:border-rose-400 hover:text-rose-500"
                  >
                    <BiIcon name="trash3" className="text-sm" />
                  </button>
                </div>

                {/* Inline Dot-Separated Status Line (No Pill Clutter) */}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-0 text-[11px] text-[var(--df-text-muted)] lg:pl-7">
                  <span className="font-mono tabular-nums">
                    {session.date} · {formatTimeDisplay(session.startTime, timeFormat)}–
                    {formatTimeDisplay(session.endTime, timeFormat)}
                  </span>
                  <span>p. {session.sourcePage}</span>
                  {isDup && (
                    <span className="font-semibold text-amber-700 dark:text-amber-300">
                      · Duplicate: already on calendar (will skip)
                    </span>
                  )}
                  {conflicts.length > 0 && (
                    <span className="font-semibold text-amber-700 dark:text-amber-300">
                      · Overlaps {conflicts[0].title} (
                      {formatTimeDisplay(conflicts[0].startTime, timeFormat)}–
                      {formatTimeDisplay(conflicts[0].endTime, timeFormat)})
                    </span>
                  )}
                  {rowErr && (
                    <span className="font-semibold text-rose-600 dark:text-rose-400">
                      · {rowErr}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Confirmation Action Footer */}
      <div className="flex flex-col justify-between gap-3 border-t border-[var(--df-border)] pt-4 sm:flex-row sm:items-center">
        <div className="text-xs text-[var(--df-text-muted)]">
          {confirmResult?.ok && confirmResult.persisted ? (
            <span className="font-semibold text-[var(--df-accent-soft-fg)]">
              Calendar updated: {confirmResult.activitiesAdded} study{' '}
              {confirmResult.activitiesAdded === 1 ? 'session' : 'sessions'} saved
              {confirmResult.duplicatesSkipped > 0
                ? ` · ${confirmResult.duplicatesSkipped} duplicate${
                    confirmResult.duplicatesSkipped === 1 ? '' : 's'
                  } skipped`
                : ''}
              .
            </span>
          ) : confirmResult && !confirmResult.ok ? (
            <span className="font-semibold text-rose-600 dark:text-rose-400">
              {confirmResult.error || 'Could not persist imported schedule.'}
            </span>
          ) : (
            <span>
              <span className="font-mono tabular-nums font-semibold text-[var(--df-text)]">
                {newSessionsReadyCount}
              </span>{' '}
              new {newSessionsReadyCount === 1 ? 'session' : 'sessions'} ready to add after your
              confirmation.
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {confirmResult?.ok && confirmResult.persisted && (
            <button
              type="button"
              onClick={onOpenCalendar}
              className="inline-flex min-h-[42px] items-center gap-2 rounded-2xl border border-[var(--df-border-strong)] bg-[var(--df-bg)] px-4 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-accent)]"
            >
              <BiIcon name="calendar3" className="text-sm" />
              View Calendar
            </button>
          )}

          <button
            type="button"
            disabled={
              confirming ||
              hasInvalidIncludedRow ||
              newSessionsReadyCount === 0
            }
            onClick={onConfirmImport}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl bg-[var(--df-accent)] px-5 text-sm font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <BiIcon name={confirming ? 'arrow-repeat' : 'check2-circle'} spin={confirming} className="text-base" />
            {confirming
              ? 'Saving to Calendar...'
              : newSessionsReadyCount === 0 && metrics.duplicateCount > 0
              ? 'All Selected Sessions Already Imported'
              : `Confirm & Import to Calendar (${newSessionsReadyCount})`}
          </button>
        </div>
      </div>
    </section>
  );
};
