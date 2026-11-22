import {
  ActivityConflict,
  BreakSuggestion,
  DayLoadAnalysis,
  ResolvedActivity,
  ScheduleActivity,
  TaskItem,
  TimeSlotSuggestion,
} from '../types/dayflow';
import {
  getActivityDurationMinutes,
  getTodayISO,
  minutesToTime24,
  parseTimeToMinutes,
  shiftDateISO,
} from './dateTime';
import { resolveActivitiesForDate } from './recurrence';

export interface PositionedActivity {
  activity: ResolvedActivity;
  colIndex: number;
  totalCols: number;
  hasConflict: boolean;
}

export function detectConflicts(activities: ResolvedActivity[]): ActivityConflict[] {
  const active = activities.filter((a) => a.status !== 'skipped');
  const conflicts: ActivityConflict[] = [];

  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    const aStart = parseTimeToMinutes(a.startTime);
    const aEnd = parseTimeToMinutes(a.endTime);

    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      const bStart = parseTimeToMinutes(b.startTime);
      const bEnd = parseTimeToMinutes(b.endTime);

      const overlapStart = Math.max(aStart, bStart);
      const overlapEnd = Math.min(aEnd, bEnd);
      if (overlapEnd > overlapStart) {
        conflicts.push({
          first: a,
          second: b,
          overlapMinutes: overlapEnd - overlapStart,
        });
      }
    }
  }

  return conflicts;
}

