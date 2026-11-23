import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { BiIcon } from '../components/ui/BiIcon';
import { RecurringScopeModal } from '../components/modals/RecurringScopeModal';
import { useDayFlow } from '../context/DayFlowContext';
import { ResolvedActivity } from '../types/dayflow';
import { ACTIVITY_COLORS } from '../utils/colors';
import {
  formatDateHeading,
  formatDurationCompact,
  formatHourLabel,
  formatHoursDecimal,
  formatTimeDisplay,
  getCurrentLocalMinutes,
  getTodayISO,
  getWeekDateStrings,
  minutesToTime24,
  parseTimeToMinutes,
  shiftDateISO,
} from '../utils/dateTime';
import { resolveActivitiesForDate } from '../utils/recurrence';
import {
  analyzeDayLoad,
  computeTimelineLayout,
  findAvailableSlots,
  findUnfinishedItems,
  proposeTaskDistribution,
} from '../utils/scheduler';

type CalendarMode = 'day' | 'week' | 'month';

const START_HOUR = 5;
const END_HOUR = 23;
const HOUR_HEIGHT = 60;
const SNAP_MINUTES = 15;

interface DragSession {
  mode: 'move' | 'resize';
  activity: ResolvedActivity;
  startClientY: number;
  origStartMin: number;
  origEndMin: number;
  previewStartMin: number;
  previewEndMin: number;
}

