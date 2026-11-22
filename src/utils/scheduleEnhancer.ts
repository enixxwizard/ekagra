import { format, isValid, parseISO } from 'date-fns';
import type { ScheduleActivity, TaskItem } from '../types/dayflow';
import type {
  DeterministicDaySummary,
  DeterministicDeadlineFinding,
  DeterministicOverlapFinding,
  DeterministicScheduleReport,
  EnhancerActivitySnapshot,
  EnhancerTaskSnapshot,
  ScheduleEnhancementChange,
  ScheduleEnhancementRequestBody,
  ScheduleEnhancementSuggestion,
} from '../types/scheduleEnhancer';
import {
  getActivityDurationMinutes,
  minutesToTime24,
  parseTimeToMinutes,
  shiftDateISO,
} from './dateTime';
import { occursOnDate, resolveActivitiesForDate } from './recurrence';
import { detectBreakSuggestions, detectConflicts, findAvailableSlots } from './scheduler';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_24_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const BREAK_TITLE_RE = /\b(break|lunch|recess|rest|breather|tea|coffee|nap)\b/i;

export function logEnhancerDiagnostic(
  stage:
    | 'button_clicked'
    | 'schedule_loaded'
    | 'deterministic_completed'
    | 'gemini_request_started'
    | 'gemini_response_received'
    | 'suggestions_validated'
    | 'error_encountered',
  meta?: Record<string, string | number | boolean | null | undefined>
): void {
  const nodeEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
    ?.NODE_ENV;
  const isDev =
    (typeof import.meta !== 'undefined' &&
      Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)) ||
    (nodeEnv !== undefined && nodeEnv !== 'production');
  if (!isDev) return;

  if (meta) {
    console.info(`[DayFlow Enhancer] ${stage}`, meta);
  } else {
    console.info(`[DayFlow Enhancer] ${stage}`);
  }
}

export function isValidIsoDate(val: unknown): val is string {
  if (typeof val !== 'string' || !ISO_DATE_RE.test(val)) return false;
  const parsed = parseISO(val);
  return isValid(parsed) && format(parsed, 'yyyy-MM-dd') === val;
}

export function isValidTime24(val: unknown): val is string {
  return typeof val === 'string' && TIME_24_RE.test(val);
}

export function toStrictMinutes(time24: string): number | null {
  if (!isValidTime24(time24)) return null;
  const [h, m] = time24.split(':').map(Number);
  return h * 60 + m;
}

export function isBreakLikeTitle(title: string): boolean {
  return BREAK_TITLE_RE.test(title);
}

export function sanitizeActivitiesForEnhancer(
  activities: ScheduleActivity[] | EnhancerActivitySnapshot[]
): { valid: ScheduleActivity[]; invalidCount: number } {
  const valid: ScheduleActivity[] = [];
  let invalidCount = 0;

  for (const act of activities) {
    if (!act || typeof act.id !== 'string' || !act.id.trim() || typeof act.title !== 'string') {
      invalidCount += 1;
      continue;
    }
    if (!isValidIsoDate(act.date) || !isValidTime24(act.startTime) || !isValidTime24(act.endTime)) {
      invalidCount += 1;
      continue;
    }
    const startMin = parseTimeToMinutes(act.startTime);
    const endMin = parseTimeToMinutes(act.endTime);
    if (endMin <= startMin) {
      invalidCount += 1;
      continue;
    }

    valid.push({
      id: act.id,
      title: act.title.trim().slice(0, 120) || 'Untitled block',
      description: '',
      date: act.date,
      startTime: act.startTime,
      endTime: act.endTime,
      category: act.category,
      color: 'indigo',
      priority: act.priority,
      status: act.status,
      linkedTaskId: act.linkedTaskId ?? null,
      recurrence: act.recurrence ?? { frequency: 'none', endDate: null },
      excludedDates: Array.isArray(act.excludedDates) ? act.excludedDates.filter(isValidIsoDate) : [],
      occurrenceOverrides: act.occurrenceOverrides ?? {},
      createdAt: '',
      updatedAt: '',
    });
  }

  return { valid, invalidCount };
}

