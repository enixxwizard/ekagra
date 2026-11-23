import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDayFlow } from '../../context/DayFlowContext';
import { BiIcon } from '../ui/BiIcon';
import { formatTimeDisplay, parseTimeToMinutes } from '../../utils/dateTime';

function formatCountdown(secondsUntilStart: number): {
  label: string;
  detail: string;
} {
  if (secondsUntilStart > 59) {
    const mins = Math.floor(secondsUntilStart / 60);
    const secs = secondsUntilStart % 60;
    const mm = String(mins).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    return {
      label: `${mm}:${ss}`,
      detail: 'until start',
    };
  }
  if (secondsUntilStart > 0) {
    return {
      label: `00:${String(secondsUntilStart).padStart(2, '0')}`,
      detail: 'starting momentarily',
    };
  }
  if (secondsUntilStart >= -60) {
    return {
      label: 'Starting now',
      detail: 'time to begin',
    };
  }
  const elapsedMins = Math.floor(Math.abs(secondsUntilStart) / 60);
  return {
    label: `Started ${elapsedMins}m ago`,
    detail: 'in progress',
  };
}

function getSecondsUntilOccurrenceStart(occurrenceDate: string, startTime: string): number {
  const [y, m, d] = occurrenceDate.split('-').map(Number);
  const startMin = parseTimeToMinutes(startTime);
  const hh = Math.floor(startMin / 60);
  const mm = startMin % 60;
  const targetMs = new Date(y, (m || 1) - 1, d || 1, hh, mm, 0, 0).getTime();
  return Math.round((targetMs - Date.now()) / 1000);
}

