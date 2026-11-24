import { addDays, format, getDay, parseISO } from 'date-fns';
import {
  ActivityCategory,
  RecurrenceFrequency,
  ResolvedActivity,
  ScheduleActivity,
} from '../types/dayflow';
import type { PdfBreakPeriodItem, PdfWeeklyPlanItem } from '../types/pdfSchedule';
import { CATEGORY_DEFAULT_COLORS } from './colors';
import { generateId, parseTimeToMinutes } from './dateTime';

export function occursOnDate(activity: ScheduleActivity, targetDateISO: string): boolean {
  if (activity.excludedDates?.includes(targetDateISO)) {
    return false;
  }

  const freq = activity.recurrence?.frequency ?? 'none';

  if (freq === 'none') {
    return activity.date === targetDateISO;
  }

  if (targetDateISO < activity.date) {
    return false;
  }

  if (activity.recurrence.endDate && targetDateISO > activity.recurrence.endDate) {
    return false;
  }

  const targetDay = getDay(parseISO(targetDateISO)); // 0 = Sun .. 6 = Sat

  switch (freq) {
    case 'daily':
      return true;
    case 'weekdays':
      return targetDay >= 1 && targetDay <= 5;
    case 'weekends':
      return targetDay === 0 || targetDay === 6;
    case 'custom_weekdays':
      return (activity.recurrence.daysOfWeek ?? []).includes(targetDay);
    case 'weekly': {
      const startDay = getDay(parseISO(activity.date));
      return targetDay === startDay;
    }
    default:
      return activity.date === targetDateISO;
  }
}

export function resolveActivitiesForDate(
  activities: ScheduleActivity[],
  targetDateISO: string
): ResolvedActivity[] {
  const seenIds = new Set<string>();
  const resolved: ResolvedActivity[] = [];
  const [yrStr, moStr] = targetDateISO.split('-');
  const targetYear = Number(yrStr);
  const targetMonth = Number(moStr);

  for (const act of activities) {
    if (seenIds.has(act.id)) continue;
    if (!occursOnDate(act, targetDateISO)) continue;
    seenIds.add(act.id);

    const override = act.occurrenceOverrides?.[targetDateISO];
    const phaseOverride =
      act.monthlyPhaseOverrides?.find(
        (p) => p.year === targetYear && p.month === targetMonth
      ) ?? null;
    const isRecurring = (act.recurrence?.frequency ?? 'none') !== 'none';

    const baseTitleWithPhase = phaseOverride?.title
      ? phaseOverride.title
      : phaseOverride?.focusTopic
      ? `${act.title} — ${phaseOverride.focusTopic}`
      : act.title;

    const baseDescWithPhase = phaseOverride?.description
      ? [act.description, phaseOverride.description].filter(Boolean).join(' · ')
      : act.description;

    resolved.push({
      instanceId: `${act.id}::${targetDateISO}`,
      activityId: act.id,
      occurrenceDate: targetDateISO,
      title: override?.title ?? baseTitleWithPhase,
      description: override?.description ?? baseDescWithPhase,
      startTime: override?.startTime ?? act.startTime,
      endTime: override?.endTime ?? act.endTime,
      category: override?.category ?? act.category,
      color: override?.color ?? act.color,
      priority: override?.priority ?? act.priority,
      status: override?.status ?? (isRecurring ? 'pending' : act.status),
      linkedTaskId: act.linkedTaskId,
      isRecurring,
      recurrence: act.recurrence,
      hasOverride: Boolean(override),
      isOptional: act.isOptional ?? false,
    });
  }

  return resolved.sort((a, b) => {
    const startDiff = parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime);
    if (startDiff !== 0) return startDiff;
    return parseTimeToMinutes(a.endTime) - parseTimeToMinutes(b.endTime);
  });
}

export function resolveActivitiesForRange(
  activities: ScheduleActivity[],
  dates: string[]
): Record<string, ResolvedActivity[]> {
  const map: Record<string, ResolvedActivity[]> = {};
  for (const dateISO of dates) {
    map[dateISO] = resolveActivitiesForDate(activities, dateISO);
  }
  return map;
}