export function buildEnhancerRequestPayload(params: {
  activities: ScheduleActivity[];
  tasks: TaskItem[];
  todayISO: string;
  nowMinutes: number;
  timeZone: string;
  dailyCapacityHours: number;
}): ScheduleEnhancementRequestBody {
  // Strip private notes, descriptions, quotations, and auth fields
  const activities: EnhancerActivitySnapshot[] = params.activities.map((a) => ({
    id: a.id,
    title: a.title.trim().slice(0, 120),
    date: a.date,
    startTime: a.startTime,
    endTime: a.endTime,
    category: a.category,
    priority: a.priority,
    status: a.status,
    linkedTaskId: a.linkedTaskId,
    recurrence: a.recurrence,
    excludedDates: a.excludedDates ?? [],
    occurrenceOverrides: a.occurrenceOverrides
      ? Object.fromEntries(
          Object.entries(a.occurrenceOverrides).map(([d, ov]) => [
            d,
            {
              title: ov.title,
              startTime: ov.startTime,
              endTime: ov.endTime,
              category: ov.category,
              priority: ov.priority,
              status: ov.status,
            },
          ])
        )
      : {},
  }));

  const tasks: EnhancerTaskSnapshot[] = params.tasks.map((t) => ({
    id: t.id,
    title: t.title.trim().slice(0, 120),
    priority: t.priority,
    dueDate: t.dueDate && isValidIsoDate(t.dueDate) ? t.dueDate : null,
    category: t.category,
    completed: Boolean(t.completed),
    estimatedMinutes:
      typeof t.estimatedMinutes === 'number' && t.estimatedMinutes > 0
        ? Math.min(480, Math.round(t.estimatedMinutes))
        : 30,
    scheduledActivityId: t.scheduledActivityId ?? null,
  }));

  return {
    todayISO: params.todayISO,
    nowMinutes: Math.max(0, Math.min(1439, Math.round(params.nowMinutes))),
    timeZone: params.timeZone || 'Local Time',
    dailyCapacityHours: Math.max(2, Math.min(16, params.dailyCapacityHours || 8)),
    activities,
    tasks,
  };
}

