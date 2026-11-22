import { format, parseISO } from 'date-fns';
import {
  DayFlowState,
  WeekStartDay,
} from '../types/dayflow';
import {
  getActivityDurationMinutes,
  getTodayISO,
  getWeekDateStrings,
  shiftDateISO,
} from './dateTime';
import { resolveActivitiesForDate } from './recurrence';

export interface DailyProductivityPoint {
  date: string;
  label: string;
  plannedHours: number;
  actualFocusHours: number;
  completionRate: number;
  completedActivities: number;
  totalActivities: number;
}

export interface CategoryFocusPoint {
  category: string;
  minutes: number;
  hours: number;
}

export interface AnalyticsSummary {
  todayPlannedMinutes: number;
  todayActualFocusMinutes: number;
  todayCompletionRate: number;
  todayCompletedActivities: number;
  todayTotalActivities: number;
  totalCompletedTasks: number;
  totalTasks: number;
  overallTaskCompletionRate: number;
  weeklySeries: DailyProductivityPoint[];
  focusByCategory: CategoryFocusPoint[];
  habitConsistencyPercent: number;
  mostProductiveDay: { label: string; score: number; focusHours: number } | null;
  totalFocusHoursAllTime: number;
  weeklyCompletionTrendDelta: number | null; // % points vs prior 7 days
}

export function calculateAnalytics(
  state: DayFlowState,
  todayISO = getTodayISO()
): AnalyticsSummary {
  const { tasks, activities, focusSessions, habits, habitLogs, settings } = state;

  // Today metrics
  const todayActs = resolveActivitiesForDate(activities, todayISO);
  const nonSkippedToday = todayActs.filter((a) => a.status !== 'skipped');
  const todayCompletedActivities = nonSkippedToday.filter((a) => a.status === 'completed').length;
  const todayTotalActivities = nonSkippedToday.length;
  const todayCompletionRate =
    todayTotalActivities > 0
      ? Math.round((todayCompletedActivities / todayTotalActivities) * 100)
      : 0;

  const todayPlannedMinutes = nonSkippedToday.reduce(
    (sum, a) => sum + getActivityDurationMinutes(a.startTime, a.endTime),
    0
  );

  const todayActualFocusMinutes = focusSessions
    .filter((s) => s.date === todayISO && s.mode === 'focus')
    .reduce((sum, s) => sum + s.actualMinutes, 0);

  // Tasks summary
  const totalTasks = tasks.length;
  const totalCompletedTasks = tasks.filter((t) => t.completed).length;
  const overallTaskCompletionRate =
    totalTasks > 0 ? Math.round((totalCompletedTasks / totalTasks) * 100) : 0;

  // Weekly chart series (based on user's week start preference around today)
  const weekDates = getWeekDateStrings(todayISO, settings.weekStart as WeekStartDay);
  const weeklySeries: DailyProductivityPoint[] = weekDates.map((dateISO) => {
    const dayActs = resolveActivitiesForDate(activities, dateISO).filter(
      (a) => a.status !== 'skipped'
    );
    const completed = dayActs.filter((a) => a.status === 'completed').length;
    const total = dayActs.length;
    const plannedMins = dayActs.reduce(
      (sum, a) => sum + getActivityDurationMinutes(a.startTime, a.endTime),
      0
    );
    const focusMins = focusSessions
      .filter((s) => s.date === dateISO && s.mode === 'focus')
      .reduce((sum, s) => sum + s.actualMinutes, 0);

    return {
      date: dateISO,
      label: format(parseISO(dateISO), 'EEE'),
      plannedHours: Number((plannedMins / 60).toFixed(2)),
      actualFocusHours: Number((focusMins / 60).toFixed(2)),
      completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
      completedActivities: completed,
      totalActivities: total,
    };
  });

  // Focus time by category (real focus sessions)
  const catMap = new Map<string, number>();
  for (const session of focusSessions) {
    if (session.mode !== 'focus' || session.actualMinutes <= 0) continue;
    const prev = catMap.get(session.category) ?? 0;
    catMap.set(session.category, prev + session.actualMinutes);
  }
  const focusByCategory: CategoryFocusPoint[] = Array.from(catMap.entries())
    .map(([category, minutes]) => ({
      category,
      minutes,
      hours: Number((minutes / 60).toFixed(2)),
    }))
    .sort((a, b) => b.minutes - a.minutes);

  // Habit consistency across last 7 days
  let habitConsistencyPercent = 0;
  if (habits.length > 0) {
    const last7 = Array.from({ length: 7 }, (_, i) => shiftDateISO(todayISO, -i));
    let expected = 0;
    let achieved = 0;
    for (const habit of habits) {
      if (habit.frequency === 'daily') {
        expected += 7;
        achieved += last7.filter((d) => (habitLogs[d] ?? []).includes(habit.id)).length;
      } else {
        expected += habit.targetPerWeek;
        const hits = last7.filter((d) => (habitLogs[d] ?? []).includes(habit.id)).length;
        achieved += Math.min(habit.targetPerWeek, hits);
      }
    }
    habitConsistencyPercent = expected > 0 ? Math.min(100, Math.round((achieved / expected) * 100)) : 0;
  }

  // Most productive day across the last 7 days (by focus minutes + completed activities)
  let mostProductiveDay: AnalyticsSummary['mostProductiveDay'] = null;
  let bestScore = 0;
  for (let i = 0; i < 7; i++) {
    const d = shiftDateISO(todayISO, -i);
    const dayActs = resolveActivitiesForDate(activities, d).filter((a) => a.status === 'completed');
    const dayFocus = focusSessions
      .filter((s) => s.date === d && s.mode === 'focus')
      .reduce((sum, s) => sum + s.actualMinutes, 0);
    const score = dayFocus + dayActs.length * 30;
    if (score > bestScore) {
      bestScore = score;
      mostProductiveDay = {
        label: format(parseISO(d), 'EEEE, MMM d'),
        score,
        focusHours: Number((dayFocus / 60).toFixed(1)),
      };
    }
  }

  const totalFocusHoursAllTime = Number(
    (
      focusSessions
        .filter((s) => s.mode === 'focus')
        .reduce((sum, s) => sum + s.actualMinutes, 0) / 60
    ).toFixed(1)
  );

  // Weekly completion trend delta vs previous 7 days
  const calcWindowRate = (startOffset: number): number | null => {
    let total = 0;
    let done = 0;
    for (let i = startOffset; i < startOffset + 7; i++) {
      const d = shiftDateISO(todayISO, -i);
      const dayActs = resolveActivitiesForDate(activities, d).filter((a) => a.status !== 'skipped');
      total += dayActs.length;
      done += dayActs.filter((a) => a.status === 'completed').length;
    }
    if (total === 0) return null;
    return Math.round((done / total) * 100);
  };

  const current7Rate = calcWindowRate(0);
  const prev7Rate = calcWindowRate(7);
  const weeklyCompletionTrendDelta =
    current7Rate !== null && prev7Rate !== null ? current7Rate - prev7Rate : null;

  return {
    todayPlannedMinutes,
    todayActualFocusMinutes,
    todayCompletionRate,
    todayCompletedActivities,
    todayTotalActivities,
    totalCompletedTasks,
    totalTasks,
    overallTaskCompletionRate,
    weeklySeries,
    focusByCategory,
    habitConsistencyPercent,
    mostProductiveDay,
    totalFocusHoursAllTime,
    weeklyCompletionTrendDelta,
  };
}
