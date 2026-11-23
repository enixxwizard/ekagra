import React, { useEffect, useMemo, useState } from 'react';
import { BiIcon } from '../ui/BiIcon';
import { useDayFlow } from '../../context/DayFlowContext';
import { TaskItem } from '../../types/dayflow';
import {
  formatTimeDisplay,
  getTodayISO,
  minutesToTime24,
  parseTimeToMinutes,
} from '../../utils/dateTime';
import { resolveActivitiesForDate } from '../../utils/recurrence';
import { findAvailableSlots } from '../../utils/scheduler';

interface ScheduleTaskModalProps {
  task: TaskItem | null;
  onClose: () => void;
}

export const ScheduleTaskModal: React.FC<ScheduleTaskModalProps> = ({ task, onClose }) => {
  const { state, scheduleTaskAsActivity, pushToast } = useDayFlow();
  const [date, setDate] = useState(getTodayISO());
  const [startTime, setStartTime] = useState('14:00');
  const [endTime, setEndTime] = useState('15:00');
  const [error, setError] = useState('');

  const suggestedSlots = useMemo(() => {
    if (!task) return [];
    const dayActs = resolveActivitiesForDate(state.activities, date);
    return findAvailableSlots(dayActs, date, Math.min(30, task.estimatedMinutes || 30), 7, 22).slice(
      0,
      4
    );
  }, [state.activities, date, task]);

  useEffect(() => {
    if (!task) return;
    const targetDate = task.dueDate && task.dueDate >= getTodayISO() ? task.dueDate : getTodayISO();
    setDate(targetDate);
    setError('');
  }, [task]);

  useEffect(() => {
    if (!task || suggestedSlots.length === 0) return;
    const first = suggestedSlots[0];
    const dur = Math.min(task.estimatedMinutes || 45, first.durationMinutes);
    const startMin = parseTimeToMinutes(first.startTime);
    setStartTime(first.startTime);
    setEndTime(minutesToTime24(startMin + Math.max(15, dur)));
  }, [suggestedSlots, task]);

  if (!task) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (parseTimeToMinutes(endTime) <= parseTimeToMinutes(startTime)) {
      setError('End time must be after start time.');
      return;
    }
    scheduleTaskAsActivity(task.id, date, startTime, endTime);
    pushToast({
      type: 'success',
      title: 'Added to timeline',
      description: `${task.title} · ${formatTimeDisplay(startTime, state.settings.timeFormat)}`,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      style={{ backgroundColor: 'var(--df-backdrop)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-task-title"
    >
      <div className="animate-sheet-up w-full rounded-t-3xl border border-[var(--df-border)] bg-[var(--df-surface)] sm:max-w-md sm:rounded-3xl">
        <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-[var(--df-border)] sm:hidden" />

        <div className="flex items-center justify-between px-6 pt-4 pb-2 sm:pt-5">
          <h2 id="schedule-task-title" className="font-display text-lg font-semibold text-[var(--df-text)]">
            Place on timeline
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--df-text-muted)] transition-colors hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
          >
            <BiIcon name="x-lg" className="text-[14px]" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 pt-2 pb-6">
          <div className="rounded-2xl bg-[var(--df-bg)] px-3.5 py-2.5">
            <p className="text-sm font-semibold text-[var(--df-text)]">{task.title}</p>
            <p className="mt-0.5 text-xs text-[var(--df-text-muted)]">Est. {task.estimatedMinutes}m</p>
          </div>

          {error && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </p>
          )}

          <div>
            <label htmlFor="sched-date" className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
              Date
            </label>
            <input
              id="sched-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-sm text-[var(--df-text)]"
            />
          </div>

          {suggestedSlots.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-[var(--df-text-muted)]">
                <BiIcon name="stars" className="text-[13px] text-[var(--df-accent-soft-fg)]" />
                Open slots
              </p>
              <div className="grid grid-cols-2 gap-2">
                {suggestedSlots.map((slot) => {
                  const slotDur = Math.min(task.estimatedMinutes || 45, slot.durationMinutes);
                  const endStr = minutesToTime24(parseTimeToMinutes(slot.startTime) + Math.max(15, slotDur));
                  return (
                    <button
                      key={`${slot.startTime}-${slot.endTime}`}
                      type="button"
                      onClick={() => {
                        setStartTime(slot.startTime);
                        setEndTime(endStr);
                      }}
                      className="rounded-2xl border border-[var(--df-border)] px-3 py-2 text-left text-xs text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)]"
                    >
                      <span className="block font-mono font-semibold tabular-nums">
                        {formatTimeDisplay(slot.startTime, state.settings.timeFormat)}
                      </span>
                      <span className="text-[var(--df-text-muted)]">{slot.durationMinutes}m free</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="sched-start" className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                Start
              </label>
              <input
                id="sched-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 font-mono text-sm tabular-nums text-[var(--df-text)]"
              />
            </div>
            <div>
              <label htmlFor="sched-end" className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                End
              </label>
              <input
                id="sched-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 font-mono text-sm tabular-nums text-[var(--df-text)]"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-11 rounded-xl border border-[var(--df-border)] px-4 text-sm font-medium text-[var(--df-text-muted)] transition-colors hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="h-11 rounded-xl bg-[var(--df-accent)] px-5 text-sm font-semibold text-[var(--df-accent-fg)]"
            >
              Add to day
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