export function runDeterministicScheduleAnalysis(params: {
  activities: ScheduleActivity[] | EnhancerActivitySnapshot[];
  tasks: TaskItem[] | EnhancerTaskSnapshot[];
  todayISO: string;
  nowMinutes: number;
  timeZone: string;
  dailyCapacityHours: number;
  horizonDays?: number;
}): DeterministicScheduleReport {
  const horizonDays = Math.max(1, Math.min(14, params.horizonDays ?? 7));
  const todayISO = isValidIsoDate(params.todayISO)
    ? params.todayISO
    : format(new Date(), 'yyyy-MM-dd');
  const horizonEndISO = shiftDateISO(todayISO, horizonDays - 1);
  const nowMinutes = Math.max(0, Math.min(1439, Math.round(params.nowMinutes)));
  const capacityMinutes = Math.max(60, Math.round((params.dailyCapacityHours || 8) * 60));

  const { valid: validActivities, invalidCount } = sanitizeActivitiesForEnhancer(params.activities);

  const days: DeterministicDaySummary[] = [];
  const overlaps: DeterministicOverlapFinding[] = [];
  let validOccurrencesCount = 0;
  let overloadedDaysCount = 0;
  let flexibleBlocksCount = 0;
  let fixedBlocksCount = 0;

  for (let offset = 0; offset < horizonDays; offset++) {
    const dateISO = shiftDateISO(todayISO, offset);
    const weekday = format(parseISO(dateISO), 'EEEE');
    const resolved = resolveActivitiesForDate(validActivities, dateISO).filter(
      (a) => a.status !== 'skipped'
    );

    validOccurrencesCount += resolved.length;

    const plannedMinutes = resolved.reduce(
      (sum, a) => sum + getActivityDurationMinutes(a.startTime, a.endTime),
      0
    );
    const isOverloaded = plannedMinutes > capacityMinutes;
    if (isOverloaded) overloadedDaysCount += 1;

    const dayConflicts = detectConflicts(resolved);
    for (const c of dayConflicts) {
      overlaps.push({
        date: dateISO,
        firstActivityId: c.first.activityId,
        firstTitle: c.first.title,
        firstTime: `${c.first.startTime}-${c.first.endTime}`,
        secondActivityId: c.second.activityId,
        secondTitle: c.second.title,
        secondTime: `${c.second.startTime}-${c.second.endTime}`,
        overlapMinutes: c.overlapMinutes,
      });
    }

    const rawSlots = findAvailableSlots(resolved, dateISO, 20, 6, 23);
    const openSlots = rawSlots
      .map((slot) => {
        if (dateISO !== todayISO) return slot;
        const slotStart = parseTimeToMinutes(slot.startTime);
        const slotEnd = parseTimeToMinutes(slot.endTime);
        const minStart = Math.ceil((nowMinutes + 10) / 5) * 5;
        const clampedStart = Math.max(slotStart, minStart);
        if (slotEnd - clampedStart < 20) return null;
        return {
          startTime: minutesToTime24(clampedStart),
          endTime: slot.endTime,
          durationMinutes: slotEnd - clampedStart,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    const freeMinutesAfterNow = openSlots.reduce((sum, s) => sum + s.durationMinutes, 0);
    const breakGaps = detectBreakSuggestions(resolved).map((b) => ({
      afterActivityId: b.afterActivity.activityId,
      afterTitle: b.afterActivity.title,
      beforeTitle: b.beforeActivity.title,
      contiguousMinutes: b.contiguousMinutes,
      suggestedBreakStart: b.suggestedBreakStart,
      suggestedBreakEnd: b.suggestedBreakEnd,
    }));

    const blocks = resolved.map((a) => {
      const startMin = parseTimeToMinutes(a.startTime);
      const endMin = parseTimeToMinutes(a.endTime);
      const isPastOrOngoingToday = dateISO === todayISO && startMin < nowMinutes;
      const isBreak = isBreakLikeTitle(a.title);
      const isFixed =
        a.status === 'completed' ||
        a.priority === 'high' ||
        a.isRecurring ||
        isPastOrOngoingToday;

      if (isFixed) {
        fixedBlocksCount += 1;
      } else {
        flexibleBlocksCount += 1;
      }

      return {
        activityId: a.activityId,
        title: a.title,
        startTime: a.startTime,
        endTime: a.endTime,
        durationMinutes: Math.max(0, endMin - startMin),
        category: a.category,
        priority: a.priority,
        isRecurring: a.isRecurring,
        commitmentType: isFixed ? ('fixed' as const) : ('flexible' as const),
        isBreak,
      };
    });

    days.push({
      date: dateISO,
      weekday,
      plannedMinutes,
      capacityMinutes,
      isOverloaded,
      overloadMinutes: Math.max(0, plannedMinutes - capacityMinutes),
      freeMinutesAfterNow,
      openSlots,
      blocks,
      contiguousWorkRuns: breakGaps,
    });
  }

  // Deadline & unscheduled task conflicts
  const deadlineFindings: DeterministicDeadlineFinding[] = [];
  const activityById = new Map(validActivities.map((a) => [a.id, a]));

  for (const task of params.tasks) {
    if (task.completed) continue;

    if (task.dueDate && isValidIsoDate(task.dueDate)) {
      if (task.dueDate < todayISO) {
        deadlineFindings.push({
          taskId: task.id,
          title: task.title,
          dueDate: task.dueDate,
          priority: task.priority,
          estimatedMinutes: task.estimatedMinutes || 30,
          issue: 'overdue',
          detail: `Due ${task.dueDate} (already overdue relative to ${todayISO}).`,
        });
        continue;
      }

      if (task.scheduledActivityId) {
        const linked = activityById.get(task.scheduledActivityId);
        if (linked && linked.recurrence.frequency === 'none' && linked.date > task.dueDate) {
          deadlineFindings.push({
            taskId: task.id,
            title: task.title,
            dueDate: task.dueDate,
            priority: task.priority,
            estimatedMinutes: task.estimatedMinutes || 30,
            issue: 'scheduled_after_due',
            detail: `Scheduled on ${linked.date}, which is after due date ${task.dueDate}.`,
          });
          continue;
        }
      }

      if (task.dueDate <= horizonEndISO && !task.scheduledActivityId) {
        const availableUntilDue = days
          .filter((d) => d.date <= task.dueDate!)
          .reduce((sum, d) => sum + d.freeMinutesAfterNow, 0);
        const needed = task.estimatedMinutes || 30;
        const issue =
          availableUntilDue < needed ? 'insufficient_time' : 'unscheduled_due_soon';

        deadlineFindings.push({
          taskId: task.id,
          title: task.title,
          dueDate: task.dueDate,
          priority: task.priority,
          estimatedMinutes: needed,
          issue,
          detail:
            issue === 'insufficient_time'
              ? `Needs ${needed}m by ${task.dueDate}, but only ${availableUntilDue}m free remains.`
              : `Due ${task.dueDate} (${needed}m estimated) and not yet placed on timeline.`,
        });
      }
    }
  }

  // Also check if total unscheduled high-priority tasks due by today/tomorrow exceed remaining free slots
  const totalBreakGaps = days.reduce((sum, d) => sum + d.contiguousWorkRuns.length, 0);
  const hasActionableFindings =
    overlaps.length > 0 ||
    overloadedDaysCount > 0 ||
    deadlineFindings.length > 0 ||
    totalBreakGaps > 0 ||
    (flexibleBlocksCount > 0 && days.some((d) => d.plannedMinutes > d.capacityMinutes * 0.85));

  return {
    todayISO,
    horizonEndISO,
    nowMinutes,
    timeZone: params.timeZone || 'Local Time',
    dailyCapacityHours: params.dailyCapacityHours || 8,
    totalSourceActivities: params.activities.length,
    validOccurrencesCount,
    invalidActivitiesCount: invalidCount,
    days,
    overlaps,
    overloadedDaysCount,
    deadlineFindings,
    flexibleBlocksCount,
    fixedBlocksCount,
    hasActionableFindings,
  };
}

export interface ChangeValidationResult {
  valid: boolean;
  error?: string;
}

function getEffectiveIntervalsForDate(
  activities: ScheduleActivity[],
  dateISO: string,
  ignoreActivityIds: Set<string>,
  additionalIntervals: Array<{ date: string; startMin: number; endMin: number }>
): Array<{ activityId: string; title: string; startMin: number; endMin: number }> {
  const resolved = resolveActivitiesForDate(activities, dateISO).filter(
    (a) => a.status !== 'skipped' && !ignoreActivityIds.has(a.activityId)
  );

  const list = resolved.map((a) => ({
    activityId: a.activityId,
    title: a.title,
    startMin: parseTimeToMinutes(a.startTime),
    endMin: parseTimeToMinutes(a.endTime),
  }));

  for (const extra of additionalIntervals) {
    if (extra.date === dateISO) {
      list.push({
        activityId: 'pending-change',
        title: 'proposed block',
        startMin: extra.startMin,
        endMin: extra.endMin,
      });
    }
  }

  return list;
}

export function validateSingleChangeCandidate(
  change: ScheduleEnhancementChange,
  context: {
    activities: ScheduleActivity[];
    tasks: TaskItem[];
    todayISO: string;
    nowMinutes: number;
    siblingChanges?: ScheduleEnhancementChange[];
  }
): ChangeValidationResult {
  const maxDateISO = shiftDateISO(context.todayISO, 30);
  const activityMap = new Map(context.activities.map((a) => [a.id, a]));
  const taskMap = new Map(context.tasks.map((t) => [t.id, t]));

  const ignoreIds = new Set<string>();
  const siblingIntervals: Array<{ date: string; startMin: number; endMin: number }> = [];

  for (const sib of context.siblingChanges ?? []) {
    if (sib === change) continue;
    if (sib.type === 'reschedule_activity') {
      ignoreIds.add(sib.activityId);
      const sStart = toStrictMinutes(sib.newStartTime);
      const sEnd = toStrictMinutes(sib.newEndTime);
      if (sStart !== null && sEnd !== null) {
        siblingIntervals.push({ date: sib.newDate, startMin: sStart, endMin: sEnd });
      }
    } else if (sib.type === 'schedule_task' || sib.type === 'insert_break') {
      const sStart = toStrictMinutes(sib.startTime);
      const sEnd = toStrictMinutes(sib.endTime);
      if (sStart !== null && sEnd !== null) {
        siblingIntervals.push({ date: sib.date, startMin: sStart, endMin: sEnd });
      }
    }
  }

  if (change.type === 'reschedule_activity') {
    const act = activityMap.get(change.activityId);
    if (!act) {
      return { valid: false, error: `Activity "${change.activityTitle || change.activityId}" no longer exists.` };
    }
    if (!isValidIsoDate(change.occurrenceDate) || !occursOnDate(act, change.occurrenceDate)) {
      return {
        valid: false,
        error: `Activity "${act.title}" does not occur on ${change.occurrenceDate}.`,
      };
    }
    if (!isValidIsoDate(change.newDate)) {
      return { valid: false, error: 'Target date must be a valid YYYY-MM-DD date.' };
    }
    if (change.newDate < context.todayISO || change.newDate > maxDateISO) {
      return {
        valid: false,
        error: `Target date ${change.newDate} must be between today (${context.todayISO}) and ${maxDateISO}.`,
      };
    }
    const startMin = toStrictMinutes(change.newStartTime);
    const endMin = toStrictMinutes(change.newEndTime);
    if (startMin === null || endMin === null || endMin <= startMin) {
      return { valid: false, error: 'End time must be after start time (HH:mm).' };
    }
    if (endMin - startMin < 10) {
      return { valid: false, error: 'Activity duration must be at least 10 minutes.' };
    }

    const resolvedCurrent = resolveActivitiesForDate([act], change.occurrenceDate)[0];
    const origStart = resolvedCurrent?.startTime ?? act.startTime;
    const origEnd = resolvedCurrent?.endTime ?? act.endTime;

    if (
      change.newDate === change.occurrenceDate &&
      change.newStartTime === origStart &&
      change.newEndTime === origEnd
    ) {
      return { valid: false, error: 'New date and time match the existing block.' };
    }

    if (change.newDate === context.todayISO && startMin < context.nowMinutes) {
      // Allow trimming end time only if startTime is unchanged and endMin > nowMinutes
      const keepingSameStart =
        change.newDate === change.occurrenceDate &&
        change.newStartTime === origStart &&
        endMin > context.nowMinutes;
      if (!keepingSameStart) {
        return {
          valid: false,
          error: 'Cannot reschedule into a time that has already passed today.',
        };
      }
    }

    ignoreIds.add(act.id);
    const others = getEffectiveIntervalsForDate(
      context.activities,
      change.newDate,
      ignoreIds,
      siblingIntervals
    );

    const conflict = others.find((o) => startMin < o.endMin && endMin > o.startMin);
    if (conflict) {
      return {
        valid: false,
        error: `Overlaps with "${conflict.title}" (${minutesToTime24(conflict.startMin)}–${minutesToTime24(conflict.endMin)}).`,
      };
    }

    return { valid: true };
  }

  if (change.type === 'schedule_task') {
    const task = taskMap.get(change.taskId);
    if (!task) {
      return { valid: false, error: `Task "${change.taskTitle || change.taskId}" no longer exists.` };
    }
    if (task.completed) {
      return { valid: false, error: `Task "${task.title}" is already completed.` };
    }
    if (!isValidIsoDate(change.date) || change.date < context.todayISO || change.date > maxDateISO) {
      return { valid: false, error: `Date ${change.date} is outside the valid planning window.` };
    }
    const startMin = toStrictMinutes(change.startTime);
    const endMin = toStrictMinutes(change.endTime);
    if (startMin === null || endMin === null || endMin <= startMin) {
      return { valid: false, error: 'End time must be after start time.' };
    }
    if (change.date === context.todayISO && startMin < context.nowMinutes) {
      return { valid: false, error: 'Cannot schedule a task in a past time slot today.' };
    }

    const others = getEffectiveIntervalsForDate(
      context.activities,
      change.date,
      ignoreIds,
      siblingIntervals
    );
    const conflict = others.find((o) => startMin < o.endMin && endMin > o.startMin);
    if (conflict) {
      return {
        valid: false,
        error: `Overlaps with "${conflict.title}" (${minutesToTime24(conflict.startMin)}–${minutesToTime24(conflict.endMin)}).`,
      };
    }
    return { valid: true };
  }

  // insert_break
  if (!change.title.trim()) {
    return { valid: false, error: 'Break title cannot be empty.' };
  }
  if (!isValidIsoDate(change.date) || change.date < context.todayISO || change.date > maxDateISO) {
    return { valid: false, error: `Break date ${change.date} is outside the valid window.` };
  }
  const startMin = toStrictMinutes(change.startTime);
  const endMin = toStrictMinutes(change.endTime);
  if (startMin === null || endMin === null || endMin <= startMin) {
    return { valid: false, error: 'Break end time must be after start time.' };
  }
  if (endMin - startMin < 5 || endMin - startMin > 60) {
    return { valid: false, error: 'Break duration must be between 5 and 60 minutes.' };
  }
  if (change.date === context.todayISO && startMin < context.nowMinutes) {
    return { valid: false, error: 'Cannot insert a break into a past time slot today.' };
  }

  const others = getEffectiveIntervalsForDate(
    context.activities,
    change.date,
    ignoreIds,
    siblingIntervals
  );
  const conflict = others.find((o) => startMin < o.endMin && endMin > o.startMin);
  if (conflict) {
    return {
      valid: false,
      error: `Overlaps with "${conflict.title}" (${minutesToTime24(conflict.startMin)}–${minutesToTime24(conflict.endMin)}).`,
    };
  }

  return { valid: true };
}

export function validateEnhancementSuggestions(
  rawSuggestions: unknown,
  context: {
    activities: ScheduleActivity[] | EnhancerActivitySnapshot[];
    tasks: TaskItem[] | EnhancerTaskSnapshot[];
    todayISO: string;
    nowMinutes: number;
  }
): {
  validSuggestions: ScheduleEnhancementSuggestion[];
  rejectedReasons: string[];
} {
  if (!Array.isArray(rawSuggestions)) {
    return { validSuggestions: [], rejectedReasons: ['Model response suggestions was not an array.'] };
  }

  const { valid: sanitizedActivities } = sanitizeActivitiesForEnhancer(context.activities);
  const sanitizedTasks: TaskItem[] = context.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: '',
    priority: t.priority,
    dueDate: t.dueDate,
    category: t.category,
    completed: t.completed,
    completedAt: null,
    estimatedMinutes: t.estimatedMinutes,
    scheduledActivityId: t.scheduledActivityId,
    createdAt: '',
    updatedAt: '',
  }));

  const activityMap = new Map(sanitizedActivities.map((a) => [a.id, a]));
  const taskMap = new Map(sanitizedTasks.map((t) => [t.id, t]));

  const validSuggestions: ScheduleEnhancementSuggestion[] = [];
  const rejectedReasons: string[] = [];

  for (let idx = 0; idx < rawSuggestions.length; idx++) {
    if (validSuggestions.length >= 3) break;
    const raw = rawSuggestions[idx];
    if (!raw || typeof raw !== 'object') {
      rejectedReasons.push(`Suggestion ${idx + 1}: not an object.`);
      continue;
    }

    const obj = raw as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    const evidence = typeof obj.evidence === 'string' ? obj.evidence.trim() : '';
    const beforePreview = typeof obj.beforePreview === 'string' ? obj.beforePreview.trim() : '';
    const afterPreview = typeof obj.afterPreview === 'string' ? obj.afterPreview.trim() : '';
    const tradeOffs = typeof obj.tradeOffs === 'string' ? obj.tradeOffs.trim() : '';

    if (!title || !reason || !evidence || !beforePreview || !afterPreview || !tradeOffs) {
      rejectedReasons.push(`Suggestion ${idx + 1}: missing required descriptive fields.`);
      continue;
    }

    if (!Array.isArray(obj.changes) || obj.changes.length === 0) {
      rejectedReasons.push(`Suggestion "${title}": missing proposed changes.`);
      continue;
    }

    const normalizedChanges: ScheduleEnhancementChange[] = [];
    let changeInvalidReason: string | null = null;

    for (const rawCh of obj.changes.slice(0, 3)) {
      if (!rawCh || typeof rawCh !== 'object') {
        changeInvalidReason = 'Invalid change object.';
        break;
      }
      const ch = rawCh as Record<string, unknown>;
      const type = ch.type;

      if (type === 'reschedule_activity') {
        const activityId = typeof ch.activityId === 'string' ? ch.activityId.trim() : '';
        const act = activityMap.get(activityId);
        if (!act) {
          changeInvalidReason = `Nonexistent activityId "${activityId}".`;
          break;
        }
        const occurrenceDate =
          typeof ch.occurrenceDate === 'string' ? ch.occurrenceDate.trim() : '';
        const newDate = typeof ch.newDate === 'string' ? ch.newDate.trim() : '';
        const newStartTime = typeof ch.newStartTime === 'string' ? ch.newStartTime.trim() : '';
        const newEndTime = typeof ch.newEndTime === 'string' ? ch.newEndTime.trim() : '';
        const requestedScope = ch.scope === 'series' ? 'series' : 'single';
        const isRecurring = (act.recurrence?.frequency ?? 'none') !== 'none';
        const effectiveScope: 'single' | 'series' =
          isRecurring && requestedScope === 'series' && newDate === occurrenceDate
            ? 'series'
            : 'single';

        normalizedChanges.push({
          type: 'reschedule_activity',
          activityId,
          activityTitle: act.title,
          occurrenceDate,
          newDate,
          newStartTime,
          newEndTime,
          scope: effectiveScope,
        });
      } else if (type === 'schedule_task') {
        const taskId = typeof ch.taskId === 'string' ? ch.taskId.trim() : '';
        const task = taskMap.get(taskId);
        if (!task) {
          changeInvalidReason = `Nonexistent taskId "${taskId}".`;
          break;
        }
        normalizedChanges.push({
          type: 'schedule_task',
          taskId,
          taskTitle: task.title,
          date: typeof ch.date === 'string' ? ch.date.trim() : '',
          startTime: typeof ch.startTime === 'string' ? ch.startTime.trim() : '',
          endTime: typeof ch.endTime === 'string' ? ch.endTime.trim() : '',
        });
      } else if (type === 'insert_break') {
        normalizedChanges.push({
          type: 'insert_break',
          title:
            typeof ch.title === 'string' && ch.title.trim()
              ? ch.title.trim().slice(0, 60)
              : 'Recovery break',
          date: typeof ch.date === 'string' ? ch.date.trim() : '',
          startTime: typeof ch.startTime === 'string' ? ch.startTime.trim() : '',
          endTime: typeof ch.endTime === 'string' ? ch.endTime.trim() : '',
        });
      } else {
        changeInvalidReason = `Unsupported change type "${String(type)}".`;
        break;
      }
    }

    if (changeInvalidReason) {
      rejectedReasons.push(`Suggestion "${title}": ${changeInvalidReason}`);
      continue;
    }

    // Validate each change against live schedule + sibling changes
    let allValid = true;
    for (const ch of normalizedChanges) {
      const check = validateSingleChangeCandidate(ch, {
        activities: sanitizedActivities,
        tasks: sanitizedTasks,
        todayISO: context.todayISO,
        nowMinutes: context.nowMinutes,
        siblingChanges: normalizedChanges,
      });
      if (!check.valid) {
        rejectedReasons.push(`Suggestion "${title}": ${check.error}`);
        allValid = false;
        break;
      }
    }

    if (!allValid) continue;

    validSuggestions.push({
      id:
        typeof obj.id === 'string' && obj.id.trim()
          ? obj.id.trim().slice(0, 48)
          : `enh-${idx + 1}`,
      title,
      reason,
      evidence,
      changes: normalizedChanges,
      beforePreview,
      afterPreview,
      tradeOffs,
    });
  }

  return { validSuggestions, rejectedReasons };
}

export function formatChangeSummaryLine(change: ScheduleEnhancementChange): string {
  if (change.type === 'reschedule_activity') {
    return `${change.activityTitle}: ${change.newDate} · ${change.newStartTime}–${change.newEndTime}`;
  }
  if (change.type === 'schedule_task') {
    return `Schedule "${change.taskTitle}": ${change.date} · ${change.startTime}–${change.endTime}`;
  }
  return `Add "${change.title}": ${change.date} · ${change.startTime}–${change.endTime}`;
}
