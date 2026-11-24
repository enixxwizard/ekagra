import type { ScheduleActivity } from '../types/dayflow';
import type {
  PdfDocumentType,
  PdfProvenance,
  PdfScheduleStatusCode,
  StructuredPdfPlan,
} from '../types/pdfSchedule';
import { getLocalTimeZoneName, getTodayISO, parseTimeToMinutes } from './dateTime';
import type { PdfTextExtractionResult } from './pdfExtractor';
import { parsePdfPagesToStructuredPlan } from './pdfExtractor';
import {
  getScheduleStatusMessage,
  sanitizeIsoDate,
  timeToMinutes,
  WEEKDAY_FULL_NAMES,
} from './pdfSchemaValidator';
import {
  detectRecurringScheduleConflicts,
  groupWeeklyPlansIntoScheduleActivities,
  type RecurringConflictSummary,
  resolveActivitiesForDate,
} from './recurrence';
import { detectConflicts } from './scheduler';

export interface IntelligentScheduleEvaluation {
  accepted: boolean;
  statusCode: PdfScheduleStatusCode;
  statusMessage: string;
  scheduleTypeLabel: string;
  startDate: string | null;
  endDate: string | null;
  dateRangeProvenance: PdfProvenance | null;
  hasInferredDates: boolean;
  recurringWeekdays: number[];
  weeklyStudyMinutes: number;
  optionalWeeklyMinutes: number;
  weeklyStudyHoursLabel: string;
  missingInformation: string[];
  clarificationReasons: string[];
  conflictsCount: number;
  conflictSummaries: RecurringConflictSummary[];
  conflictMessages: string[];
  canAutoSync: boolean;
}

export function formatMinutesAsHoursLabel(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const hrs = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hrs === 0 && mins === 0) return '0h';
  if (mins === 0) return `${hrs}h`;
  if (hrs === 0) return `${mins}m`;
  return `${hrs}h ${mins}m`;
}

export function resolveScheduleTypeLabel(plan: StructuredPdfPlan): string {
  const hasWeekly = plan.weeklyPlans.length > 0;
  const hasDaily = plan.dailyPlans.length > 0;
  const hasMonthly = plan.monthlyGoals.length > 0;
  const hasMilestones = (plan.roadmapMilestones?.length ?? 0) > 0;
  const hasDeadlines = plan.deadlines.length > 0;

  if (plan.metadata?.isStudyResourceOnly) {
    return 'Study Resource / Reference Document';
  }
  if (hasWeekly && (hasMonthly || hasMilestones)) {
    return 'Hybrid Weekly Timetable & Multi-Month Roadmap';
  }
  if (hasWeekly) {
    return 'Recurring Weekly Timetable';
  }
  if (hasDaily && plan.dailyPlans.every((d) => Boolean(d.date))) {
    return 'Dated Study Schedule';
  }
  if (hasDaily) {
    return 'Daily Study Routine';
  }
  if (hasMonthly || hasMilestones) {
    return hasMonthly && plan.monthlyGoals.length >= 4
      ? 'Multi-Month Study Roadmap'
      : 'Learning Roadmap & Milestones';
  }
  if (hasDeadlines) {
    return 'Deadlines & Exam Schedule';
  }
  const map: Record<PdfDocumentType, string> = {
    daily: 'Daily Schedule',
    weekly: 'Recurring Weekly Timetable',
    monthly: 'Monthly Roadmap',
    roadmap: 'Study Roadmap',
    deadlines: 'Deadlines & Assignments',
    mixed: 'Mixed Study Schedule',
  };
  return map[plan.documentType] ?? 'Study Schedule';
}