export function describeRecurrence(activity: Pick<ScheduleActivity, 'recurrence' | 'date'>): string {
  const freq = activity.recurrence?.frequency ?? 'none';
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  switch (freq) {
    case 'none':
      return 'One-time';
    case 'daily':
      return 'Every day';
    case 'weekdays':
      return 'Weekdays (Mon–Fri)';
    case 'weekends':
      return 'Weekends (Sat–Sun)';
    case 'weekly': {
      const dayIdx = getDay(parseISO(activity.date));
      return `Weekly on ${dayNames[dayIdx]}`;
    }
    case 'custom_weekdays': {
      const days = [...(activity.recurrence.daysOfWeek ?? [])].sort((a, b) => a - b);
      if (days.length === 0) return 'Custom days';
      if (days.length === 6 && days.join(',') === '1,2,3,4,5,6') {
        return 'Mon–Sat';
      }
      return days.map((d) => dayNames[d]).join(', ');
    }
    default:
      return 'One-time';
  }
}

export function alignDateToFirstMatchingWeekday(
  startDateISO: string,
  targetWeekdays: number[]
): string {
  if (targetWeekdays.length === 0) return startDateISO;
  const start = parseISO(startDateISO);
  for (let offset = 0; offset < 7; offset++) {
    const candidate = addDays(start, offset);
    if (targetWeekdays.includes(getDay(candidate))) {
      return format(candidate, 'yyyy-MM-dd');
    }
  }
  return startDateISO;
}

function chooseFrequencyFromWeekdays(days: number[]): {
  frequency: RecurrenceFrequency;
  daysOfWeek?: number[];
} {
  const sorted = Array.from(new Set(days)).sort((a, b) => a - b);
  if (sorted.length === 7) return { frequency: 'daily' };
  if (sorted.length === 5 && sorted.join(',') === '1,2,3,4,5') {
    return { frequency: 'weekdays' };
  }
  if (sorted.length === 2 && sorted.join(',') === '0,6') {
    return { frequency: 'weekends' };
  }
  if (sorted.length === 1) {
    return { frequency: 'weekly', daysOfWeek: sorted };
  }
  return { frequency: 'custom_weekdays', daysOfWeek: sorted };
}

export interface GroupWeeklyImportOptions {
  selectedWeekdays: number[];
  includeBreaks: boolean;
  oneDayOnly?: boolean;
  startDate: string;
  endDate: string | null;
  sourceFile: string;
  timeZone: string;
}

/**
 * Compresses per-weekday timetable entries into compact recurring ScheduleActivity rules
 * so Mon–Sat identical blocks become 1 recurring rule instead of fragmented duplicates.
 */
