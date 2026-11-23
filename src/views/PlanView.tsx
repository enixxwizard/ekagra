import React, { useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import { BiIcon } from '../components/ui/BiIcon';
import { useDayFlow } from '../context/DayFlowContext';
import { ResolvedActivity } from '../types/dayflow';
import { ACTIVITY_COLORS } from '../utils/colors';
import {
  formatDurationCompact,
  formatTimeDisplay,
  getActivityDurationMinutes,
  getCurrentLocalMinutes,
  getTodayISO,
  minutesToTime24,
  parseTimeToMinutes,
} from '../utils/dateTime';
import { resolveActivitiesForDate } from '../utils/recurrence';

export const PlanView: React.FC = () => {
  const {
    state,
    setActivePage,
    setActivityStatus,
    setTimerLinkedActivity,
    resetTimer,
    openQuickActivitySheet,
    openCapturePdfImport,
  } = useDayFlow();

  const todayISO = getTodayISO();
  const timeFormat = state.settings.timeFormat;
  const nowMinutes = getCurrentLocalMinutes();

  const todayActivities = useMemo(
    () => resolveActivitiesForDate(state.activities, todayISO),
    [state.activities, todayISO]
  );

  const nonSkipped = useMemo(
    () => todayActivities.filter((a) => a.status !== 'skipped'),
    [todayActivities]
  );

  const completedCount = useMemo(
    () => nonSkipped.filter((a) => a.status === 'completed').length,
    [nonSkipped]
  );

  const totalCount = nonSkipped.length;
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const currentOrNextActivity = useMemo(() => {
    const activeNow = todayActivities.find((act) => {
      if (act.status !== 'pending') return false;
      const start = parseTimeToMinutes(act.startTime);
      const end = parseTimeToMinutes(act.endTime);
      return nowMinutes >= start && nowMinutes < end;
    });
    if (activeNow) return { activity: activeNow, mode: 'now' as const };

    const nextUp = todayActivities.find(
      (act) => act.status === 'pending' && parseTimeToMinutes(act.endTime) > nowMinutes
    );
    if (nextUp) return { activity: nextUp, mode: 'next' as const };

    return null;
  }, [todayActivities, nowMinutes]);

  const upcomingActivities = useMemo(() => {
    return todayActivities.filter((act) => {
      if (currentOrNextActivity && act.instanceId === currentOrNextActivity.activity.instanceId) {
        return false;
      }
      return true;
    });
  }, [todayActivities, currentOrNextActivity]);

  const handleStartFocus = (activity?: ResolvedActivity | null) => {
    setTimerLinkedActivity(activity?.activityId ?? null);
    resetTimer(state.settings.defaultFocusMinutes);
    setActivePage('focus');
  };

  const weekdayName = format(parseISO(todayISO), 'EEEE');
  const shortDate = format(parseISO(todayISO), 'MMM d');
  const defaultNextStart = minutesToTime24(Math.min(22 * 60, Math.ceil((nowMinutes + 15) / 15) * 15));

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      {/* 1. Today's Date + Minimal Progress Indicator */}
      <header className="space-y-4">
        <div>
          <p className="text-sm font-medium text-[var(--df-text-muted)]">
            {weekdayName}, {shortDate}
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight text-[var(--df-text)] sm:text-4xl">
            Hey {state.settings.userName}, let&apos;s plan today.
          </h1>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs font-medium text-[var(--df-text-muted)]">
            <span>
              {totalCount === 0
                ? 'Open canvas today'
                : completedCount === totalCount
                ? 'Everything done for today'
                : `${completedCount} of ${totalCount} done`}
            </span>
            <span className="font-mono tabular-nums">{progressPct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--df-border)]">
            <div
              className="h-full rounded-full bg-[var(--df-accent)] transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </header>

      {/* 2. Current Activity */}
      <section aria-label="Current activity">
        {currentOrNextActivity ? (
          <div className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-6">
            <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
              <div className="min-w-0 space-y-1.5">
                <p className="text-xs font-medium text-[var(--df-text-muted)]">
                  {currentOrNextActivity.mode === 'now' ? 'Happening now' : 'Up next'} ·{' '}
                  <span className="font-mono tabular-nums">
                    {formatTimeDisplay(currentOrNextActivity.activity.startTime, timeFormat)} –{' '}
                    {formatTimeDisplay(currentOrNextActivity.activity.endTime, timeFormat)}
                  </span>
                </p>
                <h2 className="truncate font-display text-2xl font-bold text-[var(--df-text)]">
                  {currentOrNextActivity.activity.title}
                </h2>
                <p className="truncate text-xs text-[var(--df-text-muted)]">
                  {currentOrNextActivity.activity.category}
                  {currentOrNextActivity.activity.description
                    ? ` · ${currentOrNextActivity.activity.description}`
                    : ''}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    setActivityStatus(
                      currentOrNextActivity.activity.activityId,
                      todayISO,
                      'completed'
                    )
                  }
                  aria-label={`Complete ${currentOrNextActivity.activity.title}`}
                  className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] text-[var(--df-text-muted)] transition-colors hover:border-[var(--df-border-strong)] hover:text-[var(--df-text)]"
                >
                  <BiIcon name="check-lg" className="text-base" />
                </button>
                <button
                  type="button"
                  onClick={() => handleStartFocus(currentOrNextActivity.activity)}
                  className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl bg-[var(--df-accent)] px-5 py-3 text-sm font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98] whitespace-nowrap shrink-0"
                >
                  <BiIcon name="play-fill" className="text-base" />
                  Start Focus
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] p-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div>
                <p className="text-xs font-medium text-[var(--df-text-muted)]">
                  Open window
                </p>
                <h2 className="mt-1 font-display text-xl font-bold text-[var(--df-text)]">
                  {totalCount === 0
                    ? 'Nothing on your timeline yet.'
                    : 'All caught up for today.'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => handleStartFocus(null)}
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl bg-[var(--df-accent)] px-5 py-3 text-sm font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98] whitespace-nowrap shrink-0"
              >
                <BiIcon name="play-fill" className="text-base" />
                Start Focus
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 3. Upcoming & Today's Activities */}
      <section aria-label="Today's activities" className="space-y-3">
        {todayActivities.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-[var(--df-border-strong)] px-6 py-10 text-center">
            <p className="font-display text-lg font-semibold text-[var(--df-text)]">
              A quiet slate today
            </p>
            <p className="mt-1 text-sm text-[var(--df-text-muted)]">
              Add a block manually or pull your schedule straight from a PDF.
            </p>
          </div>
        ) : (
          upcomingActivities.length > 0 && (
            <div className="space-y-2.5">
              {upcomingActivities.map((act) => {
                const isDone = act.status === 'completed';
                const isSkipped = act.status === 'skipped';
                const duration = getActivityDurationMinutes(act.startTime, act.endTime);
                const token = ACTIVITY_COLORS[act.color] ?? ACTIVITY_COLORS.emerald;

                return (
                  <div
                    key={act.instanceId}
                    className={`group flex items-center gap-3.5 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-3.5 transition-colors hover:border-[var(--df-border-strong)] sm:p-4 ${
                      isSkipped ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="w-16 shrink-0 text-right sm:w-20">
                      <span className="block font-mono text-xs font-semibold tabular-nums text-[var(--df-text)]">
                        {formatTimeDisplay(act.startTime, timeFormat)}
                      </span>
                      <span className="block font-mono text-[11px] tabular-nums text-[var(--df-text-muted)]">
                        {formatDurationCompact(duration)}
                      </span>
                    </div>

                    <span className={`h-8 w-1 rounded-full shrink-0 ${token.swatch}`} />

                    <button
                      type="button"
                      onClick={() => openQuickActivitySheet({ editingActivity: act })}
                      className="min-w-0 flex-1 text-left focus:outline-none"
                    >
                      <div className="flex items-center gap-1.5">
                        <p
                          className={`truncate text-sm font-semibold sm:text-base ${
                            isDone || isSkipped
                              ? 'line-through text-[var(--df-text-subtle)]'
                              : 'text-[var(--df-text)]'
                          }`}
                        >
                          {act.title}
                        </p>
                        {act.isRecurring && (
                          <BiIcon name="repeat" className="text-xs shrink-0 text-[var(--df-text-subtle)]" />
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-[var(--df-text-muted)]">
                        {act.category}
                        {isSkipped ? ' · Skipped' : ''}
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setActivityStatus(act.activityId, todayISO, isDone ? 'pending' : 'completed')
                      }
                      aria-label={isDone ? `Mark ${act.title} incomplete` : `Complete ${act.title}`}
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border transition-all active:scale-90 ${
                        isDone
                          ? 'border-[var(--df-accent)] bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                          : 'border-[var(--df-border)] bg-[var(--df-bg)] text-transparent hover:border-[var(--df-border-strong)]'
                      }`}
                    >
                      <BiIcon name="check-lg" className="text-base font-bold" />
                    </button>
                  </div>
                );
              })}
            </div>
          )
        )}
      </section>

      {/* 4. Quick Add Button & Import PDF Shortcut */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() =>
            openQuickActivitySheet({
              initialDate: todayISO,
              initialStartTime: defaultNextStart,
              initialEndTime: minutesToTime24(
                Math.min(23 * 60 + 45, parseTimeToMinutes(defaultNextStart) + 60)
              ),
            })
          }
          className="flex min-h-[52px] items-center justify-center gap-2 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] px-4 text-sm font-semibold text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)] active:scale-[0.99] whitespace-nowrap"
        >
          <BiIcon name="plus-lg" className="text-sm" />
          Quick Add
        </button>

        <button
          type="button"
          onClick={openCapturePdfImport}
          className="flex min-h-[52px] items-center justify-center gap-2 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] px-4 text-sm font-semibold text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)] active:scale-[0.99] whitespace-nowrap"
        >
          <BiIcon name="file-earmark-arrow-up" className="text-sm" />
          Import PDF
        </button>
      </div>
    </div>
  );
};