export function evaluateSchedulePdfPlan(
  plan: StructuredPdfPlan,
  options?: {
    existingActivities?: ScheduleActivity[];
    overrideStartDate?: string | null;
    overrideEndDate?: string | null;
    referenceDateISO?: string;
    dateConfirmedByUser?: boolean;
  }
): IntelligentScheduleEvaluation {
  const existingActivities = options?.existingActivities ?? [];
  const referenceDateISO = options?.referenceDateISO ?? getTodayISO();
  const timeZone = getLocalTimeZoneName();

  const meta = plan.metadata;
  const startDate =
    sanitizeIsoDate(options?.overrideStartDate) ??
    meta?.suggestedStartDate ??
    plan.weeklyPlans.find((w) => w.startDate)?.startDate ??
    plan.dailyPlans.find((d) => d.date)?.date ??
    null;
  const endDate =
    sanitizeIsoDate(options?.overrideEndDate) ??
    meta?.suggestedEndDate ??
    plan.weeklyPlans.find((w) => w.endDate)?.endDate ??
    null;

  const dateRangeProvenance: PdfProvenance | null = options?.dateConfirmedByUser
    ? 'explicit'
    : meta?.dateRangeProvenance ?? (startDate ? 'explicit' : null);

  const hasInferredDates =
    dateRangeProvenance === 'inferred' ||
    dateRangeProvenance === 'suggested' ||
    plan.dailyPlans.some((d) => d.included && d.dateProvenance !== 'explicit');

  const includedWeekly = plan.weeklyPlans.filter((w) => w.included);
  const recurringWeekdays = Array.from(new Set(includedWeekly.map((w) => w.weekday))).sort(
    (a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b)
  );

  // Compulsory weekly study minutes (never includes breakPeriods or unchecked/optional slots)
  let weeklyStudyMinutes = 0;
  for (const w of includedWeekly) {
    if (w.optional) continue;
    const diff = timeToMinutes(w.endTime) - timeToMinutes(w.startTime);
    if (diff > 0) weeklyStudyMinutes += diff;
  }

  let optionalWeeklyMinutes = 0;
  for (const w of plan.weeklyPlans) {
    if (!w.optional) continue;
    const diff = timeToMinutes(w.endTime) - timeToMinutes(w.startTime);
    if (diff > 0) optionalWeeklyMinutes += diff;
  }

  const missingInformation = [...(meta?.missingInformation ?? [])].filter(
    (msg) =>
      !(startDate && /start date is missing/i.test(msg)) &&
      !(endDate && /end date was not specified/i.test(msg))
  );
  const clarificationReasons = [...(meta?.clarificationReasons ?? [])].filter((msg) =>
    options?.dateConfirmedByUser ? !/confirm suggested date range/i.test(msg) : true
  );

  const hasActiveWeekly = includedWeekly.length > 0;
  const hasAnyWeekly = plan.weeklyPlans.length > 0;
  const hasDaily = plan.dailyPlans.some((d) => d.included);
  const hasUndatedDaily = plan.dailyPlans.some((d) => d.included && !d.date);
  const hasRoadmap =
    plan.monthlyGoals.length > 0 || (plan.roadmapMilestones?.length ?? 0) > 0;
  const hasDeadlines = plan.deadlines.some((d) => d.included);

  if ((hasActiveWeekly || hasUndatedDaily) && !startDate && !missingInformation.some((m) => /start date/i.test(m))) {
    missingInformation.unshift('Start date is missing from the PDF.');
  }

  // Detect internal + calendar conflicts
  const conflictSummaries: RecurringConflictSummary[] = [];
  const conflictMessages: string[] = [];

  // 1. Internal weekly overlaps
  const byWeekday = new Map<number, typeof includedWeekly>();
  for (const item of includedWeekly) {
    const arr = byWeekday.get(item.weekday) ?? [];
    arr.push(item);
    byWeekday.set(item.weekday, arr);
  }
  for (const [wd, list] of byWeekday.entries()) {
    const sorted = [...list].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const overlap = timeToMinutes(a.endTime) - timeToMinutes(b.startTime);
      if (overlap > 0) {
        conflictMessages.push(
          `On ${WEEKDAY_FULL_NAMES[wd]}, "${a.title}" (${a.startTime}–${a.endTime}) overlaps "${b.title}" (${b.startTime}–${b.endTime}).`
        );
      }
    }
  }

  // 2. Weekly vs existing calendar activities (when startDate is known)
  if (hasActiveWeekly && existingActivities.length > 0) {
    const checkStart = startDate ?? referenceDateISO;
    const groupedRules = groupWeeklyPlansIntoScheduleActivities(includedWeekly, [], {
      selectedWeekdays: recurringWeekdays,
      includeBreaks: false,
      oneDayOnly: false,
      startDate: checkStart,
      endDate,
      sourceFile: plan.fileName,
      timeZone,
    });
    const recConflicts = detectRecurringScheduleConflicts(
      groupedRules,
      existingActivities,
      checkStart
    );
    for (const c of recConflicts) {
      conflictSummaries.push(c);
      conflictMessages.push(
        `"${c.incomingTitle}" overlaps existing "${c.existingTitle}" on ${c.date} (${c.overlapMinutes}m).`
      );
    }
  }

  // 3. Daily items internal + existing calendar conflicts
  const dailyByDate = new Map<string, ScheduleActivity[]>();
  for (const d of plan.dailyPlans) {
    if (!d.included || !d.date) continue;
    const candidate: ScheduleActivity = {
      id: `eval-${d.id}`,
      title: d.title,
      description: '',
      date: d.date,
      startTime: d.startTime,
      endTime: d.endTime,
      category: d.category,
      color: 'sky',
      priority: d.priority,
      status: 'pending',
      linkedTaskId: null,
      recurrence: { frequency: 'none', endDate: null },
      excludedDates: [],
      occurrenceOverrides: {},
      createdAt: '',
      updatedAt: '',
    };
    const arr = dailyByDate.get(d.date) ?? [];
    arr.push(candidate);
    dailyByDate.set(d.date, arr);
  }
  for (const [dateISO, candidates] of dailyByDate.entries()) {
    const existingForDay = resolveActivitiesForDate(existingActivities, dateISO).filter(
      (a) => a.status !== 'skipped'
    );
    const resolvedCandidates = resolveActivitiesForDate(candidates, dateISO);
    const overlaps = detectConflicts([...existingForDay, ...resolvedCandidates]);
    for (const ov of overlaps) {
      const oneIsIncoming =
        ov.first.activityId.startsWith('eval-') || ov.second.activityId.startsWith('eval-');
      const bothExisting =
        !ov.first.activityId.startsWith('eval-') && !ov.second.activityId.startsWith('eval-');
      if (!oneIsIncoming || bothExisting) continue;
      const incoming = ov.first.activityId.startsWith('eval-') ? ov.first : ov.second;
      const other = ov.first.activityId.startsWith('eval-') ? ov.second : ov.first;
      conflictSummaries.push({
        date: dateISO,
        weekday: new Date(`${dateISO}T00:00:00Z`).getUTCDay(),
        incomingTitle: incoming.title,
        existingTitle: other.title,
        overlapMinutes: ov.overlapMinutes,
      });
      conflictMessages.push(
        `"${incoming.title}" overlaps "${other.title}" on ${dateISO} (${ov.overlapMinutes}m).`
      );
    }
  }

  const uniqueConflictMessages = Array.from(new Set(conflictMessages));
  const conflictsCount = uniqueConflictMessages.length;

  const isStudyResource =
    Boolean(meta?.isStudyResourceOnly) ||
    (!hasAnyWeekly && !hasDaily && !hasRoadmap && !hasDeadlines);

  let statusCode: PdfScheduleStatusCode;
  if (isStudyResource) {
    statusCode = 'study_resource';
  } else if (!hasAnyWeekly && !hasDaily && !hasDeadlines && hasRoadmap) {
    statusCode = 'roadmap_detected';
  } else if ((hasActiveWeekly || hasUndatedDaily) && !startDate) {
    statusCode = 'start_date_required';
  } else if (conflictsCount > 0) {
    statusCode = 'conflicts_detected';
  } else if (clarificationReasons.length > 0) {
    statusCode = 'clarification_required';
  } else if (hasAnyWeekly) {
    statusCode = 'recurring_timetable';
  } else {
    statusCode = 'valid_schedule';
  }

  const accepted = statusCode !== 'study_resource';

  // Auto-sync is allowed ONLY when complete, unambiguous, and conflict-free
  const canAutoSync =
    accepted &&
    statusCode !== 'start_date_required' &&
    statusCode !== 'clarification_required' &&
    statusCode !== 'conflicts_detected' &&
    !hasInferredDates &&
    (statusCode === 'valid_schedule' || statusCode === 'recurring_timetable' || statusCode === 'roadmap_detected') &&
    ((hasActiveWeekly && Boolean(startDate)) ||
      (hasDaily && plan.dailyPlans.every((d) => !d.included || Boolean(d.date))) ||
      (statusCode === 'roadmap_detected' && hasRoadmap));

  return {
    accepted,
    statusCode,
    statusMessage: getScheduleStatusMessage(statusCode),
    scheduleTypeLabel: resolveScheduleTypeLabel(plan),
    startDate,
    endDate,
    dateRangeProvenance,
    hasInferredDates,
    recurringWeekdays,
    weeklyStudyMinutes,
    optionalWeeklyMinutes,
    weeklyStudyHoursLabel: formatMinutesAsHoursLabel(weeklyStudyMinutes),
    missingInformation,
    clarificationReasons,
    conflictsCount,
    conflictSummaries,
    conflictMessages: uniqueConflictMessages,
    canAutoSync,
  };
}

export function extractAndValidateIntelligentSchedule(
  extraction: PdfTextExtractionResult,
  existingActivities: ScheduleActivity[] = [],
  referenceDateISO = getTodayISO()
): { plan: StructuredPdfPlan; evaluation: IntelligentScheduleEvaluation } {
  const plan = parsePdfPagesToStructuredPlan(extraction.fileName, extraction.pages, {
    documentHash: extraction.documentHash,
    referenceDateISO,
  });
  const evaluation = evaluateSchedulePdfPlan(plan, {
    existingActivities,
    referenceDateISO,
  });
  return { plan, evaluation };
}

export function isNonZeroOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  const sA = parseTimeToMinutes(startA);
  const eA = parseTimeToMinutes(endA);
  const sB = parseTimeToMinutes(startB);
  const eB = parseTimeToMinutes(endB);
  return Math.min(eA, eB) - Math.max(sA, sB) > 0;
}