export const FullScreenReminderOverlay: React.FC = () => {
  const {
    state,
    reminderQueue,
    viewReminderInSchedule,
    snoozeReminder,
    dismissReminder,
  } = useDayFlow();

  const current = reminderQueue[0] ?? null;
  const [secondsUntilStart, setSecondsUntilStart] = useState<number>(0);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const viewBtnRef = useRef<HTMLButtonElement | null>(null);
  const snoozeBtnRef = useRef<HTMLButtonElement | null>(null);
  const dismissBtnRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Live 1s countdown while reminder overlay is active
  useEffect(() => {
    if (!current) return;
    const sync = () => {
      setSecondsUntilStart(
        getSecondsUntilOccurrenceStart(current.occurrenceDate, current.startTime)
      );
    };
    sync();
    const id = window.setInterval(sync, 1000);
    return () => window.clearInterval(id);
  }, [current?.key, current?.occurrenceDate, current?.startTime]);

  // Body scroll lock + focus management while open
  useEffect(() => {
    if (!current) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      viewBtnRef.current?.focus();
    }, 20);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = prevOverflow;
      previouslyFocusedRef.current?.focus?.();
    };
  }, [Boolean(current)]);

  // Keyboard trap + Escape policy (Escape dismisses current reminder consistently)
  useEffect(() => {
    if (!current) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissReminder(current.key);
        return;
      }

      if (e.key === 'Tab') {
        const focusables = [
          viewBtnRef.current,
          snoozeBtnRef.current,
          dismissBtnRef.current,
        ].filter((el): el is HTMLButtonElement => Boolean(el));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;

        if (e.shiftKey) {
          if (active === first || !dialogRef.current?.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !dialogRef.current?.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [current?.key, dismissReminder]);

  const countdown = useMemo(
    () => formatCountdown(secondsUntilStart),
    [secondsUntilStart]
  );

  if (!current || typeof document === 'undefined') {
    return null;
  }

  const timeFormat = state.settings.timeFormat;
  const startLabel = formatTimeDisplay(current.startTime, timeFormat);
  const endLabel = formatTimeDisplay(current.endTime, timeFormat);

  const overlay = (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ekagra-reminder-title"
      aria-describedby="ekagra-reminder-desc"
      data-testid="fullscreen-reminder-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100dvh',
        zIndex: 9999,
      }}
      className="flex flex-col justify-between overflow-y-auto bg-[#141513] text-[#F5F4EF]"
    >
      {/* Top hairline bar & queue counter */}
      <header className="mx-auto flex w-full max-w-4xl items-center justify-between px-6 pt-6 sm:px-10 sm:pt-8">
        <div className="flex items-center gap-2.5 text-xs font-medium text-[#A4A69F]">
          <BiIcon name="bell-fill" className="text-sm text-[#B9E769]" />
          <span>Ekagra Reminder</span>
          <span aria-hidden="true">·</span>
          <span>{current.category}</span>
          {current.isRecurring && (
            <>
              <span aria-hidden="true">·</span>
              <span>Recurring</span>
            </>
          )}
          {current.snoozeCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>Snoozed {current.snoozeCount}x</span>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => dismissReminder(current.key)}
          aria-label="Dismiss reminder"
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[#2C2D28] bg-[#1C1D1A] text-[#A4A69F] transition-colors hover:border-[#3E4039] hover:text-[#F5F4EF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B9E769]"
        >
          <BiIcon name="x-lg" className="text-sm" />
        </button>
      </header>

      {/* Main centered reminder stage */}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-10 sm:px-10">
        <div className="animate-reminder-in space-y-8 rounded-3xl border border-[#2C2D28] bg-[#1C1D1A] p-7 sm:p-12">
          {/* Countdown focal readout */}
          <div className="space-y-2 border-b border-[#2C2D28] pb-7">
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <p className="font-mono text-3xl font-semibold tracking-tight tabular-nums text-[#B9E769] sm:text-5xl">
                {countdown.label}
              </p>
              <p className="text-xs font-medium text-[#A4A69F] sm:text-sm">
                {countdown.detail}
              </p>
            </div>
          </div>

          {/* Large Activity Title & Time */}
          <div className="space-y-4">
            <h1
              id="ekagra-reminder-title"
              className="font-display text-3xl font-bold tracking-tight text-[#F5F4EF] text-balance sm:text-5xl"
            >
              {current.title}
            </h1>

            <p
              id="ekagra-reminder-desc"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm tabular-nums text-[#A4A69F] sm:text-base"
            >
              <span>
                Scheduled {startLabel} – {endLabel}
              </span>
              <span aria-hidden="true">·</span>
              <span>{current.occurrenceDate}</span>
            </p>
          </div>

          {/* Primary Actions */}
          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
            <button
              ref={viewBtnRef}
              type="button"
              onClick={() => viewReminderInSchedule(current.key)}
              data-testid="reminder-view-schedule-btn"
              className="inline-flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-2xl bg-[#B9E769] px-6 py-3.5 text-sm font-bold text-[#141513] transition-transform hover:brightness-95 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B9E769] whitespace-nowrap"
            >
              <BiIcon name="calendar3" className="text-sm" />
              View Schedule
            </button>

            <button
              ref={snoozeBtnRef}
              type="button"
              onClick={() => snoozeReminder(current.key, 5)}
              data-testid="reminder-snooze-btn"
              className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-2xl border border-[#3E4039] bg-[#242622] px-5 py-3.5 text-sm font-semibold text-[#F5F4EF] transition-colors hover:border-[#B9E769]/60 hover:bg-[#2C2F2A] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B9E769] whitespace-nowrap"
            >
              <BiIcon name="clock" className="text-sm text-[#B9E769]" />
              Snooze 5 min
            </button>

            <button
              ref={dismissBtnRef}
              type="button"
              onClick={() => dismissReminder(current.key)}
              data-testid="reminder-dismiss-btn"
              className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-2xl border border-[#2C2D28] bg-transparent px-5 py-3.5 text-sm font-semibold text-[#A4A69F] transition-colors hover:border-[#3E4039] hover:text-[#F5F4EF] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B9E769] whitespace-nowrap"
            >
              Dismiss
            </button>
          </div>
        </div>
      </main>

      {/* Bottom queue & keyboard hint */}
      <footer className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-2 px-6 pb-6 text-xs text-[#82847C] sm:px-10 sm:pb-8">
        <span>
          {reminderQueue.length > 1
            ? `Reminder 1 of ${reminderQueue.length} (${reminderQueue.length - 1} more queued)`
            : 'Press Esc to dismiss'}
        </span>
        <span>In-app reminder active while Ekagra is open</span>
      </footer>
    </div>
  );

  return createPortal(overlay, document.body);
};