export function computeTimelineLayout(activities: ResolvedActivity[]): PositionedActivity[] {
  if (activities.length === 0) return [];

  const sorted = [...activities].sort((a, b) => {
    const diff = parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime);
    if (diff !== 0) return diff;
    return parseTimeToMinutes(b.endTime) - parseTimeToMinutes(a.endTime);
  });

  const conflictSet = new Set<string>();
  const conflicts = detectConflicts(sorted);
  for (const c of conflicts) {
    conflictSet.add(c.first.instanceId);
    conflictSet.add(c.second.instanceId);
  }

  // Group overlapping clusters
  const clusters: ResolvedActivity[][] = [];
  let currentCluster: ResolvedActivity[] = [];
  let clusterEnd = -1;

  for (const act of sorted) {
    const start = parseTimeToMinutes(act.startTime);
    const end = parseTimeToMinutes(act.endTime);
    if (currentCluster.length === 0 || start < clusterEnd) {
      currentCluster.push(act);
      clusterEnd = Math.max(clusterEnd, end);
    } else {
      clusters.push(currentCluster);
      currentCluster = [act];
      clusterEnd = end;
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const positioned: PositionedActivity[] = [];

  for (const cluster of clusters) {
    const columnsEnd: number[] = [];
    const colAssignments: { activity: ResolvedActivity; colIndex: number }[] = [];

    for (const act of cluster) {
      const start = parseTimeToMinutes(act.startTime);
      const end = parseTimeToMinutes(act.endTime);

      let placedCol = -1;
      for (let c = 0; c < columnsEnd.length; c++) {
        if (columnsEnd[c] <= start) {
          placedCol = c;
          columnsEnd[c] = end;
          break;
        }
      }
      if (placedCol === -1) {
        placedCol = columnsEnd.length;
        columnsEnd.push(end);
      }
      colAssignments.push({ activity: act, colIndex: placedCol });
    }

    const totalCols = Math.max(1, columnsEnd.length);
    for (const item of colAssignments) {
      positioned.push({
        activity: item.activity,
        colIndex: item.colIndex,
        totalCols,
        hasConflict: conflictSet.has(item.activity.instanceId),
      });
    }
  }

  return positioned;
}

export function findAvailableSlots(
  activities: ResolvedActivity[],
  dateISO: string,
  minDurationMinutes = 30,
  dayStartHour = 6,
  dayEndHour = 23
): TimeSlotSuggestion[] {
  const windowStart = dayStartHour * 60;
  const windowEnd = dayEndHour * 60;

  const busy = activities
    .filter((a) => a.status !== 'skipped')
    .map((a) => ({
      start: Math.max(windowStart, parseTimeToMinutes(a.startTime)),
      end: Math.min(windowEnd, parseTimeToMinutes(a.endTime)),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);

  // Merge overlapping busy intervals
  const merged: { start: number; end: number }[] = [];
  for (const interval of busy) {
    if (merged.length === 0 || interval.start > merged[merged.length - 1].end) {
      merged.push({ ...interval });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end);
    }
  }

  const slots: TimeSlotSuggestion[] = [];
  let cursor = windowStart;

  for (const block of merged) {
    if (block.start - cursor >= minDurationMinutes) {
      slots.push({
        date: dateISO,
        startTime: minutesToTime24(cursor),
        endTime: minutesToTime24(block.start),
        durationMinutes: block.start - cursor,
      });
    }
    cursor = Math.max(cursor, block.end);
  }

  if (windowEnd - cursor >= minDurationMinutes) {
    slots.push({
      date: dateISO,
      startTime: minutesToTime24(cursor),
      endTime: minutesToTime24(windowEnd),
      durationMinutes: windowEnd - cursor,
    });
  }

  return slots;
}

export function detectBreakSuggestions(activities: ResolvedActivity[]): BreakSuggestion[] {
  const workFocusCategories = new Set(['Work', 'Study', 'Deep Focus', 'Admin']);
  const eligible = activities
    .filter((a) => a.status !== 'skipped' && workFocusCategories.has(a.category))
    .sort((a, b) => parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime));

  const suggestions: BreakSuggestion[] = [];

  for (let i = 0; i < eligible.length - 1; i++) {
    const current = eligible[i];
    const next = eligible[i + 1];
    const curStart = parseTimeToMinutes(current.startTime);
    const curEnd = parseTimeToMinutes(current.endTime);
    const nextStart = parseTimeToMinutes(next.startTime);
    const nextEnd = parseTimeToMinutes(next.endTime);

    const gap = nextStart - curEnd;
    const combinedWork = curEnd - curStart + (nextEnd - nextStart);

    if (gap >= 0 && gap < 10 && combinedWork >= 120) {
      suggestions.push({
        afterActivity: current,
        beforeActivity: next,
        contiguousMinutes: combinedWork,
        suggestedBreakStart: current.endTime,
        suggestedBreakEnd: minutesToTime24(curEnd + 15),
      });
    }
  }

  return suggestions;
}

export function analyzeDayLoad(
  activities: ResolvedActivity[],
  dateISO: string,
  dailyCapacityHours: number
): DayLoadAnalysis {
  const active = activities.filter((a) => a.status !== 'skipped');
  const plannedMinutes = active.reduce(
    (sum, a) => sum + getActivityDurationMinutes(a.startTime, a.endTime),
    0
  );
  const capacityMinutes = Math.max(60, dailyCapacityHours * 60);

  return {
    date: dateISO,
    plannedMinutes,
    isOverloaded: plannedMinutes > capacityMinutes,
    capacityMinutes,
    conflicts: detectConflicts(active),
    breakSuggestions: detectBreakSuggestions(active),
  };
}

export interface UnfinishedItemsSummary {
  overdueTasks: TaskItem[];
  unfinishedPastActivities: ResolvedActivity[];
}

export function findUnfinishedItems(
  allActivities: ScheduleActivity[],
  tasks: TaskItem[],
  referenceDateISO = getTodayISO()
): UnfinishedItemsSummary {
  const overdueTasks = tasks.filter(
    (t) => !t.completed && t.dueDate !== null && t.dueDate < referenceDateISO
  );

  // Look back up to 7 days for pending activities that were not completed or skipped
  const unfinishedPastActivities: ResolvedActivity[] = [];
  for (let offset = 1; offset <= 7; offset++) {
    const pastDate = shiftDateISO(referenceDateISO, -offset);
    const dayActs = resolveActivitiesForDate(allActivities, pastDate);
    for (const act of dayActs) {
      if (act.status === 'pending') {
        unfinishedPastActivities.push(act);
      }
    }
  }

  return {
    overdueTasks,
    unfinishedPastActivities,
  };
}

export interface TaskDistributionProposal {
  task: TaskItem;
  date: string;
  startTime: string;
  endTime: string;
}

export function proposeTaskDistribution(
  unscheduledTasks: TaskItem[],
  allActivities: ScheduleActivity[],
  startDateISO: string,
  daysToScan = 3
): TaskDistributionProposal[] {
  const proposals: TaskDistributionProposal[] = [];
  const priorityRank: Record<TaskItem['priority'], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };

  const orderedTasks = [...unscheduledTasks]
    .filter((t) => !t.completed)
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);

  // Build mutable slot pool across upcoming days
  const dailySlots: Record<string, { start: number; end: number }[]> = {};
  for (let d = 0; d < daysToScan; d++) {
    const dateISO = shiftDateISO(startDateISO, d);
    const existing = resolveActivitiesForDate(allActivities, dateISO);
    dailySlots[dateISO] = findAvailableSlots(existing, dateISO, 20, 8, 21).map((s) => ({
      start: parseTimeToMinutes(s.startTime),
      end: parseTimeToMinutes(s.endTime),
    }));
  }

  for (const task of orderedTasks) {
    const needed = Math.max(15, Math.min(180, task.estimatedMinutes || 45));
    let assigned = false;

    for (let d = 0; d < daysToScan && !assigned; d++) {
      const dateISO = shiftDateISO(startDateISO, d);
      const slots = dailySlots[dateISO];
      for (const slot of slots) {
        if (slot.end - slot.start >= needed) {
          proposals.push({
            task,
            date: dateISO,
            startTime: minutesToTime24(slot.start),
            endTime: minutesToTime24(slot.start + needed),
          });
          // Reserve 15m buffer after placing task
          slot.start = slot.start + needed + 15;
          assigned = true;
          break;
        }
      }
    }
  }

  return proposals;
}
