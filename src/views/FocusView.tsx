import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FocusMusicPanel } from '../components/focus/FocusMusicPanel';
import { QuickNotesEditor } from '../components/focus/QuickNotesEditor';
import { BiIcon } from '../components/ui/BiIcon';
import { useDayFlow } from '../context/DayFlowContext';
import { FocusModeType } from '../types/dayflow';
import {
  formatTimeDisplay,
  formatTimerClock,
  getTodayISO,
} from '../utils/dateTime';
import { resolveActivitiesForDate } from '../utils/recurrence';

const QUICK_DURATIONS = [15, 25, 45, 60, 90];

export const FocusView: React.FC = () => {
  const {
    state,
    remainingSeconds,
    startTimer,
    pauseTimer,
    resumeTimer,
    resetTimer,
    switchTimerMode,
    setTimerLinkedActivity,
    setActivityStatus,
    finishAndLogTimerNow,
    deleteFocusSession,
    lastCompletedSessionId,
    dismissCompletedSessionSummary,
    updateFocusSessionReflection,
    updateSettings,
    pushToast,
    isFocusFullscreen: isFullscreen,
    setFocusFullscreen: setIsFullscreen,
  } = useDayFlow();

  const [showLog, setShowLog] = useState(false);
  const [musicOpen, setMusicOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [reflectionDraft, setReflectionDraft] = useState('');
  const [reflectionSaved, setReflectionSaved] = useState(false);

  const focusContainerRef = useRef<HTMLDivElement | null>(null);

  const todayISO = getTodayISO();
  const { activeTimer, settings, focusSessions } = state;

  const lastCompletedSession = useMemo(
    () =>
      lastCompletedSessionId
        ? focusSessions.find((s) => s.id === lastCompletedSessionId) ?? null
        : null,
    [focusSessions, lastCompletedSessionId]
  );

  useEffect(() => {
    if (lastCompletedSession) {
      setReflectionDraft(lastCompletedSession.reflection ?? '');
      setReflectionSaved(Boolean(lastCompletedSession.reflection));
    } else {
      setReflectionDraft('');
      setReflectionSaved(false);
    }
  }, [lastCompletedSessionId]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        setIsFullscreen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => {});
        }
        setIsFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreen, setIsFullscreen]);

  useEffect(() => {
    return () => {
      setIsFullscreen(false);
    };
  }, [setIsFullscreen]);

  const toggleFullscreen = async () => {
    if (isFullscreen) {
      if (typeof document !== 'undefined' && document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          // Ignore exitFullscreen error in sandboxed iframes
        }
      }
      setIsFullscreen(false);
      return;
    }

    setIsFullscreen(true);
    const el = focusContainerRef.current;
    if (el && typeof el.requestFullscreen === 'function') {
      try {
        await el.requestFullscreen();
      } catch {
        // Fallback overlay fullscreen stays active if browser/iframe blocks native Fullscreen API
      }
    }
  };

  const todayActivities = useMemo(
    () => resolveActivitiesForDate(state.activities, todayISO),
    [state.activities, todayISO]
  );

  const openTasks = useMemo(
    () => state.tasks.filter((t) => !t.completed),
    [state.tasks]
  );

  const todaySessions = useMemo(
    () => focusSessions.filter((s) => s.date === todayISO),
    [focusSessions, todayISO]
  );

  const todayFocusMinutes = useMemo(
    () =>
      todaySessions
        .filter((s) => s.mode === 'focus')
        .reduce((sum, s) => sum + s.actualMinutes, 0),
    [todaySessions]
  );

  const progressPct =
    activeTimer.durationSeconds > 0
      ? Math.min(
          100,
          Math.max(
            0,
            ((activeTimer.durationSeconds - remainingSeconds) /
              activeTimer.durationSeconds) *
              100
          )
        )
      : 0;

  const linkedActivity = useMemo(() => {
    if (!activeTimer.linkedActivityId) return null;
    return (
      todayActivities.find((a) => a.activityId === activeTimer.linkedActivityId) ??
      state.activities.find((a) => a.id === activeTimer.linkedActivityId) ??
      null
    );
  }, [activeTimer.linkedActivityId, todayActivities, state.activities]);

  const linkedTask = useMemo(() => {
    if (!linkedActivity) return null;
    const lid = 'linkedTaskId' in linkedActivity ? linkedActivity.linkedTaskId : null;
    if (!lid) return null;
    return state.tasks.find((t) => t.id === lid) ?? null;
  }, [linkedActivity, state.tasks]);

  const linkedResolvedToday = useMemo(() => {
    if (!activeTimer.linkedActivityId) return null;
    return todayActivities.find((a) => a.activityId === activeTimer.linkedActivityId) ?? null;
  }, [todayActivities, activeTimer.linkedActivityId]);

  const handleMarkActiveDone = () => {
    if (!linkedResolvedToday) return;
    const nextStatus = linkedResolvedToday.status === 'completed' ? 'pending' : 'completed';
    setActivityStatus(linkedResolvedToday.activityId, todayISO, nextStatus);
    pushToast({
      type: 'success',
      title: nextStatus === 'completed' ? 'Activity completed' : 'Marked pending',
      description: linkedResolvedToday.title,
    });
  };

  const handleSaveReflection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!lastCompletedSession) return;
    updateFocusSessionReflection(lastCompletedSession.id, reflectionDraft);
    setReflectionSaved(true);
    pushToast({
      type: 'success',
      title: 'Reflection saved',
      description: 'Attached to your focus session log.',
    });
  };

  const handleStartBreakFromSummary = () => {
    switchTimerMode('short_break');
    dismissCompletedSessionSummary();
    startTimer();
  };

  const hasDrawerOpen = musicOpen || notesOpen;
  const radius = isFullscreen ? 116 : 104;
  const circumference = 2 * Math.PI * radius;
  const strokeOffset = circumference - (progressPct / 100) * circumference;

  return (
    <div
      ref={focusContainerRef}
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 overflow-y-auto bg-[var(--df-bg)] px-4 py-6 sm:px-8 sm:py-10'
          : 'space-y-6'
      }
    >
      <div
        className={
          isFullscreen
            ? hasDrawerOpen
              ? 'mx-auto grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start'
              : 'mx-auto flex min-h-[calc(100vh-5rem)] max-w-2xl flex-col justify-center space-y-5'
            : hasDrawerOpen
              ? 'grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start'
              : 'mx-auto max-w-2xl space-y-5'
        }
      >
        {/* Primary Column: Calm Hero Timer */}
        <div
          className={
            hasDrawerOpen
              ? 'space-y-5 lg:col-span-7'
              : 'w-full space-y-5'
          }
        >
          {/* Minimal Post-Session Summary & Reflection */}
          {lastCompletedSession && (
            <section
              aria-label="Session summary"
              className="animate-sheet-up rounded-3xl border border-[var(--df-accent-border)] bg-[var(--df-surface)] p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]">
                    <BiIcon name="stars" className="text-sm" />
                  </span>
                  <div>
                    <p className="text-xs font-medium text-[var(--df-text-muted)]">
                      Session logged · {lastCompletedSession.actualMinutes}m
                      {lastCompletedSession.plannedMinutes !== lastCompletedSession.actualMinutes
                        ? ` of ${lastCompletedSession.plannedMinutes}m`
                        : ''}
                    </p>
                    <h2 className="font-display text-base font-bold text-[var(--df-text)]">
                      {lastCompletedSession.activityTitle || 'Open Deep Focus'}
                    </h2>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={dismissCompletedSessionSummary}
                  aria-label="Dismiss session summary"
                  className="rounded-lg p-1.5 text-[var(--df-text-subtle)] hover:text-[var(--df-text)]"
                >
                  <BiIcon name="x-lg" className="text-sm" />
                </button>
              </div>

              <form onSubmit={handleSaveReflection} className="mt-3.5 flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={reflectionDraft}
                  onChange={(e) => {
                    setReflectionDraft(e.target.value);
                    if (reflectionSaved) setReflectionSaved(false);
                  }}
                  maxLength={180}
                  placeholder="Optional 1-line reflection: what clicked or what’s next?"
                  aria-label="Session reflection"
                  className="min-w-0 flex-1 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none"
                />
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="submit"
                    disabled={!reflectionDraft.trim()}
                    className="h-9 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] px-3 text-xs font-semibold text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] disabled:opacity-45"
                  >
                    {reflectionSaved ? 'Saved' : 'Save note'}
                  </button>
                  <button
                    type="button"
                    onClick={handleStartBreakFromSummary}
                    className="h-9 rounded-xl bg-[var(--df-accent)] px-3 text-xs font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98]"
                  >
                    Start break
                  </button>
                </div>
              </form>
            </section>
          )}

          {/* Main Focus Timer Surface */}
          <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-6 sm:p-8">
            {/* Top Bar: Mode Switcher + Secondary Tool Toggles + Fullscreen */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center rounded-xl bg-[var(--df-surface-subtle)] p-1">
                {(
                  [
                    { id: 'focus', label: 'Focus' },
                    { id: 'short_break', label: 'Short break' },
                    { id: 'long_break', label: 'Long break' },
                  ] as { id: FocusModeType; label: string }[]
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => switchTimerMode(item.id)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                      activeTimer.mode === item.id
                        ? 'bg-[var(--df-surface)] text-[var(--df-text)]'
                        : 'text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setMusicOpen((v) => !v)}
                  aria-pressed={musicOpen}
                  aria-label="Toggle focus music drawer"
                  className={`relative inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors ${
                    musicOpen
                      ? 'border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]'
                      : 'border-[var(--df-border)] bg-[var(--df-bg)] text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
                  }`}
                >
                  <BiIcon name="headphones" className="text-xs" />
                  <span className="hidden sm:inline">Music</span>
                  {state.settings.preferredMusicUrl && !musicOpen && (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full bg-[var(--df-accent)]"
                    />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setNotesOpen((v) => !v)}
                  aria-pressed={notesOpen}
                  aria-label="Toggle quick notes drawer"
                  className={`inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors ${
                    notesOpen
                      ? 'border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]'
                      : 'border-[var(--df-border)] bg-[var(--df-bg)] text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
                  }`}
                >
                  <BiIcon name="sticky" className="text-xs" />
                  <span className="hidden sm:inline">Notes</span>
                </button>

                <button
                  type="button"
                  onClick={() => updateSettings({ soundAlerts: !settings.soundAlerts })}
                  aria-label={settings.soundAlerts ? 'Mute sound' : 'Unmute sound'}
                  title={settings.soundAlerts ? 'Mute chime' : 'Unmute chime'}
                  className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
                >
                  {settings.soundAlerts ? (
                    <BiIcon name="volume-up" className="text-sm" />
                  ) : (
                    <BiIcon name="volume-mute" className="text-sm" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => void toggleFullscreen()}
                  aria-pressed={isFullscreen}
                  aria-label={isFullscreen ? 'Exit fullscreen focus' : 'Enter fullscreen focus'}
                  title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen focus'}
                  className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${
                    isFullscreen
                      ? 'border-[var(--df-accent)] bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                      : 'border-[var(--df-border)] bg-[var(--df-bg)] text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
                  }`}
                >
                  {isFullscreen ? (
                    <BiIcon name="fullscreen-exit" className="text-sm" />
                  ) : (
                    <BiIcon name="arrows-fullscreen" className="text-sm" />
                  )}
                </button>
              </div>
            </div>

            {/* Active Target Strip */}
            <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl bg-[var(--df-bg)] px-4 py-3">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-[var(--df-text-muted)]">
                  Active focus target
                </p>
                <p className="truncate text-sm font-semibold text-[var(--df-text)]">
                  {linkedActivity ? linkedActivity.title : 'Open Deep Focus'}
                </p>
              </div>
              {linkedResolvedToday && (
                <button
                  type="button"
                  onClick={handleMarkActiveDone}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    linkedResolvedToday.status === 'completed'
                      ? 'border-[var(--df-accent)] bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                      : 'border-[var(--df-border)] bg-[var(--df-surface)] text-[var(--df-text)] hover:border-[var(--df-border-strong)]'
                  }`}
                >
                  <BiIcon name="check-lg" className="text-xs" />
                  {linkedResolvedToday.status === 'completed' ? 'Done' : 'Complete'}
                </button>
              )}
            </div>

            {/* Countdown Ring & Clock */}
            <div className="relative my-8 flex items-center justify-center">
              <svg
                className={isFullscreen ? 'h-68 w-68 -rotate-90 sm:h-72 sm:w-72' : 'h-60 w-60 -rotate-90'}
                viewBox={isFullscreen ? '0 0 264 264' : '0 0 240 240'}
              >
                <circle
                  cx={isFullscreen ? 132 : 120}
                  cy={isFullscreen ? 132 : 120}
                  r={radius}
                  fill="none"
                  strokeWidth="8"
                  stroke="var(--df-border)"
                />
                <circle
                  cx={isFullscreen ? 132 : 120}
                  cy={isFullscreen ? 132 : 120}
                  r={radius}
                  fill="none"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeOffset}
                  stroke={
                    activeTimer.mode === 'focus'
                      ? 'var(--df-accent)'
                      : 'var(--df-break-accent)'
                  }
                  className="transition-all duration-300"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <span
                  className={`font-mono font-semibold tracking-tight tabular-nums text-[var(--df-text)] ${
                    isFullscreen ? 'text-5xl sm:text-6xl' : 'text-5xl'
                  }`}
                >
                  {formatTimerClock(remainingSeconds)}
                </span>
                <span className="mt-2 max-w-[185px] truncate text-xs font-medium text-[var(--df-text-muted)]">
                  {linkedActivity ? linkedActivity.category : 'Deep Focus'} · {todayFocusMinutes}m today
                </span>
              </div>
            </div>

            {/* Subtle Linear Progress Bar */}
            <div className="mx-auto mb-6 max-w-xs">
              <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--df-surface-subtle)]">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${progressPct}%`,
                    backgroundColor:
                      activeTimer.mode === 'focus'
                        ? 'var(--df-accent)'
                        : 'var(--df-break-accent)',
                  }}
                />
              </div>
            </div>

            {/* Primary Timer Controls */}
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              {activeTimer.status === 'idle' && (
                <button
                  type="button"
                  onClick={startTimer}
                  className="inline-flex min-h-[48px] items-center gap-2 rounded-2xl bg-[var(--df-accent)] px-7 text-sm font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98]"
                >
                  <BiIcon name="play-fill" className="text-base" />
                  Start
                </button>
              )}
              {activeTimer.status === 'running' && (
                <button
                  type="button"
                  onClick={pauseTimer}
                  className="inline-flex min-h-[48px] items-center gap-2 rounded-2xl bg-[var(--df-cta)] px-7 text-sm font-semibold text-[var(--df-cta-fg)] transition-transform active:scale-[0.98]"
                >
                  <BiIcon name="pause-fill" className="text-base" />
                  Pause
                </button>
              )}
              {activeTimer.status === 'paused' && (
                <button
                  type="button"
                  onClick={resumeTimer}
                  className="inline-flex min-h-[48px] items-center gap-2 rounded-2xl bg-[var(--df-accent)] px-7 text-sm font-semibold text-[var(--df-accent-fg)] transition-transform active:scale-[0.98]"
                >
                  <BiIcon name="play-fill" className="text-base" />
                  Resume
                </button>
              )}

              {activeTimer.status !== 'idle' && (
                <button
                  type="button"
                  onClick={finishAndLogTimerNow}
                  className="inline-flex min-h-[48px] items-center gap-1.5 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 text-sm font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)]"
                >
                  <BiIcon name="check-lg" className="text-sm" />
                  Finish &amp; log
                </button>
              )}

              <button
                type="button"
                onClick={() => resetTimer()}
                aria-label="Reset timer"
                title="Reset timer"
                className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--df-border)] text-[var(--df-text-muted)] hover:border-[var(--df-border-strong)] hover:text-[var(--df-text)]"
              >
                <BiIcon name="arrow-counterclockwise" className="text-base" />
              </button>
            </div>

            {/* Activity Selector & Session Length Presets (hidden in calm fullscreen when running) */}
            {(!isFullscreen || activeTimer.status === 'idle') && (
              <div className="mt-7 space-y-4 border-t border-[var(--df-border)] pt-5">
                <div>
                  <label
                    htmlFor="focus-act"
                    className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]"
                  >
                    Switch active activity
                  </label>
                  <select
                    id="focus-act"
                    value={activeTimer.linkedActivityId ?? ''}
                    onChange={(e) => setTimerLinkedActivity(e.target.value || null)}
                    className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
                  >
                    <option value="">Open Deep Focus</option>
                    {todayActivities.map((act) => (
                      <option key={act.activityId} value={act.activityId}>
                        {act.title} ({formatTimeDisplay(act.startTime, settings.timeFormat)})
                      </option>
                    ))}
                    {openTasks.length > 0 && (
                      <optgroup label="Open tasks (scheduled links)">
                        {openTasks
                          .filter((t) => t.scheduledActivityId)
                          .map((t) => (
                            <option key={t.id} value={t.scheduledActivityId!}>
                              {t.title}
                            </option>
                          ))}
                      </optgroup>
                    )}
                  </select>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[var(--df-text-muted)]">
                    Session length
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_DURATIONS.map((mins) => (
                      <button
                        key={mins}
                        type="button"
                        disabled={activeTimer.status === 'running'}
                        onClick={() => resetTimer(mins)}
                        className={`rounded-xl border px-3 py-1.5 font-mono text-xs font-medium tabular-nums disabled:opacity-50 ${
                          Math.round(activeTimer.durationSeconds / 60) === mins
                            ? 'border-[var(--df-accent)] bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                            : 'border-[var(--df-border)] text-[var(--df-text-muted)] hover:border-[var(--df-border-strong)] hover:text-[var(--df-text)]'
                        }`}
                      >
                        {mins}m
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Progressive Disclosure: Today's Logged Sessions (collapsed by default, hidden during fullscreen) */}
          {!isFullscreen && (
            <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] px-5 py-4">
              <button
                type="button"
                onClick={() => setShowLog((v) => !v)}
                className="flex w-full items-center justify-between text-left"
              >
                <div>
                  <p className="text-sm font-semibold text-[var(--df-text)]">
                    {todayFocusMinutes}m focused today
                  </p>
                  <p className="text-xs text-[var(--df-text-muted)]">
                    {focusSessions.length} recorded sessions
                  </p>
                </div>
                {showLog ? (
                  <BiIcon name="chevron-up" className="text-sm text-[var(--df-text-muted)]" />
                ) : (
                  <BiIcon name="chevron-down" className="text-sm text-[var(--df-text-muted)]" />
                )}
              </button>

              {showLog && (
                <div className="mt-4 border-t border-[var(--df-border)] pt-3">
                  {focusSessions.length === 0 ? (
                    <p className="py-4 text-center text-xs text-[var(--df-text-muted)]">
                      No sessions logged yet.
                    </p>
                  ) : (
                    <ul className="max-h-64 divide-y divide-[var(--df-border)] overflow-y-auto">
                      {focusSessions.slice(0, 15).map((session) => (
                        <li key={session.id} className="flex items-start justify-between gap-3 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-[var(--df-text)]">
                              {session.activityTitle || 'Deep Focus'}
                            </p>
                            <p className="font-mono text-xs tabular-nums text-[var(--df-text-muted)]">
                              {session.date} · {session.actualMinutes}m · {session.category}
                            </p>
                            {session.reflection && (
                              <p className="mt-1 text-xs italic text-[var(--df-text-muted)]">
                                &ldquo;{session.reflection}&rdquo;
                              </p>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => deleteFocusSession(session.id)}
                            aria-label="Delete session"
                            className="rounded-lg p-1.5 text-[var(--df-text-subtle)] hover:text-rose-500"
                          >
                            <BiIcon name="trash3" className="text-xs" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        {/* Secondary Collapsible Drawers: Kept mounted so active Spotify/YouTube embeds and drafts never reset on toggle */}
        <div
          className={
            hasDrawerOpen
              ? 'space-y-5 lg:col-span-5'
              : 'hidden'
          }
        >
          <div className={musicOpen ? 'block' : 'hidden'}>
            <FocusMusicPanel />
          </div>
          <div className={notesOpen ? 'block' : 'hidden'}>
            <QuickNotesEditor
              linkedActivityId={activeTimer.linkedActivityId}
              linkedTaskId={linkedTask?.id ?? null}
              linkedFocusSessionId={todaySessions[0]?.id ?? null}
              defaultCategory={linkedActivity?.category ?? 'Deep Focus'}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
