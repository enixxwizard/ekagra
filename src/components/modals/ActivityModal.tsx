import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Play,
  SkipForward,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { ActivityFormInput, useDayFlow } from '../../context/DayFlowContext';
import {
  ActivityCategory,
  ActivityColor,
  ActivityStatus,
  PriorityLevel,
  RecurrenceFrequency,
  ResolvedActivity,
} from '../../types/dayflow';
import { ACTIVITY_COLORS, CATEGORY_DEFAULT_COLORS } from '../../utils/colors';
import {
  formatTimeDisplay,
  getActivityDurationMinutes,
  getTodayISO,
  minutesToTime24,
  parseTimeToMinutes,
} from '../../utils/dateTime';
import { resolveActivitiesForDate } from '../../utils/recurrence';
import { findAvailableSlots } from '../../utils/scheduler';

interface ActivityModalProps {
  isOpen: boolean;
  initialDate?: string;
  initialStartTime?: string;
  initialEndTime?: string;
  initialTitle?: string;
  initialDescription?: string;
  initialCategory?: ActivityCategory;
  editingActivity?: ResolvedActivity | null;
  onClose: () => void;
}

const DURATION_PRESETS = [
  { label: '25m', minutes: 25 },
  { label: '45m', minutes: 45 },
  { label: '1h', minutes: 60 },
  { label: '1.5h', minutes: 90 },
  { label: '2h', minutes: 120 },
];

const CATEGORIES: ActivityCategory[] = [
  'Work',
  'Study',
  'Health',
  'Personal',
  'Deep Focus',
  'Admin',
];

const COLOR_OPTIONS: ActivityColor[] = [
  'emerald',
  'indigo',
  'sky',
  'amber',
  'violet',
  'rose',
  'slate',
];

const WEEKDAY_LABELS = [
  { day: 1, short: 'M' },
  { day: 2, short: 'T' },
  { day: 3, short: 'W' },
  { day: 4, short: 'T' },
  { day: 5, short: 'F' },
  { day: 6, short: 'S' },
  { day: 0, short: 'S' },
];