export const CalendarView: React.FC = () => {
  const {
    state,
    setActivePage,
    setActivityStatus,
    updateActivityOccurrence,
    saveActivity,
    moveTaskToDate,
    rolloverActivityToDate,
    scheduleTaskAsActivity,
    setTimerLinkedActivity,
    resetTimer,
    toggleTask,
    openQuickActivitySheet,
    pushToast,
    calendarFocusTarget,
    consumeCalendarFocusTarget,
  } = useDayFlow();

  const todayISO = getTodayISO();
  const timeFormat = state.settings.timeFormat;
  const nowMinutes = getCurrentLocalMinutes();
  const weekStartsOn = state.settings.weekStart === 'monday' ? 1 : 0;

  const [mode, setMode] = useState<CalendarMode>('day');
  const [selectedDate, setSelectedDate] = useState(todayISO);
  const [currentMonth, setCurrentMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [showSmartAssist, setShowSmartAssist] = useState(false);
  const [highlightedActivityId, setHighlightedActivityId] = useState<string | null>(null);

  const [dragSession, setDragSession] = useState<DragSession | null>(null);
  const [pendingDragCommit, setPendingDragCommit] = useState<{
    activity: ResolvedActivity;
    newStart: string;
    newEnd: string;
  } | null>(null);

  const dragMovedRef = useRef(false);

  useEffect(() => {
    if (!calendarFocusTarget) return;
    setMode('day');
    setSelectedDate(calendarFocusTarget.date);
    setHighlightedActivityId(calendarFocusTarget.activityId);
    consumeCalendarFocusTarget();

    const scrollTimer = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-activity-id="${CSS.escape(calendarFocusTarget.activityId)}"]`
      );
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);

    const clearTimer = window.setTimeout(() => {
      setHighlightedActivityId((curr) =>
        curr === calendarFocusTarget.activityId ? null : curr
      );
    }, 4000);

    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [calendarFocusTarget, consumeCalendarFocusTarget]);

  const dayActivities = useMemo(
    () => resolveActivitiesForDate(state.activities, selectedDate),
    [state.activities, selectedDate]
  );

  const positionedActivities = useMemo(
    () => computeTimelineLayout(dayActivities),
    [dayActivities]
  );

  const dayLoad = useMemo(
    () => analyzeDayLoad(dayActivities, selectedDate, state.settings.dailyCapacityHours),
    [dayActivities, selectedDate, state.settings.dailyCapacityHours]
  );

  const availableSlots = useMemo(
    () => findAvailableSlots(dayActivities, selectedDate, 30, 6, 22),
    [dayActivities, selectedDate]
  );

  const unfinishedSummary = useMemo(
    () => findUnfinishedItems(state.activities, state.tasks, todayISO),
    [state.activities, state.tasks, todayISO]
  );

  const unscheduledTasks = useMemo(
    () => state.tasks.filter((t) => !t.completed && !t.scheduledActivityId),
    [state.tasks]
  );

  const weekDates = useMemo(
    () => getWeekDateStrings(selectedDate, state.settings.weekStart),
    [selectedDate, state.settings.weekStart]
  );

  const calendarDays = useMemo(() => {
    const mStart = startOfMonth(currentMonth);
    const mEnd = endOfMonth(currentMonth);
    return eachDayOfInterval({
      start: startOfWeek(mStart, { weekStartsOn }),
      end: endOfWeek(mEnd, { weekStartsOn }),
    });
  }, [currentMonth, weekStartsOn]);

  const activitiesByMonthDay = useMemo(() => {
    const map: Record<string, ResolvedActivity[]> = {};
    for (const day of calendarDays) {
      const iso = format(day, 'yyyy-MM-dd');
      map[iso] = resolveActivitiesForDate(state.activities, iso);
    }
    return map;
  }, [calendarDays, state.activities]);

  const selectedDayTasks = useMemo(
    () => state.tasks.filter((t) => t.dueDate === selectedDate),
    [state.tasks, selectedDate]
  );

  const weekdayHeaders =
    weekStartsOn === 1
      ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const hours = useMemo(
    () => Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i),
    []
  );

  const snapMinutes = (mins: number) => Math.round(mins / SNAP_MINUTES) * SNAP_MINUTES;

  const commitTimeChange = (
    activity: ResolvedActivity,
    newStartTime: string,
    newEndTime: string
  ) => {
    if (activity.isRecurring) {
      setPendingDragCommit({ activity, newStart: newStartTime, newEnd: newEndTime });
      return;
    }
    updateActivityOccurrence(
      activity.activityId,
      activity.occurrenceDate,
      { startTime: newStartTime, endTime: newEndTime },
      'series'
    );
    pushToast({
      type: 'success',
      title: 'Rescheduled',
      description: `${activity.title} · ${formatTimeDisplay(newStartTime, timeFormat)}`,
    });
  };

  const handlePointerDownBlock = (
    e: React.PointerEvent,
    activity: ResolvedActivity,
    dragMode: 'move' | 'resize'
  ) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.stopPropagation();

    const origStartMin = parseTimeToMinutes(activity.startTime);
    const origEndMin = parseTimeToMinutes(activity.endTime);
    dragMovedRef.current = false;

    const initial: DragSession = {
      mode: dragMode,
      activity,
      startClientY: e.clientY,
      origStartMin,
      origEndMin,
      previewStartMin: origStartMin,
      previewEndMin: origEndMin,
    };
    setDragSession(initial);

    const handleMove = (moveEvent: PointerEvent) => {
      const dy = moveEvent.clientY - initial.startClientY;
      if (Math.abs(dy) > 4) dragMovedRef.current = true;
      const deltaMinutes = snapMinutes((dy / HOUR_HEIGHT) * 60);

      setDragSession((curr) => {
        if (!curr) return null;
        if (curr.mode === 'move') {
          const dur = curr.origEndMin - curr.origStartMin;
          const nextStart = Math.max(
            START_HOUR * 60,
            Math.min(END_HOUR * 60 - dur, curr.origStartMin + deltaMinutes)
          );
          return { ...curr, previewStartMin: nextStart, previewEndMin: nextStart + dur };
        }
        const nextEnd = Math.max(
          curr.origStartMin + 15,
          Math.min(END_HOUR * 60, curr.origEndMin + deltaMinutes)
        );
        return { ...curr, previewEndMin: nextEnd };
      });
    };

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);

      setDragSession((latest) => {
        if (
          latest &&
          dragMovedRef.current &&
          (latest.previewStartMin !== latest.origStartMin ||
            latest.previewEndMin !== latest.origEndMin)
        ) {
          commitTimeChange(
            latest.activity,
            minutesToTime24(latest.previewStartMin),
            minutesToTime24(latest.previewEndMin)
          );
        }
        return null;
      });
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const handleInsertBreak = (startTime: string, endTime: string) => {
    saveActivity({
      title: 'Breather',
      description: 'Step away, hydrate, and reset.',
      date: selectedDate,
      startTime,
      endTime,
      category: 'Health',
      color: 'emerald',
      priority: 'low',
      status: 'pending',
      recurrence: { frequency: 'none', endDate: null },
    });
    pushToast({
      type: 'success',
      title: 'Break added',
      description: `${formatTimeDisplay(startTime, timeFormat)}`,
    });
  };

  const handleAutoDistributeTasks = () => {
    const proposals = proposeTaskDistribution(unscheduledTasks, state.activities, selectedDate, 3);
    if (proposals.length === 0) {
      pushToast({
        type: 'info',
        title: 'Nothing to auto-fit',
        description: 'All open tasks are already placed or days are full.',
      });
      return;
    }
    proposals.forEach((p) => scheduleTaskAsActivity(p.task.id, p.date, p.startTime, p.endTime));
    pushToast({
      type: 'success',
      title: `Placed ${proposals.length} task${proposals.length > 1 ? 's' : ''}`,
      description: 'Tucked into your open slots.',
    });
  };

  const handleLaunchFocus = (act: ResolvedActivity) => {
    setTimerLinkedActivity(act.activityId);
    resetTimer(state.settings.defaultFocusMinutes);
    setActivePage('focus');
  };

  const totalHoursHeight = (END_HOUR - START_HOUR) * HOUR_HEIGHT;
  const showNowLine =
    selectedDate === todayISO &&
    nowMinutes >= START_HOUR * 60 &&
    nowMinutes <= END_HOUR * 60;
  const nowOffsetPx = ((nowMinutes - START_HOUR * 60) / 60) * HOUR_HEIGHT;

  return (
    <div className="space-y-5">
      {/* Compact Header & View Switcher */}
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)]">
            <button
              type="button"
              onClick={() => {
                if (mode === 'month') {
                  setCurrentMonth((m) => subMonths(m, 1));
                } else {
                  setSelectedDate((d) => shiftDateISO(d, mode === 'week' ? -7 : -1));
                }
              }}
              aria-label="Previous"
              className="flex h-10 w-10 items-center justify-center rounded-l-xl text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
            >
              <BiIcon name="chevron-left" className="text-[15px]" />
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedDate(todayISO);
                setCurrentMonth(startOfMonth(new Date()));
              }}
              className="h-10 border-x border-[var(--df-border)] px-3.5 text-xs font-semibold text-[var(--df-text)] hover:bg-[var(--df-surface-hover)]"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => {
                if (mode === 'month') {
                  setCurrentMonth((m) => addMonths(m, 1));
                } else {
                  setSelectedDate((d) => shiftDateISO(d, mode === 'week' ? 7 : 1));
                }
              }}
              aria-label="Next"
              className="flex h-10 w-10 items-center justify-center rounded-r-xl text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
            >
              <BiIcon name="chevron-right" className="text-[15px]" />
            </button>
          </div>

          <h1 className="font-display text-xl font-bold text-[var(--df-text)]">
            {mode === 'month'
              ? format(currentMonth, 'MMMM yyyy')
              : mode === 'week'
              ? `${format(parseISO(weekDates[0]), 'MMM d')} – ${format(parseISO(weekDates[6]), 'MMM d')}`
              : format(parseISO(selectedDate), 'EEE, MMM d')}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-xl bg-[var(--df-surface-subtle)] p-1">
            {(['day', 'week', 'month'] as CalendarMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`min-h-[34px] rounded-lg px-3.5 text-xs font-semibold capitalize transition-colors ${
                  mode === m
                    ? 'bg-[var(--df-surface)] text-[var(--df-text)]'
                    : 'text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowSmartAssist((v) => !v)}
            className={`inline-flex h-10 items-center gap-1.5 rounded-xl border px-3.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              showSmartAssist
                ? 'border-[var(--df-accent-border)] bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                : 'border-[var(--df-border)] bg-[var(--df-surface)] text-[var(--df-text)] hover:border-[var(--df-border-strong)]'
            }`}
          >
            <BiIcon name="stars" className="text-[14px]" />
            Smart fit
          </button>
        </div>
      </div>

      {/* Contextual Warnings */}
      {mode === 'day' && (dayLoad.conflicts.length > 0 || dayLoad.isOverloaded) && (
        <div className="space-y-2">
          {dayLoad.conflicts.length > 0 && (
            <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-200">
              <BiIcon name="exclamation-triangle" className="mt-0.5 text-[15px] shrink-0 text-amber-600" />
              <div>
                <span className="font-semibold">Overlap:</span>{' '}
                {dayLoad.conflicts
                  .map((c) => `${c.first.title} & ${c.second.title} (${c.overlapMinutes}m)`)
                  .join(' · ')}
              </div>
            </div>
          )}
          {dayLoad.isOverloaded && (
            <div className="flex items-start gap-2.5 rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-xs text-rose-950 dark:border-rose-800/70 dark:bg-rose-950/35 dark:text-rose-200">
              <BiIcon name="exclamation-triangle" className="mt-0.5 text-[15px] shrink-0 text-rose-600" />
              <div>
                <span className="font-semibold">Heavy day:</span>{' '}
                {formatHoursDecimal(dayLoad.plannedMinutes)} scheduled (capacity{' '}
                {state.settings.dailyCapacityHours}h).
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Content + Optional Smart Fit Drawer */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className={showSmartAssist ? 'lg:col-span-8' : 'lg:col-span-12'}>
          {mode === 'day' && (
            <div className="overflow-hidden rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)]">
              <div className="flex items-center justify-between border-b border-[var(--df-border)] px-4 py-2.5 text-xs text-[var(--df-text-muted)]">
                <span>Drag blocks to move · Drag bottom edge to resize</span>
                <span className="font-mono tabular-nums">
                  {formatHoursDecimal(dayLoad.plannedMinutes)} planned
                </span>
              </div>

              <div className="relative max-h-[680px] overflow-y-auto">
                <div
                  className="relative flex select-none"
                  style={{ height: `${totalHoursHeight}px` }}
                >
                  <div className="w-16 shrink-0 border-r border-[var(--df-border)] bg-[var(--df-bg)] sm:w-20">
                    {hours.slice(0, -1).map((hr) => (
                      <div
                        key={hr}
                        className="relative border-b border-[var(--df-border)] pr-2.5 text-right"
                        style={{ height: `${HOUR_HEIGHT}px` }}
                      >
                        <span className="relative -top-2 font-mono text-[11px] tabular-nums text-[var(--df-text-subtle)]">
                          {formatHourLabel(hr, timeFormat)}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="relative flex-1">
                    {hours.slice(0, -1).map((hr) => (
                      <button
                        key={hr}
                        type="button"
                        aria-label={`Add at ${formatHourLabel(hr, timeFormat)}`}
                        onClick={() =>
                          openQuickActivitySheet({
                            initialDate: selectedDate,
                            initialStartTime: minutesToTime24(hr * 60),
                            initialEndTime: minutesToTime24(Math.min(23 * 60 + 45, (hr + 1) * 60)),
                          })
                        }
                        className="block w-full border-b border-[var(--df-border)] text-left transition-colors hover:bg-[var(--df-surface-hover)]"
                        style={{ height: `${HOUR_HEIGHT}px` }}
                      />
                    ))}

                    {showNowLine && (
                      <div
                        className="pointer-events-none absolute right-0 left-0 z-20 flex items-center"
                        style={{ top: `${nowOffsetPx}px` }}
                      >
                        <span className="h-2.5 w-2.5 -ml-1.5 rounded-full bg-[var(--df-cta)] ring-2 ring-[var(--df-accent)]" />
                        <div className="h-[2px] flex-1 bg-[var(--df-accent)]" />
                      </div>
                    )}

                    {positionedActivities.map(({ activity, colIndex, totalCols, hasConflict }) => {
                      const isDraggingThis =
                        dragSession?.activity.instanceId === activity.instanceId;
                      const startMin = isDraggingThis
                        ? dragSession.previewStartMin
                        : parseTimeToMinutes(activity.startTime);
                      const endMin = isDraggingThis
                        ? dragSession.previewEndMin
                        : parseTimeToMinutes(activity.endTime);

                      const clampedStart = Math.max(START_HOUR * 60, startMin);
                      const clampedEnd = Math.min(END_HOUR * 60, Math.max(clampedStart + 15, endMin));
                      const topPx = ((clampedStart - START_HOUR * 60) / 60) * HOUR_HEIGHT;
                      const heightPx = Math.max(
                        30,
                        ((clampedEnd - clampedStart) / 60) * HOUR_HEIGHT - 2
                      );

                      const widthPct = 100 / totalCols;
                      const leftPct = colIndex * widthPct;
                      const token = ACTIVITY_COLORS[activity.color] ?? ACTIVITY_COLORS.emerald;
                      const isDone = activity.status === 'completed';
                      const isSkipped = activity.status === 'skipped';

                      return (
                        <div
                          key={activity.instanceId}
                          data-activity-id={activity.activityId}
                          onPointerDown={(e) => handlePointerDownBlock(e, activity, 'move')}
                          onClick={() => {
                            if (dragMovedRef.current) return;
                            openQuickActivitySheet({ editingActivity: activity });
                          }}
                          style={{
                            top: `${topPx}px`,
                            height: `${heightPx}px`,
                            left: `calc(${leftPct}% + 4px)`,
                            width: `calc(${widthPct}% - 8px)`,
                          }}
                          className={`group absolute z-10 flex cursor-grab flex-col justify-between overflow-hidden rounded-2xl border px-3 py-1.5 active:cursor-grabbing ${
                            token.blockBg
                          } ${
                            highlightedActivityId === activity.activityId
                              ? 'ring-2 ring-[var(--df-accent)] border-[var(--df-accent)]'
                              : hasConflict
                              ? 'border-amber-500 ring-1 ring-amber-400/60'
                              : token.blockBorder
                          } ${isDraggingThis ? 'z-30 opacity-95' : ''} ${
                            isSkipped ? 'opacity-50' : ''
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2 min-w-0">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className={`h-2 w-2 rounded-full shrink-0 ${token.swatch}`} />
                                <p
                                  className={`truncate text-xs font-semibold ${token.blockText} ${
                                    isDone || isSkipped ? 'line-through opacity-60' : ''
                                  }`}
                                >
                                  {activity.title}
                                </p>
                                {activity.isRecurring && (
                                  <BiIcon name="repeat" className="text-[12px] shrink-0 text-[var(--df-text-muted)]" />
                                )}
                              </div>
                              <p className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-[var(--df-text-muted)]">
                                {formatTimeDisplay(minutesToTime24(startMin), timeFormat)} –{' '}
                                {formatTimeDisplay(minutesToTime24(endMin), timeFormat)}
                              </p>
                            </div>

                            <div className="hidden items-center gap-1 group-hover:flex shrink-0">
                              <button
                                type="button"
                                title={isDone ? 'Undo' : 'Done'}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActivityStatus(
                                    activity.activityId,
                                    activity.occurrenceDate,
                                    isDone ? 'pending' : 'completed'
                                  );
                                }}
                                className="rounded-lg bg-[var(--df-surface)] p-1 text-[var(--df-text)]"
                              >
                                <BiIcon name="check-lg" className="text-[12px]" />
                              </button>
                              <button
                                type="button"
                                title={isSkipped ? 'Restore' : 'Skip'}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActivityStatus(
                                    activity.activityId,
                                    activity.occurrenceDate,
                                    isSkipped ? 'pending' : 'skipped'
                                  );
                                }}
                                className="rounded-lg bg-[var(--df-surface)] p-1 text-[var(--df-text)]"
                              >
                                <BiIcon name="skip-forward" className="text-[12px]" />
                              </button>
                              <button
                                type="button"
                                title="Start Focus"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleLaunchFocus(activity);
                                }}
                                className="rounded-lg bg-[var(--df-accent)] p-1 text-[var(--df-accent-fg)]"
                              >
                                <BiIcon name="play-fill" className="text-[12px]" />
                              </button>
                            </div>
                          </div>

                          <div
                            onPointerDown={(e) => handlePointerDownBlock(e, activity, 'resize')}
                            title="Drag to resize"
                            className="absolute right-0 bottom-0 left-0 h-2 cursor-ns-resize hover:bg-black/10 dark:hover:bg-white/10"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {mode === 'week' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
              {weekDates.map((dateISO) => {
                const acts = resolveActivitiesForDate(state.activities, dateISO);
                const load = analyzeDayLoad(acts, dateISO, state.settings.dailyCapacityHours);
                const isToday = dateISO === todayISO;
                return (
                  <div
                    key={dateISO}
                    className={`flex flex-col rounded-2xl border bg-[var(--df-surface)] p-3 ${
                      isToday
                        ? 'border-[var(--df-border-strong)] ring-1 ring-[var(--df-accent)]'
                        : 'border-[var(--df-border)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedDate(dateISO);
                        setMode('day');
                      }}
                      className="flex items-center justify-between border-b border-[var(--df-border)] pb-2 text-left"
                    >
                      <div>
                        <p className="text-[11px] font-medium text-[var(--df-text-muted)]">
                          {format(parseISO(dateISO), 'EEE')}
                        </p>
                        <p className="font-mono text-sm font-semibold tabular-nums text-[var(--df-text)]">
                          {format(parseISO(dateISO), 'MMM d')}
                        </p>
                      </div>
                      <span
                        className={`font-mono text-[11px] tabular-nums ${
                          load.isOverloaded ? 'font-semibold text-rose-600' : 'text-[var(--df-text-muted)]'
                        }`}
                      >
                        {formatHoursDecimal(load.plannedMinutes)}
                      </span>
                    </button>

                    <div className="mt-2.5 flex-1 space-y-1.5">
                      {acts.length === 0 ? (
                        <p className="py-4 text-center text-[11px] text-[var(--df-text-subtle)]">Open</p>
                      ) : (
                        acts.map((act) => {
                          const token = ACTIVITY_COLORS[act.color] ?? ACTIVITY_COLORS.emerald;
                          return (
                            <button
                              key={act.instanceId}
                              type="button"
                              onClick={() => openQuickActivitySheet({ editingActivity: act })}
                              className={`w-full rounded-xl border px-2.5 py-1.5 text-left ${token.blockBg} ${token.blockBorder}`}
                            >
                              <p
                                className={`truncate text-xs font-medium ${token.blockText} ${
                                  act.status !== 'pending' ? 'line-through opacity-60' : ''
                                }`}
                              >
                                {act.title}
                              </p>
                              <p className="font-mono text-[10px] tabular-nums text-[var(--df-text-muted)]">
                                {formatTimeDisplay(act.startTime, timeFormat)}
                              </p>
                            </button>
                          );
                        })
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        openQuickActivitySheet({
                          initialDate: dateISO,
                          initialStartTime: '09:00',
                          initialEndTime: '10:00',
                        })
                      }
                      className="mt-2 rounded-xl border border-dashed border-[var(--df-border-strong)] py-1.5 text-[11px] font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
                    >
                      + Add
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {mode === 'month' && (
            <div className="space-y-5">
              <div className="overflow-hidden rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)]">
                <div className="grid grid-cols-7 border-b border-[var(--df-border)] bg-[var(--df-bg)]">
                  {weekdayHeaders.map((dayName) => (
                    <div
                      key={dayName}
                      className="py-2.5 text-center text-xs font-medium text-[var(--df-text-muted)]"
                    >
                      {dayName}
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-7">
                  {calendarDays.map((day) => {
                    const iso = format(day, 'yyyy-MM-dd');
                    const inMonth = isSameMonth(day, currentMonth);
                    const isToday = iso === todayISO;
                    const isSelected = iso === selectedDate;
                    const dayActs = activitiesByMonthDay[iso] ?? [];

                    return (
                      <button
                        key={iso}
                        type="button"
                        onClick={() => setSelectedDate(iso)}
                        className={`flex min-h-[82px] flex-col border-r border-b border-[var(--df-border)] p-2 text-left transition-colors last:border-r-0 ${
                          !inMonth ? 'bg-[var(--df-bg)] opacity-45' : ''
                        } ${
                          isSelected
                            ? 'bg-[var(--df-accent-soft)] ring-1 ring-inset ring-[var(--df-accent)]'
                            : 'hover:bg-[var(--df-surface-hover)]'
                        }`}
                      >
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-lg font-mono text-xs tabular-nums ${
                            isToday
                              ? 'bg-[var(--df-accent)] font-bold text-[var(--df-accent-fg)]'
                              : 'font-medium text-[var(--df-text)]'
                          }`}
                        >
                          {format(day, 'd')}
                        </span>

                        <div className="mt-1.5 w-full space-y-1">
                          {dayActs.slice(0, 2).map((act) => {
                            const token = ACTIVITY_COLORS[act.color] ?? ACTIVITY_COLORS.emerald;
                            return (
                              <div
                                key={act.instanceId}
                                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${token.blockBg} ${token.blockText}`}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${token.swatch}`} />
                                <span className="truncate">{act.title}</span>
                              </div>
                            );
                          })}
                          {dayActs.length > 2 && (
                            <p className="px-1 font-mono text-[10px] text-[var(--df-text-muted)]">
                              +{dayActs.length - 2}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Selected Day Agenda below Month */}
              <div className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
                <div className="flex items-center justify-between border-b border-[var(--df-border)] pb-3">
                  <div>
                    <p className="text-xs text-[var(--df-text-muted)]">Selected day</p>
                    <h3 className="font-display text-base font-bold text-[var(--df-text)]">
                      {formatDateHeading(selectedDate)}
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => openQuickActivitySheet({ initialDate: selectedDate })}
                    className="inline-flex h-9 items-center gap-1 rounded-xl bg-[var(--df-cta)] px-3 text-xs font-semibold text-[var(--df-cta-fg)]"
                  >
                    <BiIcon name="plus-lg" className="text-[13px]" /> Add
                  </button>
                </div>

                {dayActivities.length === 0 && selectedDayTasks.length === 0 ? (
                  <p className="py-6 text-center text-xs text-[var(--df-text-muted)]">
                    Nothing scheduled for this day yet.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {dayActivities.map((act) => (
                      <button
                        key={act.instanceId}
                        type="button"
                        onClick={() => openQuickActivitySheet({ editingActivity: act })}
                        className="flex w-full items-center justify-between rounded-2xl border border-[var(--df-border)] px-3.5 py-2.5 text-left hover:border-[var(--df-border-strong)]"
                      >
                        <span className="truncate text-sm font-medium text-[var(--df-text)]">
                          {act.title}
                        </span>
                        <span className="font-mono text-xs tabular-nums text-[var(--df-text-muted)]">
                          {formatTimeDisplay(act.startTime, timeFormat)}
                        </span>
                      </button>
                    ))}
                    {selectedDayTasks.map((t) => (
                      <label
                        key={t.id}
                        className="flex items-center gap-2.5 rounded-2xl border border-[var(--df-border)] px-3.5 py-2.5 text-xs text-[var(--df-text)]"
                      >
                        <input
                          type="checkbox"
                          checked={t.completed}
                          onChange={() => toggleTask(t.id)}
                          className="rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                        />
                        <span className={t.completed ? 'line-through opacity-50' : ''}>
                          Task: {t.title}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Progressive Smart Fit Panel */}
        {showSmartAssist && (
          <aside className="space-y-4 lg:col-span-4">
            <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-4">
              <div className="flex items-center justify-between border-b border-[var(--df-border)] pb-3">
                <div className="flex items-center gap-2">
                  <BiIcon name="clock" className="text-[15px] text-[var(--df-accent-soft-fg)]" />
                  <h3 className="text-sm font-semibold text-[var(--df-text)]">Open slots</h3>
                </div>
                <span className="text-xs text-[var(--df-text-muted)]">{format(parseISO(selectedDate), 'MMM d')}</span>
              </div>

              {availableSlots.length === 0 ? (
                <p className="py-4 text-xs text-[var(--df-text-muted)]">No open 30m+ windows left today.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {availableSlots.slice(0, 4).map((slot) => (
                    <div
                      key={`${slot.startTime}-${slot.endTime}`}
                      className="flex items-center justify-between rounded-2xl border border-[var(--df-border)] px-3 py-2"
                    >
                      <div>
                        <p className="font-mono text-xs font-semibold tabular-nums text-[var(--df-text)]">
                          {formatTimeDisplay(slot.startTime, timeFormat)} –{' '}
                          {formatTimeDisplay(slot.endTime, timeFormat)}
                        </p>
                        <p className="text-[11px] text-[var(--df-text-muted)]">
                          {formatDurationCompact(slot.durationMinutes)} free
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const endMin = Math.min(
                            parseTimeToMinutes(slot.endTime),
                            parseTimeToMinutes(slot.startTime) + 60
                          );
                          openQuickActivitySheet({
                            initialDate: selectedDate,
                            initialStartTime: slot.startTime,
                            initialEndTime: minutesToTime24(endMin),
                          });
                        }}
                        className="rounded-xl bg-[var(--df-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--df-accent-fg)]"
                      >
                        Use
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-4">
              <div className="flex items-center gap-2 border-b border-[var(--df-border)] pb-3">
                <BiIcon name="cup-hot" className="text-[15px] text-[var(--df-accent-soft-fg)]" />
                <h3 className="text-sm font-semibold text-[var(--df-text)]">Pacing check</h3>
              </div>
              {dayLoad.breakSuggestions.length === 0 ? (
                <p className="py-4 text-xs text-[var(--df-text-muted)]">
                  Your schedule has healthy breathing room between blocks.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  {dayLoad.breakSuggestions.map((b) => (
                    <div
                      key={`${b.afterActivity.instanceId}-${b.beforeActivity.instanceId}`}
                      className="rounded-2xl bg-[var(--df-bg)] p-3 text-xs text-[var(--df-text)]"
                    >
                      <p>
                        {formatDurationCompact(b.contiguousMinutes)} straight across{' '}
                        <span className="font-medium">{b.afterActivity.title}</span> &amp;{' '}
                        <span className="font-medium">{b.beforeActivity.title}</span>.
                      </p>
                      <button
                        type="button"
                        onClick={() => handleInsertBreak(b.suggestedBreakStart, b.suggestedBreakEnd)}
                        className="mt-2 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 font-medium text-[var(--df-text)] hover:border-[var(--df-border-strong)]"
                      >
                        + 15m break at {formatTimeDisplay(b.suggestedBreakStart, timeFormat)}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-4">
              <div className="flex items-center justify-between border-b border-[var(--df-border)] pb-3">
                <h3 className="text-sm font-semibold text-[var(--df-text)]">Unfinished rollover</h3>
                {unscheduledTasks.length > 0 && (
                  <button
                    type="button"
                    onClick={handleAutoDistributeTasks}
                    className="inline-flex items-center gap-1 rounded-xl bg-[var(--df-cta)] px-2.5 py-1 text-[11px] font-semibold text-[var(--df-cta-fg)]"
                  >
                    <BiIcon name="magic" className="text-[12px]" />
                    Auto-fit ({unscheduledTasks.length})
                  </button>
                )}
              </div>

              {unfinishedSummary.overdueTasks.length === 0 &&
              unfinishedSummary.unfinishedPastActivities.length === 0 ? (
                <p className="py-4 text-xs text-[var(--df-text-muted)]">Nothing overdue from the last 7 days.</p>
              ) : (
                <div className="mt-3 space-y-2 max-h-56 overflow-y-auto">
                  {unfinishedSummary.overdueTasks.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--df-border)] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-[var(--df-text)]">{task.title}</p>
                        <p className="text-[11px] text-rose-600">Overdue ({task.dueDate})</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          moveTaskToDate(task.id, selectedDate);
                          pushToast({ type: 'success', title: 'Moved task' });
                        }}
                        className="rounded-xl border border-[var(--df-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--df-text)] shrink-0"
                      >
                        Move here
                      </button>
                    </div>
                  ))}
                  {unfinishedSummary.unfinishedPastActivities.slice(0, 5).map((act) => (
                    <div
                      key={act.instanceId}
                      className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--df-border)] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-[var(--df-text)]">{act.title}</p>
                        <p className="text-[11px] text-[var(--df-text-muted)]">From {act.occurrenceDate}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          rolloverActivityToDate(act, selectedDate);
                          pushToast({ type: 'success', title: 'Rolled over' });
                        }}
                        className="rounded-xl border border-[var(--df-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--df-text)] shrink-0"
                      >
                        Pull here
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </aside>
        )}
      </div>

      <RecurringScopeModal
        isOpen={Boolean(pendingDragCommit)}
        actionLabel="Reschedule"
        activityTitle={pendingDragCommit?.activity.title ?? ''}
        onSelectScope={(scope) => {
          if (!pendingDragCommit) return;
          updateActivityOccurrence(
            pendingDragCommit.activity.activityId,
            pendingDragCommit.activity.occurrenceDate,
            {
              startTime: pendingDragCommit.newStart,
              endTime: pendingDragCommit.newEnd,
            },
            scope
          );
          pushToast({
            type: 'success',
            title: 'Rescheduled',
            description: pendingDragCommit.activity.title,
          });
          setPendingDragCommit(null);
        }}
        onCancel={() => setPendingDragCommit(null)}
      />
    </div>
  );
};
