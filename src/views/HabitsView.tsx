import React, { useMemo, useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { HabitModal } from '../components/modals/HabitModal';
import { BiIcon } from '../components/ui/BiIcon';
import { useDayFlow } from '../context/DayFlowContext';
import { HabitItem } from '../types/dayflow';
import { ACTIVITY_COLORS } from '../utils/colors';
import { getTodayISO } from '../utils/dateTime';
import { computeHabitStats, isHabitCompletedOnDate } from '../utils/habits';

export const HabitsView: React.FC = () => {
  const { state, toggleHabitLog, deleteHabit, pushToast } = useDayFlow();
  const todayISO = getTodayISO();

  const [habitModalOpen, setHabitModalOpen] = useState(false);
  const [editingHabit, setEditingHabit] = useState<HabitItem | null>(null);
  const [selectedHabitId, setSelectedHabitId] = useState<string | null>(
    state.habits[0]?.id ?? null
  );
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => startOfMonth(new Date()));

  const activeHabit = useMemo(() => {
    if (state.habits.length === 0) return null;
    return state.habits.find((h) => h.id === selectedHabitId) ?? state.habits[0];
  }, [state.habits, selectedHabitId]);

  const habitStatsMap = useMemo(() => {
    const map: Record<string, ReturnType<typeof computeHabitStats>> = {};
    for (const h of state.habits) {
      map[h.id] = computeHabitStats(h, state.habitLogs, state.settings.weekStart, todayISO);
    }
    return map;
  }, [state.habits, state.habitLogs, state.settings.weekStart, todayISO]);

  const weekStartsOn = state.settings.weekStart === 'monday' ? 1 : 0;

  const monthGridDays = useMemo(() => {
    const mStart = startOfMonth(calendarMonth);
    const mEnd = endOfMonth(calendarMonth);
    return eachDayOfInterval({
      start: startOfWeek(mStart, { weekStartsOn }),
      end: endOfWeek(mEnd, { weekStartsOn }),
    });
  }, [calendarMonth, weekStartsOn]);

  const weekdayHeaders =
    weekStartsOn === 1
      ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--df-text-muted)]">
          Tap checkmarks for today, or pick a habit to log past dates.
        </p>
        <button
          type="button"
          onClick={() => {
            setEditingHabit(null);
            setHabitModalOpen(true);
          }}
          className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-[var(--df-cta)] px-3.5 text-xs font-semibold text-[var(--df-cta-fg)] whitespace-nowrap shrink-0"
        >
          <BiIcon name="plus-lg" className="text-xs" />
          New habit
        </button>
      </div>

      {state.habits.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-[var(--df-border-strong)] py-12 text-center">
          <p className="font-display text-base font-semibold text-[var(--df-text)]">No habits yet</p>
          <p className="mt-1 text-xs text-[var(--df-text-muted)]">
            Start small—track one daily routine to build momentum.
          </p>
          <button
            type="button"
            onClick={() => {
              setEditingHabit(null);
              setHabitModalOpen(true);
            }}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-4 py-2 text-xs font-semibold text-[var(--df-accent-fg)]"
          >
            <BiIcon name="plus-lg" className="text-xs" />
            Create habit
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="space-y-3 lg:col-span-6">
            {state.habits.map((habit) => {
              const stats = habitStatsMap[habit.id];
              const doneToday = isHabitCompletedOnDate(state.habitLogs, habit.id, todayISO);
              const isSelected = activeHabit?.id === habit.id;
              const token = ACTIVITY_COLORS[habit.color] ?? ACTIVITY_COLORS.emerald;

              return (
                <div
                  key={habit.id}
                  onClick={() => setSelectedHabitId(habit.id)}
                  className={`cursor-pointer rounded-3xl border bg-[var(--df-surface)] p-4 transition-colors ${
                    isSelected
                      ? 'border-[var(--df-border-strong)] ring-1 ring-[var(--df-accent)]'
                      : 'border-[var(--df-border)] hover:border-[var(--df-border-strong)]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleHabitLog(habit.id, todayISO);
                        }}
                        aria-label={doneToday ? `Unmark ${habit.title}` : `Complete ${habit.title}`}
                        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-transform active:scale-90 ${
                          doneToday
                            ? 'border-[var(--df-accent)] bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                            : 'border-[var(--df-border)] bg-[var(--df-bg)] text-transparent hover:border-[var(--df-border-strong)]'
                        }`}
                      >
                        <BiIcon name="check-lg" className="text-sm font-bold" />
                      </button>

                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full shrink-0 ${token.swatch}`} />
                          <h3 className="truncate text-sm font-semibold text-[var(--df-text)]">
                            {habit.title}
                          </h3>
                        </div>
                        {habit.description && (
                          <p className="mt-0.5 text-xs text-[var(--df-text-muted)]">
                            {habit.description}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingHabit(habit);
                          setHabitModalOpen(true);
                        }}
                        aria-label={`Edit ${habit.title}`}
                        className="rounded-lg p-1.5 text-[var(--df-text-subtle)] hover:text-[var(--df-text)]"
                      >
                        <BiIcon name="pencil" className="text-xs" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteHabit(habit.id);
                          pushToast({ type: 'info', title: 'Habit deleted', description: habit.title });
                        }}
                        aria-label={`Delete ${habit.title}`}
                        className="rounded-lg p-1.5 text-[var(--df-text-subtle)] hover:text-rose-600"
                      >
                        <BiIcon name="trash3" className="text-xs" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-4 gap-2 border-t border-[var(--df-border)] pt-3 text-xs">
                    <div>
                      <span className="block text-[11px] text-[var(--df-text-muted)]">Streak</span>
                      <span className="mt-0.5 inline-flex items-center gap-1 font-mono font-semibold tabular-nums text-[var(--df-text)]">
                        <BiIcon name="fire" className="text-xs text-amber-500" />
                        {stats.currentStreak}
                        {habit.frequency === 'daily' ? 'd' : 'w'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[11px] text-[var(--df-text-muted)]">Best</span>
                      <span className="mt-0.5 inline-flex items-center gap-1 font-mono font-semibold tabular-nums text-[var(--df-text)]">
                        <BiIcon name="trophy" className="text-xs text-[var(--df-accent-soft-fg)]" />
                        {stats.longestStreak}
                        {habit.frequency === 'daily' ? 'd' : 'w'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[11px] text-[var(--df-text-muted)]">Week</span>
                      <span className="mt-0.5 block font-mono font-semibold tabular-nums text-[var(--df-text)]">
                        {stats.weekCompletedCount}/{habit.targetPerWeek}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[11px] text-[var(--df-text-muted)]">Month</span>
                      <span className="mt-0.5 block font-mono font-semibold tabular-nums text-[var(--df-text)]">
                        {stats.monthCompletionRate}%
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {activeHabit && (
            <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5 lg:col-span-6">
              <div className="flex items-center justify-between gap-2 border-b border-[var(--df-border)] pb-4">
                <div className="min-w-0">
                  <p className="text-xs text-[var(--df-text-muted)]">Habit calendar</p>
                  <h3 className="truncate font-display text-base font-bold text-[var(--df-text)]">
                    {activeHabit.title}
                  </h3>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setCalendarMonth((m) => subMonths(m, 1))}
                    aria-label="Previous month"
                    className="rounded-xl border border-[var(--df-border)] p-1.5 text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
                  >
                    <BiIcon name="chevron-left" className="text-sm" />
                  </button>
                  <span className="min-w-[108px] text-center text-xs font-semibold text-[var(--df-text)]">
                    {format(calendarMonth, 'MMMM yyyy')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCalendarMonth((m) => addMonths(m, 1))}
                    aria-label="Next month"
                    className="rounded-xl border border-[var(--df-border)] p-1.5 text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
                  >
                    <BiIcon name="chevron-right" className="text-sm" />
                  </button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-7 gap-1.5 text-center">
                {weekdayHeaders.map((w) => (
                  <div key={w} className="py-1 text-[11px] font-medium text-[var(--df-text-muted)]">
                    {w}
                  </div>
                ))}

                {monthGridDays.map((day) => {
                  const iso = format(day, 'yyyy-MM-dd');
                  const inMonth = isSameMonth(day, calendarMonth);
                  const completed = isHabitCompletedOnDate(state.habitLogs, activeHabit.id, iso);
                  const isFuture = iso > todayISO;
                  const isToday = iso === todayISO;

                  return (
                    <button
                      key={iso}
                      type="button"
                      disabled={!inMonth || isFuture}
                      onClick={() => toggleHabitLog(activeHabit.id, iso)}
                      className={`flex h-10 items-center justify-center rounded-xl font-mono text-xs tabular-nums transition-colors ${
                        !inMonth
                          ? 'opacity-20 cursor-default'
                          : isFuture
                          ? 'border border-[var(--df-border)] text-[var(--df-text-subtle)] opacity-50 cursor-not-allowed'
                          : completed
                          ? 'bg-[var(--df-accent)] font-semibold text-[var(--df-accent-fg)]'
                          : isToday
                          ? 'border-2 border-[var(--df-accent)] text-[var(--df-text)]'
                          : 'border border-[var(--df-border)] text-[var(--df-text)] hover:bg-[var(--df-surface-hover)]'
                      }`}
                    >
                      {format(day, 'd')}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      <HabitModal
        isOpen={habitModalOpen}
        editingHabit={editingHabit}
        onClose={() => setHabitModalOpen(false)}
      />
    </div>
  );
};