export const ActivityModal: React.FC<ActivityModalProps> = ({
  isOpen,
  initialDate,
  initialStartTime,
  initialEndTime,
  initialTitle,
  initialDescription,
  initialCategory,
  editingActivity,
  onClose,
}) => {
  const {
    state,
    saveActivity,
    updateActivityOccurrence,
    setActivityStatus,
    deleteActivity,
    setTimerLinkedActivity,
    resetTimer,
    setActivePage,
    pushToast,
  } = useDayFlow();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(getTodayISO());
  const [startTime, setStartTime] = useState('09:00');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [endTime, setEndTime] = useState('10:00');
  const [category, setCategory] = useState<ActivityCategory>('Work');
  const [color, setColor] = useState<ActivityColor>('emerald');
  const [priority, setPriority] = useState<PriorityLevel>('medium');
  const [status, setStatus] = useState<ActivityStatus>('pending');
  const [frequency, setFrequency] = useState<RecurrenceFrequency>('none');
  const [customDays, setCustomDays] = useState<number[]>([1, 3, 5]);
  const [endDate, setEndDate] = useState('');
  const [editScope, setEditScope] = useState<'single' | 'series'>('single');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');

  const masterActivity = useMemo(() => {
    if (!editingActivity) return null;
    return state.activities.find((a) => a.id === editingActivity.activityId) ?? null;
  }, [editingActivity, state.activities]);

  useEffect(() => {
    if (!isOpen) return;
    if (editingActivity) {
      const dur = Math.max(
        15,
        getActivityDurationMinutes(editingActivity.startTime, editingActivity.endTime)
      );
      setTitle(editingActivity.title);
      setDescription(editingActivity.description);
      setDate(editingActivity.occurrenceDate);
      setStartTime(editingActivity.startTime);
      setEndTime(editingActivity.endTime);
      setDurationMinutes(dur);
      setCategory(editingActivity.category);
      setColor(editingActivity.color);
      setPriority(editingActivity.priority);
      setStatus(editingActivity.status);
      setFrequency(editingActivity.recurrence?.frequency ?? 'none');
      setCustomDays(editingActivity.recurrence?.daysOfWeek ?? [1, 3, 5]);
      setEndDate(editingActivity.recurrence?.endDate ?? '');
      setEditScope(editingActivity.isRecurring ? 'single' : 'series');
      setShowAdvanced(false);
    } else {
      const targetDate = initialDate ?? getTodayISO();
      const sTime = initialStartTime ?? '09:00';
      const eTime = initialEndTime ?? minutesToTime24(parseTimeToMinutes(sTime) + 60);
      const dur = Math.max(15, parseTimeToMinutes(eTime) - parseTimeToMinutes(sTime));
      const cat = initialCategory ?? 'Work';
      setTitle(initialTitle ?? '');
      setDescription(initialDescription ?? '');
      setDate(targetDate);
      setStartTime(sTime);
      setEndTime(eTime);
      setDurationMinutes(dur);
      setCategory(cat);
      setColor(CATEGORY_DEFAULT_COLORS[cat] ?? 'emerald');
      setPriority('medium');
      setStatus('pending');
      setFrequency('none');
      setCustomDays([1, 3, 5]);
      setEndDate('');
      setEditScope('series');
      setShowAdvanced(false);
    }
    setError('');
  }, [isOpen, editingActivity, initialDate, initialStartTime, initialEndTime]);

  const dayActivities = useMemo(() => {
    return resolveActivitiesForDate(state.activities, date).filter(
      (a) => a.activityId !== editingActivity?.activityId && a.status !== 'skipped'
    );
  }, [state.activities, date, editingActivity?.activityId]);

  const overlaps = useMemo(() => {
    const startMin = parseTimeToMinutes(startTime);
    const endMin = parseTimeToMinutes(endTime);
    if (endMin <= startMin) return [];
    return dayActivities.filter((other) => {
      const oStart = parseTimeToMinutes(other.startTime);
      const oEnd = parseTimeToMinutes(other.endTime);
      return Math.min(endMin, oEnd) > Math.max(startMin, oStart);
    });
  }, [dayActivities, startTime, endTime]);

  const openSlots = useMemo(() => {
    return findAvailableSlots(dayActivities, date, Math.min(60, durationMinutes), 6, 23).slice(0, 3);
  }, [dayActivities, date, durationMinutes]);

  if (!isOpen) return null;

  const handleStartTimeChange = (nextStart: string) => {
    setStartTime(nextStart);
    const sMin = parseTimeToMinutes(nextStart);
    setEndTime(minutesToTime24(Math.min(23 * 60 + 55, sMin + durationMinutes)));
  };

  const handleSelectDuration = (mins: number) => {
    setDurationMinutes(mins);
    const sMin = parseTimeToMinutes(startTime);
    setEndTime(minutesToTime24(Math.min(23 * 60 + 55, sMin + mins)));
  };

  const handleEndTimeChange = (nextEnd: string) => {
    setEndTime(nextEnd);
    const diff = parseTimeToMinutes(nextEnd) - parseTimeToMinutes(startTime);
    if (diff > 0) setDurationMinutes(diff);
  };

  const toggleCustomDay = (dayNum: number) => {
    setCustomDays((prev) =>
      prev.includes(dayNum) ? prev.filter((d) => d !== dayNum) : [...prev, dayNum]
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Give your activity a quick name.');
      return;
    }
    const sMin = parseTimeToMinutes(startTime);
    const eMin = parseTimeToMinutes(endTime);
    if (eMin <= sMin) {
      setError('End time needs to be after start time.');
      return;
    }
    if (frequency === 'custom_weekdays' && customDays.length === 0) {
      setError('Pick at least one day to repeat.');
      return;
    }

    if (editingActivity && editingActivity.isRecurring && editScope === 'single') {
      updateActivityOccurrence(
        editingActivity.activityId,
        editingActivity.occurrenceDate,
        {
          title: title.trim(),
          description: description.trim(),
          startTime,
          endTime,
          category,
          color,
          priority,
          status,
        },
        'single'
      );
      pushToast({
        type: 'success',
        title: 'Updated for this day',
        description: title.trim(),
      });
      onClose();
      return;
    }

    const input: ActivityFormInput = {
      id: editingActivity?.activityId,
      title: title.trim(),
      description: description.trim(),
      date:
        editingActivity && editingActivity.isRecurring && masterActivity
          ? masterActivity.date
          : date,
      startTime,
      endTime,
      category,
      color,
      priority,
      status,
      recurrence: {
        frequency,
        daysOfWeek: frequency === 'custom_weekdays' ? customDays : undefined,
        endDate: frequency !== 'none' && endDate ? endDate : null,
      },
    };

    saveActivity(input);
    pushToast({
      type: 'success',
      title: editingActivity ? 'Saved changes' : 'Added to your day',
      description: `${input.title} · ${formatTimeDisplay(startTime, state.settings.timeFormat)}`,
    });
    onClose();
  };

  const handleDelete = () => {
    if (!editingActivity) return;
    if (editingActivity.isRecurring) {
      deleteActivity(editingActivity.activityId, editingActivity.occurrenceDate, editScope);
    } else {
      deleteActivity(editingActivity.activityId);
    }
    pushToast({
      type: 'info',
      title: 'Removed',
      description: editingActivity.title,
    });
    onClose();
  };

  const handleQuickFocus = () => {
    if (!editingActivity) return;
    setTimerLinkedActivity(editingActivity.activityId);
    resetTimer(state.settings.defaultFocusMinutes);
    onClose();
    setActivePage('focus');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      style={{ backgroundColor: 'var(--df-backdrop)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-activity-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="animate-sheet-up max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-[var(--df-border)] bg-[var(--df-surface)] sm:max-w-lg sm:rounded-3xl">
        {/* Mobile grab handle */}
        <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-[var(--df-border)] sm:hidden" />

        <div className="flex items-center justify-between px-6 pt-4 pb-2 sm:pt-5">
          <h2
            id="quick-activity-title"
            className="font-display text-lg font-semibold text-[var(--df-text)]"
          >
            {editingActivity ? 'Edit activity' : 'Add activity'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--df-text-muted)] hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 px-6 pt-2 pb-6">
          {error && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs font-medium text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </p>
          )}

          {/* Recurring Scope Switcher when editing */}
          {editingActivity?.isRecurring && (
            <div className="flex items-center gap-1 rounded-xl bg-[var(--df-surface-subtle)] p-1">
              <button
                type="button"
                onClick={() => setEditScope('single')}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  editScope === 'single'
                    ? 'bg-[var(--df-surface)] text-[var(--df-text)]'
                    : 'text-[var(--df-text-muted)]'
                }`}
              >
                Just this day
              </button>
              <button
                type="button"
                onClick={() => setEditScope('series')}
                className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  editScope === 'series'
                    ? 'bg-[var(--df-surface)] text-[var(--df-text)]'
                    : 'text-[var(--df-text-muted)]'
                }`}
              >
                All repeats
              </button>
            </div>
          )}

          {/* 1. Activity Name */}
          <div>
            <label htmlFor="qa-title" className="sr-only">
              Activity name
            </label>
            <input
              id="qa-title"
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What are you working on?"
              className="w-full rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 py-3 text-base font-medium text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:bg-[var(--df-surface)] focus:outline-none"
            />
          </div>

          {/* 2. Time + 3. Duration */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-12">
            <div className="sm:col-span-5">
              <label
                htmlFor="qa-start"
                className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]"
              >
                Start time
              </label>
              <input
                id="qa-start"
                type="time"
                value={startTime}
                onChange={(e) => handleStartTimeChange(e.target.value)}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 font-mono text-sm tabular-nums text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
              />
            </div>

            <div className="sm:col-span-7">
              <span className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
                Duration
              </span>
              <div className="flex flex-wrap gap-1.5">
                {DURATION_PRESETS.map((preset) => {
                  const active = durationMinutes === preset.minutes;
                  return (
                    <button
                      key={preset.minutes}
                      type="button"
                      onClick={() => handleSelectDuration(preset.minutes)}
                      className={`min-h-[40px] flex-1 rounded-xl border px-2.5 font-mono text-xs font-medium tabular-nums transition-colors ${
                        active
                          ? 'border-[var(--df-accent)] bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                          : 'border-[var(--df-border)] bg-[var(--df-bg)] text-[var(--df-text)] hover:border-[var(--df-border-strong)]'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Overlap Helper (only appears when there is an actual overlap) */}
          {overlaps.length > 0 && (
            <div className="rounded-2xl border border-amber-300 bg-amber-50/80 p-3 text-xs text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="flex-1">
                  <p className="font-medium">
                    Overlaps with {overlaps.map((o) => o.title).join(', ')}
                  </p>
                  {openSlots.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 text-[11px] opacity-80">
                        <Sparkles className="h-3 w-3" /> Try open slot:
                      </span>
                      {openSlots.map((slot) => (
                        <button
                          key={slot.startTime}
                          type="button"
                          onClick={() => handleStartTimeChange(slot.startTime)}
                          className="rounded-lg border border-amber-300 bg-[var(--df-surface)] px-2 py-1 font-mono text-[11px] font-medium tabular-nums text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200"
                        >
                          {formatTimeDisplay(slot.startTime, state.settings.timeFormat)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 4. Optional Repeat */}
          {(!editingActivity || !editingActivity.isRecurring || editScope === 'series') && (
            <div>
              <label
                htmlFor="qa-repeat"
                className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]"
              >
                Repeat
              </label>
              <select
                id="qa-repeat"
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as RecurrenceFrequency)}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:outline-none"
              >
                <option value="none">Just once</option>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays (Mon–Fri)</option>
                <option value="weekends">Weekends (Sat–Sun)</option>
                <option value="weekly">Every week</option>
                <option value="custom_weekdays">Pick specific days</option>
              </select>

              {frequency === 'custom_weekdays' && (
                <div className="mt-2.5 flex gap-1.5">
                  {WEEKDAY_LABELS.map((item) => {
                    const active = customDays.includes(item.day);
                    return (
                      <button
                        key={item.day}
                        type="button"
                        onClick={() => toggleCustomDay(item.day)}
                        className={`flex h-9 flex-1 items-center justify-center rounded-xl border text-xs font-semibold transition-colors ${
                          active
                            ? 'border-[var(--df-accent)] bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                            : 'border-[var(--df-border)] text-[var(--df-text-muted)]'
                        }`}
                      >
                        {item.short}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Quick contextual actions when editing */}
          {editingActivity && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleQuickFocus}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-3.5 py-2 text-xs font-semibold text-[var(--df-accent-fg)] transition-transform active:scale-95"
              >
                <Play className="h-3.5 w-3.5" />
                Start Focus
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = editingActivity.status === 'skipped' ? 'pending' : 'skipped';
                  setActivityStatus(editingActivity.activityId, editingActivity.occurrenceDate, next);
                  onClose();
                }}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--df-border)] px-3 py-2 text-xs font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
              >
                <SkipForward className="h-3.5 w-3.5" />
                {editingActivity.status === 'skipped' ? 'Unskip' : 'Skip today'}
              </button>
            </div>
          )}

          {/* Progressive Disclosure Trigger */}
          <div className="border-t border-[var(--df-border)] pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between py-1 text-xs font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
            >
              <span>{showAdvanced ? 'Hide extra options' : 'More options (date, notes, tag, colour)'}</span>
              {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="qa-date"
                      className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]"
                    >
                      Date
                    </label>
                    <input
                      id="qa-date"
                      type="date"
                      disabled={Boolean(editingActivity?.isRecurring && editScope === 'single')}
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)] disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="qa-end"
                      className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]"
                    >
                      Custom end time
                    </label>
                    <input
                      id="qa-end"
                      type="time"
                      value={endTime}
                      onChange={(e) => handleEndTimeChange(e.target.value)}
                      className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 font-mono text-xs tabular-nums text-[var(--df-text)]"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="qa-notes"
                    className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]"
                  >
                    Notes
                  </label>
                  <textarea
                    id="qa-notes"
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Links, focus goal, or checklist..."
                    className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)]"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2.5">
                  <div>
                    <label
                      htmlFor="qa-cat"
                      className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]"
                    >
                      Category
                    </label>
                    <select
                      id="qa-cat"
                      value={category}
                      onChange={(e) => {
                        const next = e.target.value as ActivityCategory;
                        setCategory(next);
                        if (!editingActivity) {
                          setColor(CATEGORY_DEFAULT_COLORS[next] ?? 'emerald');
                        }
                      }}
                      className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-2 text-xs text-[var(--df-text)]"
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="qa-priority"
                      className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]"
                    >
                      Priority
                    </label>
                    <select
                      id="qa-priority"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as PriorityLevel)}
                      className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-2 text-xs text-[var(--df-text)]"
                    >
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="qa-status"
                      className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]"
                    >
                      Status
                    </label>
                    <select
                      id="qa-status"
                      value={status}
                      onChange={(e) => setStatus(e.target.value as ActivityStatus)}
                      className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-2 text-xs text-[var(--df-text)]"
                    >
                      <option value="pending">Pending</option>
                      <option value="completed">Done</option>
                      <option value="skipped">Skipped</option>
                    </select>
                  </div>
                </div>

                <div>
                  <span className="mb-1.5 block text-xs font-medium text-[var(--df-text-muted)]">
                    Colour
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {COLOR_OPTIONS.map((col) => {
                      const token = ACTIVITY_COLORS[col];
                      return (
                        <button
                          key={col}
                          type="button"
                          onClick={() => setColor(col)}
                          aria-label={token.label}
                          className={`flex h-8 w-8 items-center justify-center rounded-xl border transition-transform ${
                            color === col
                              ? 'scale-105 border-[var(--df-border-strong)] ring-2 ring-[var(--df-accent)]'
                              : 'border-[var(--df-border)]'
                          }`}
                        >
                          <span className={`h-4 w-4 rounded-md ${token.swatch}`} />
                        </button>
                      );
                    })}
                  </div>
                </div>

                {frequency !== 'none' && (!editingActivity || editScope === 'series') && (
                  <div>
                    <label
                      htmlFor="qa-rec-end"
                      className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]"
                    >
                      Stop repeating after (optional)
                    </label>
                    <input
                      id="qa-rec-end"
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)]"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer Buttons */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <div>
              {editingActivity && (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-11 rounded-xl border border-[var(--df-border)] px-4 text-sm font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="h-11 rounded-xl bg-[var(--df-cta)] px-5 text-sm font-semibold text-[var(--df-cta-fg)] transition-transform active:scale-[0.98]"
              >
                {editingActivity ? 'Save' : 'Add to day'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