export function groupWeeklyPlansIntoScheduleActivities(
  weeklyPlans: PdfWeeklyPlanItem[],
  breakPeriods: PdfBreakPeriodItem[],
  options: GroupWeeklyImportOptions
): ScheduleActivity[] {
  const now = new Date().toISOString();
  const allowedDaySet = new Set(options.selectedWeekdays);

  interface Bucket {
    title: string;
    startTime: string;
    endTime: string;
    category: ActivityCategory;
    priority: ScheduleActivity['priority'];
    isBreak: boolean;
    isOptional: boolean;
    sourcePages: Set<number>;
    days: Set<number>;
    notes: string;
    monthlyOverrides: ScheduleActivity['monthlyPhaseOverrides'];
    startDate: string | null;
    endDate: string | null;
  }

  const buckets = new Map<string, Bucket>();

  for (const item of weeklyPlans) {
    if (!item.included || !allowedDaySet.has(item.weekday)) continue;
    const moSig = item.monthlyOverrides?.length
      ? item.monthlyOverrides.map((m) => `${m.year}-${m.month}:${m.title ?? m.focusTopic ?? ''}`).join('|')
      : '';
    const key = `study::${item.title.trim().toLowerCase()}::${item.startTime}::${item.endTime}::${item.category}::${item.optional ? 'opt' : 'req'}::${moSig}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.days.add(item.weekday);
      existing.sourcePages.add(item.sourcePage);
    } else {
      buckets.set(key, {
        title: item.title.trim(),
        startTime: item.startTime,
        endTime: item.endTime,
        category: item.category,
        priority: item.priority,
        isBreak: false,
        isOptional: Boolean(item.optional),
        sourcePages: new Set([item.sourcePage]),
        days: new Set([item.weekday]),
        notes: item.notes,
        monthlyOverrides:
          item.monthlyOverrides && item.monthlyOverrides.length > 0
            ? item.monthlyOverrides
            : undefined,
        startDate: item.startDate ?? null,
        endDate: item.endDate ?? null,
      });
    }
  }

  if (options.includeBreaks) {
    for (const brk of breakPeriods) {
      const matchingDays =
        brk.weekdays.length > 0
          ? brk.weekdays.filter((d) => allowedDaySet.has(d))
          : options.selectedWeekdays;
      if (matchingDays.length === 0) continue;

      const key = `break::${brk.title.trim().toLowerCase()}::${brk.startTime}::${brk.endTime}`;
      const existing = buckets.get(key);
      if (existing) {
        for (const d of matchingDays) existing.days.add(d);
        existing.sourcePages.add(brk.sourcePage);
      } else {
        buckets.set(key, {
          title: brk.title.trim(),
          startTime: brk.startTime,
          endTime: brk.endTime,
          category: 'Health',
          priority: 'low',
          isBreak: true,
          isOptional: true,
          sourcePages: new Set([brk.sourcePage]),
          days: new Set(matchingDays),
          notes: 'Optional break / unavailable period',
          monthlyOverrides: undefined,
          startDate: null,
          endDate: null,
        });
      }
    }
  }

  const activities: ScheduleActivity[] = [];

  for (const bucket of buckets.values()) {
    const days = Array.from(bucket.days).sort((a, b) => a - b);
    if (days.length === 0) continue;

    const effectiveStart = bucket.startDate || options.startDate;
    const effectiveEnd = bucket.endDate || options.endDate || null;
    const alignedStartDate = alignDateToFirstMatchingWeekday(effectiveStart, days);
    const pagesLabel = Array.from(bucket.sourcePages)
      .sort((a, b) => a - b)
      .join(', ');
    const recurrence = options.oneDayOnly
      ? { frequency: 'none' as const, endDate: null }
      : {
          ...chooseFrequencyFromWeekdays(days),
          endDate: effectiveEnd,
        };

    const metaDesc = [
      bucket.isBreak ? '[Break / Unavailable]' : bucket.isOptional ? '[Optional]' : null,
      `Source: ${options.sourceFile} (p. ${pagesLabel})`,
      bucket.notes || null,
      `TZ: ${options.timeZone}`,
    ]
      .filter(Boolean)
      .join(' · ');

    activities.push({
      id: generateId(),
      title: bucket.title,
      description: metaDesc,
      date: alignedStartDate,
      startTime: bucket.startTime,
      endTime: bucket.endTime,
      category: bucket.category,
      color: bucket.isBreak ? 'slate' : CATEGORY_DEFAULT_COLORS[bucket.category] ?? 'sky',
      priority: bucket.priority,
      status: 'pending',
      linkedTaskId: null,
      recurrence,
      excludedDates: [],
      occurrenceOverrides: {},
      ...(bucket.monthlyOverrides ? { monthlyPhaseOverrides: bucket.monthlyOverrides } : {}),
      ...(bucket.isOptional ? { isOptional: true } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }

  return activities.sort((a, b) => parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime));
}

export interface RecurringConflictSummary {
  date: string;
  weekday: number;
  incomingTitle: string;
  existingTitle: string;
  overlapMinutes: number;
}

export function detectRecurringScheduleConflicts(
  incomingRules: ScheduleActivity[],
  existingActivities: ScheduleActivity[],
  startDateISO: string
): RecurringConflictSummary[] {
  const conflicts: RecurringConflictSummary[] = [];
  const start = parseISO(startDateISO);

  for (let offset = 0; offset < 7; offset++) {
    const dateISO = format(addDays(start, offset), 'yyyy-MM-dd');
    const weekday = getDay(parseISO(dateISO));
    const existingForDay = resolveActivitiesForDate(existingActivities, dateISO).filter(
      (a) => a.status !== 'skipped'
    );
    const incomingForDay = resolveActivitiesForDate(incomingRules, dateISO);

    for (const inc of incomingForDay) {
      const iStart = parseTimeToMinutes(inc.startTime);
      const iEnd = parseTimeToMinutes(inc.endTime);

      for (const ex of existingForDay) {
        const eStart = parseTimeToMinutes(ex.startTime);
        const eEnd = parseTimeToMinutes(ex.endTime);
        const overlap = Math.min(iEnd, eEnd) - Math.max(iStart, eStart);
        if (overlap > 0) {
          conflicts.push({
            date: dateISO,
            weekday,
            incomingTitle: inc.title,
            existingTitle: ex.title,
            overlapMinutes: overlap,
          });
        }
      }
    }
  }

  return conflicts;
}
