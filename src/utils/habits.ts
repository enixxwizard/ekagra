import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { HabitItem, WeekStartDay } from '../types/dayflow';
import { getTodayISO, shiftDateISO } from './dateTime';

export interface HabitStats {
  habitId: string;
  currentStreak: number;
  longestStreak: number;
  monthCompletionRate: number; // 0..100
  monthCompletedCount: number;
  weekCompletedCount: number;
  totalCompletions: number;
}

export function isHabitCompletedOnDate(
  habitLogs: Record<string, string[]>,
  habitId: string,
  dateISO: string
): boolean {
  return (habitLogs[dateISO] ?? []).includes(habitId);
}

export function computeHabitStats(
  habit: HabitItem,
  habitLogs: Record<string, string[]>,
  weekStart: WeekStartDay,
  referenceDateISO = getTodayISO()
): HabitStats {
  const today = referenceDateISO;
  const completedDates = new Set<string>();

  for (const [dateKey, ids] of Object.entries(habitLogs)) {
    if (ids.includes(habit.id)) {
      completedDates.add(dateKey);
    }
  }

  // Current streak: for daily habits, count consecutive completed days ending today or yesterday
  let currentStreak = 0;
  if (habit.frequency === 'daily') {
    let cursor = completedDates.has(today) ? today : shiftDateISO(today, -1);
    while (completedDates.has(cursor)) {
      currentStreak += 1;
      cursor = shiftDateISO(cursor, -1);
    }
  } else {
    // Weekly habit: count consecutive weeks meeting targetPerWeek
    const weekStartsOn = weekStart === 'monday' ? 1 : 0;
    let weekRef = parseISO(today);
    for (let w = 0; w < 52; w++) {
      const ws = startOfWeek(weekRef, { weekStartsOn });
      const we = endOfWeek(weekRef, { weekStartsOn });
      const days = eachDayOfInterval({ start: ws, end: we });
      const hits = days.filter((d) => completedDates.has(format(d, 'yyyy-MM-dd'))).length;
      if (hits >= habit.targetPerWeek) {
        currentStreak += 1;
        weekRef = parseISO(shiftDateISO(format(ws, 'yyyy-MM-dd'), -1));
      } else if (w === 0) {
        // Current week still in progress; check previous week
        weekRef = parseISO(shiftDateISO(format(ws, 'yyyy-MM-dd'), -1));
      } else {
        break;
      }
    }
  }

  // Longest streak across all logged dates
  let longestStreak = 0;
  if (habit.frequency === 'daily') {
    const sorted = [...completedDates].sort();
    let run = 0;
    let prevDate: string | null = null;
    for (const d of sorted) {
      if (prevDate && shiftDateISO(prevDate, 1) === d) {
        run += 1;
      } else {
        run = 1;
      }
      if (run > longestStreak) longestStreak = run;
      prevDate = d;
    }
  } else {
    longestStreak = Math.max(currentStreak, completedDates.size >= habit.targetPerWeek ? 1 : 0);
  }

  // Month stats (up to today in the current month)
  const refDate = parseISO(today);
  const monthStart = startOfMonth(refDate);
  const monthEnd = endOfMonth(refDate);
  const effectiveEnd = monthEnd > refDate ? refDate : monthEnd;
  const elapsedDaysInMonth = eachDayOfInterval({ start: monthStart, end: effectiveEnd });
  const monthCompletedCount = elapsedDaysInMonth.filter((d) =>
    completedDates.has(format(d, 'yyyy-MM-dd'))
  ).length;

  let monthCompletionRate = 0;
  if (elapsedDaysInMonth.length > 0) {
    if (habit.frequency === 'daily') {
      monthCompletionRate = Math.round((monthCompletedCount / elapsedDaysInMonth.length) * 100);
    } else {
      const expectedInPeriod = Math.max(1, (elapsedDaysInMonth.length / 7) * habit.targetPerWeek);
      monthCompletionRate = Math.min(100, Math.round((monthCompletedCount / expectedInPeriod) * 100));
    }
  }

  // Current week completions
  const weekStartsOn = weekStart === 'monday' ? 1 : 0;
  const weekDays = eachDayOfInterval({
    start: startOfWeek(refDate, { weekStartsOn }),
    end: endOfWeek(refDate, { weekStartsOn }),
  });
  const weekCompletedCount = weekDays.filter((d) =>
    completedDates.has(format(d, 'yyyy-MM-dd'))
  ).length;

  return {
    habitId: habit.id,
    currentStreak,
    longestStreak,
    monthCompletionRate,
    monthCompletedCount,
    weekCompletedCount,
    totalCompletions: completedDates.size,
  };
}
