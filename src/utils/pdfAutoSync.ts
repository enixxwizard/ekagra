import type { StructuredPdfImportPayload } from '../context/DayFlowContext';
import type { ScheduleActivity, QuickNote, TaskItem } from '../types/dayflow';
import type {
  PdfAutoSyncReviewItem,
  PdfDailyPlanItem,
  PdfDeadlineItem,
  PdfMonthlyGoalItem,
  PdfRoadmapMilestoneItem,
  PdfTimetableDiff,
  PdfWeeklyPlanItem,
  StructuredPdfPlan,
} from '../types/pdfSchedule';
import { getLocalTimeZoneName, parseTimeToMinutes } from './dateTime';
import { computeImportFingerprint } from './pdfSchemaValidator';
import {
  detectRecurringScheduleConflicts,
  groupWeeklyPlansIntoScheduleActivities,
  resolveActivitiesForDate,
} from './recurrence';
import { detectConflicts } from './scheduler';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_24_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isStrictValidISODate(dateStr: string | null | undefined): dateStr is string {
  if (!dateStr || !ISO_DATE_RE.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function isValidTimeRange(startTime: string, endTime: string): boolean {
  if (!TIME_24_RE.test(startTime) || !TIME_24_RE.test(endTime)) return false;
  return parseTimeToMinutes(endTime) > parseTimeToMinutes(startTime);
}

function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function activityHasSourceFile(act: ScheduleActivity, sourceFile: string): boolean {
  if (!sourceFile.trim()) return false;
  const needle = `source: ${sourceFile.trim().toLowerCase()}`;
  return (act.description ?? '').toLowerCase().includes(needle);
}

function getSortedDaysSignature(act: Pick<ScheduleActivity, 'recurrence' | 'date'>): string {
  const freq = act.recurrence?.frequency ?? 'none';
  if (freq === 'daily') return 'daily:0,1,2,3,4,5,6';
  if (freq === 'weekdays') return 'weekdays:1,2,3,4,5';
  if (freq === 'weekends') return 'weekends:0,6';
  if (freq === 'custom_weekdays') {
    return `custom:${[...(act.recurrence.daysOfWeek ?? [])].sort((a, b) => a - b).join(',')}`;
  }
  if (freq === 'weekly') {
    const days = act.recurrence.daysOfWeek ?? [];
    if (days.length > 0) return `weekly:${[...days].sort((a, b) => a - b).join(',')}`;
    const [y, m, d] = act.date.split('-').map(Number);
    const wd = new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
    return `weekly:${wd}`;
  }
  return `none:${act.date}`;
}

export interface PdfAutoSyncEvaluation {
  payload: StructuredPdfImportPayload;
  reviewPlan: StructuredPdfPlan;
  reviewItems: PdfAutoSyncReviewItem[];
  duplicatesSkipped: number;
  conflictsCount: number;
  readyActivitiesCount: number;
  readyTasksCount: number;
  readyNotesCount: number;
  timetableDiff: PdfTimetableDiff;
}

export interface EvaluatePdfAutoSyncInput {
  plan: StructuredPdfPlan;
  existingActivities: ScheduleActivity[];
  existingTasks: TaskItem[];
  existingNotes: QuickNote[];
  importedFingerprints: string[];
  referenceDateISO: string;
}

/**
 * Evaluates an extracted PDF schedule for safe automatic calendar synchronization:
 * - Validates dates, times, and recurrence rules in the local timezone
 * - Skips duplicates across existing activities, tasks, notes, and fingerprints
 * - Routes ambiguous items (missing/inferred dates, invalid time ranges) to review
 * - Detects overlaps against existing calendar events and within the incoming batch -> review
 * - Computes timetable update diffs against prior imports from the same filename
 *   without ever deleting or overwriting existing calendar activities silently
 */
export function evaluatePdfAutoSync(input: EvaluatePdfAutoSyncInput): PdfAutoSyncEvaluation {
  const {
    plan,
    existingActivities,
    existingTasks,
    existingNotes,
    importedFingerprints,
    referenceDateISO,
  } = input;

  const timeZone = getLocalTimeZoneName();
  const fingerprintSet = new Set(importedFingerprints);
  const reviewItems: PdfAutoSyncReviewItem[] = [];

  let duplicatesSkipped = 0;
  let conflictsCount = 0;

  // Track activities staged in this batch so internal overlaps don't sneak through
  const stagedActivities: ScheduleActivity[] = [...existingActivities];

  // Track review inclusion flags on a cloned plan so SmartPdfImportPreview highlights what needs attention
  const reviewWeeklyIds = new Set<string>();
  const reviewDailyIds = new Set<string>();
  const reviewDeadlineIds = new Set<string>();

  // --- 0. TIMETABLE DIFF DETECTION AGAINST PRIOR IMPORTS OF SAME FILE ---
  const priorSameFileActivities = existingActivities.filter((a) =>
    activityHasSourceFile(a, plan.fileName)
  );
  const hasPreviousImportFromFile = priorSameFileActivities.length > 0;
  const addedTitles: string[] = [];
  const changedTitles: string[] = [];
  const removedTitles: string[] = [];

  // --- 0B. STUDY RESOURCE GUARD ---
  if (plan.metadata?.isStudyResourceOnly) {
    return {
      payload: { sourceFile: plan.fileName },
      reviewPlan: plan,
      reviewItems: [],
      duplicatesSkipped: 0,
      conflictsCount: 0,
      readyActivitiesCount: 0,
      readyTasksCount: 0,
      readyNotesCount: 0,
      timetableDiff: {
        hasPreviousImportFromFile,
        addedTitles: [],
        changedTitles: [],
        removedTitles: [],
      },
    };
  }

  // --- 1. VALIDATE & EVALUATE WEEKLY TIMETABLE ---
  const candidateWeeklyItems: PdfWeeklyPlanItem[] = [];
  const validStartDates = plan.weeklyPlans
    .map((w) => w.startDate)
    .filter((d): d is string => isStrictValidISODate(d));
  const validEndDates = plan.weeklyPlans
    .map((w) => w.endDate)
    .filter((d): d is string => isStrictValidISODate(d));

  const metaStart = isStrictValidISODate(plan.metadata?.suggestedStartDate)
    ? plan.metadata!.suggestedStartDate!
    : null;
  const metaEnd = isStrictValidISODate(plan.metadata?.suggestedEndDate)
    ? plan.metadata!.suggestedEndDate!
    : null;

  const batchWeeklyStartDate = validStartDates[0] ?? metaStart;
  const batchWeeklyEndDate = validEndDates[0] ?? metaEnd ?? null;
  const isInferredRange =
    plan.metadata?.dateRangeProvenance === 'inferred' ||
    plan.metadata?.dateRangeProvenance === 'suggested';

  const hasAnyIncludedWeekly = plan.weeklyPlans.some((w) => w.included);
  if (hasAnyIncludedWeekly && !batchWeeklyStartDate) {
    for (const item of plan.weeklyPlans) {
      if (!item.included) continue;
      reviewWeeklyIds.add(item.id);
    }
    reviewItems.push({
      id: 'missing-start-date',
      section: 'dates',
      title: 'Start date required',
      reason: 'Select a start date for this recurring weekly timetable before importing.',
      sourcePage: 1,
    });
  } else if (hasAnyIncludedWeekly && isInferredRange && batchWeeklyStartDate) {
    for (const item of plan.weeklyPlans) {
      if (!item.included) continue;
      reviewWeeklyIds.add(item.id);
    }
    reviewItems.push({
      id: 'confirm-inferred-range',
      section: 'dates',
      title: 'Confirm suggested date range',
      reason: `Confirm inferred dates ${batchWeeklyStartDate}${
        batchWeeklyEndDate ? ` to ${batchWeeklyEndDate}` : ''
      } (${plan.metadata?.dateRangeLabel ?? 'month-year span'}) before importing.`,
      sourcePage: 1,
    });
  } else {
    for (const item of plan.weeklyPlans) {
      if (!item.included) continue;
      const title = item.title.trim();

      if (!title) {
        reviewWeeklyIds.add(item.id);
        reviewItems.push({
          id: item.id,
          section: 'weekly',
          title: 'Untitled timetable slot',
          reason: 'Missing activity title — enter a name before importing.',
          sourcePage: item.sourcePage,
        });
        continue;
      }

      if (item.weekday < 0 || item.weekday > 6 || !Number.isInteger(item.weekday)) {
        reviewWeeklyIds.add(item.id);
        reviewItems.push({
          id: item.id,
          section: 'weekly',
          title,
          reason: 'Unclear weekday column — confirm which day of the week this occurs.',
          sourcePage: item.sourcePage,
        });
        continue;
      }

      if (!isValidTimeRange(item.startTime, item.endTime)) {
        reviewWeeklyIds.add(item.id);
        reviewItems.push({
          id: item.id,
          section: 'weekly',
          title,
          reason: `Invalid or missing time range (${item.startTime}–${item.endTime}).`,
          sourcePage: item.sourcePage,
        });
        continue;
      }

      if (item.startDate !== null && !isStrictValidISODate(item.startDate)) {
        reviewWeeklyIds.add(item.id);
        reviewItems.push({
          id: item.id,
          section: 'weekly',
          title,
          reason: `Unrecognized start date "${item.startDate}".`,
          sourcePage: item.sourcePage,
        });
        continue;
      }

      if (item.endDate !== null && !isStrictValidISODate(item.endDate)) {
        reviewWeeklyIds.add(item.id);
        reviewItems.push({
          id: item.id,
          section: 'weekly',
          title,
          reason: `Unrecognized end date "${item.endDate}".`,
          sourcePage: item.sourcePage,
        });
        continue;
      }

      if (item.provenance !== 'explicit') {
        reviewWeeklyIds.add(item.id);
        reviewItems.push({
          id: item.id,
          section: 'weekly',
          title,
          reason: `Inferred (${item.provenance}) weekly slot — confirm timing before adding.`,
          sourcePage: item.sourcePage,
        });
        continue;
      }

      candidateWeeklyItems.push(item);
    }
  }

  // Group candidate explicit weekly entries into compact recurring rules
  const effectiveWeeklyStartDate = batchWeeklyStartDate ?? referenceDateISO;
  const groupedCandidateRules =
    candidateWeeklyItems.length > 0
      ? groupWeeklyPlansIntoScheduleActivities(candidateWeeklyItems, [], {
          selectedWeekdays: Array.from(new Set(candidateWeeklyItems.map((w) => w.weekday))),
          includeBreaks: false,
          oneDayOnly: false,
          startDate: effectiveWeeklyStartDate,
          endDate: batchWeeklyEndDate,
          sourceFile: plan.fileName,
          timeZone,
        })
      : [];

  const matchedPriorIds = new Set<string>();
  const acceptedWeeklyItemKeys = new Set<string>();

  for (const rule of groupedCandidateRules) {
    const daysSig = (rule.recurrence.daysOfWeek ?? []).join(',');
    const ruleFingerprint = computeImportFingerprint(
      plan.fileName,
      rule.title,
      rule.date,
      `${rule.startTime}-${rule.endTime}-${rule.recurrence.frequency}-${daysSig}`
    );

    const exactDuplicate = stagedActivities.find(
      (a) =>
        normalizeTitleKey(a.title) === normalizeTitleKey(rule.title) &&
        a.startTime === rule.startTime &&
        a.endTime === rule.endTime &&
        getSortedDaysSignature(a) === getSortedDaysSignature(rule)
    );

    if (fingerprintSet.has(ruleFingerprint) || exactDuplicate) {
      duplicatesSkipped += 1;
      if (exactDuplicate && activityHasSourceFile(exactDuplicate, plan.fileName)) {
        matchedPriorIds.add(exactDuplicate.id);
      }
      continue;
    }

    // Check if an updated PDF from the same source changed time/days for a previously imported title
    const priorSameTitle = priorSameFileActivities.find(
      (a) => normalizeTitleKey(a.title) === normalizeTitleKey(rule.title)
    );
    if (priorSameTitle) {
      matchedPriorIds.add(priorSameTitle.id);
      changedTitles.push(
        `${rule.title} (previously ${priorSameTitle.startTime}–${priorSameTitle.endTime}, updated PDF proposes ${rule.startTime}–${rule.endTime})`
      );

      for (const w of candidateWeeklyItems) {
        if (
          normalizeTitleKey(w.title) === normalizeTitleKey(rule.title) &&
          w.startTime === rule.startTime &&
          w.endTime === rule.endTime
        ) {
          reviewWeeklyIds.add(w.id);
        }
      }
      reviewItems.push({
        id: rule.id,
        section: 'weekly',
        title: rule.title,
        reason: `Updated timetable entry (${rule.startTime}–${rule.endTime}) differs from your existing "${priorSameTitle.title}" (${priorSameTitle.startTime}–${priorSameTitle.endTime}). Kept existing event untouched for your review.`,
      });
      continue;
    }

    // Check conflict against existing calendar + already accepted rules in this batch
    const conflictCheckStart =
      rule.date > effectiveWeeklyStartDate ? rule.date : effectiveWeeklyStartDate;
    const ruleConflicts = detectRecurringScheduleConflicts(
      [rule],
      stagedActivities,
      conflictCheckStart
    );

    if (ruleConflicts.length > 0) {
      conflictsCount += ruleConflicts.length;
      for (const w of candidateWeeklyItems) {
        if (
          normalizeTitleKey(w.title) === normalizeTitleKey(rule.title) &&
          w.startTime === rule.startTime &&
          w.endTime === rule.endTime
        ) {
          reviewWeeklyIds.add(w.id);
        }
      }
      const firstConflict = ruleConflicts[0];
      reviewItems.push({
        id: rule.id,
        section: 'weekly',
        title: rule.title,
        reason: `Overlaps "${firstConflict.existingTitle}" on ${firstConflict.date} (${firstConflict.overlapMinutes}m).`,
      });
      continue;
    }

    // Safe to auto-sync!
    stagedActivities.push(rule);
    addedTitles.push(rule.title);
    for (const w of candidateWeeklyItems) {
      if (
        normalizeTitleKey(w.title) === normalizeTitleKey(rule.title) &&
        w.startTime === rule.startTime &&
        w.endTime === rule.endTime
      ) {
        acceptedWeeklyItemKeys.add(w.id);
      }
    }
  }

  const autoWeeklyItems = candidateWeeklyItems.filter((w) => acceptedWeeklyItemKeys.has(w.id));

  // --- 2. VALIDATE & EVALUATE SINGLE-DATE DAILY ITEMS ---
  const autoDailyItems: PdfDailyPlanItem[] = [];

  for (const item of plan.dailyPlans) {
    if (!item.included) continue;
    const title = item.title.trim();

    if (!title) {
      reviewDailyIds.add(item.id);
      reviewItems.push({
        id: item.id,
        section: 'daily',
        title: 'Untitled event',
        reason: 'Missing event title.',
        sourcePage: item.sourcePage,
      });
      continue;
    }

    // Ambiguous / missing / inferred dates MUST go to review before saving
    if (!isStrictValidISODate(item.date) || item.dateProvenance !== 'explicit') {
      reviewDailyIds.add(item.id);
      reviewItems.push({
        id: item.id,
        section: 'daily',
        title,
        reason: !item.date
          ? 'Missing explicit calendar date — choose a date before adding.'
          : `Suggested date (${item.date}) needs confirmation before saving.`,
        sourcePage: item.sourcePage,
      });
      continue;
    }

    if (!isValidTimeRange(item.startTime, item.endTime) || item.timeProvenance !== 'explicit') {
      reviewDailyIds.add(item.id);
      reviewItems.push({
        id: item.id,
        section: 'daily',
        title,
        reason:
          item.timeProvenance !== 'explicit'
            ? `Suggested time (${item.startTime}–${item.endTime}) needs confirmation.`
            : `Invalid time range (${item.startTime}–${item.endTime}).`,
        sourcePage: item.sourcePage,
      });
      continue;
    }

    const itemFingerprint = computeImportFingerprint(
      plan.fileName,
      title,
      item.date,
      item.startTime
    );

    const exactDuplicate = stagedActivities.find(
      (a) =>
        a.date === item.date &&
        a.startTime === item.startTime &&
        a.endTime === item.endTime &&
        normalizeTitleKey(a.title) === normalizeTitleKey(title)
    );

    if (fingerprintSet.has(itemFingerprint) || exactDuplicate) {
      duplicatesSkipped += 1;
      if (exactDuplicate && activityHasSourceFile(exactDuplicate, plan.fileName)) {
        matchedPriorIds.add(exactDuplicate.id);
      }
      continue;
    }

    const priorSameTitleAndDate = priorSameFileActivities.find(
      (a) =>
        normalizeTitleKey(a.title) === normalizeTitleKey(title) &&
        a.date === item.date &&
        (a.recurrence?.frequency ?? 'none') === 'none'
    );
    if (priorSameTitleAndDate) {
      matchedPriorIds.add(priorSameTitleAndDate.id);
      changedTitles.push(
        `${title} on ${item.date} (was ${priorSameTitleAndDate.startTime}–${priorSameTitleAndDate.endTime}, updated PDF proposes ${item.startTime}–${item.endTime})`
      );
      reviewDailyIds.add(item.id);
      reviewItems.push({
        id: item.id,
        section: 'daily',
        title,
        reason: `Updated time on ${item.date} (${item.startTime}–${item.endTime}) differs from your existing "${priorSameTitleAndDate.title}". Kept existing event untouched for review.`,
        sourcePage: item.sourcePage,
      });
      continue;
    }

    const existingForDay = resolveActivitiesForDate(stagedActivities, item.date).filter(
      (a) => a.status !== 'skipped'
    );
    const candidateActivity: ScheduleActivity = {
      id: `sync-preview-${item.id}`,
      title,
      description: `Source: ${plan.fileName} (p. ${item.sourcePage})`,
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      category: item.category,
      color: 'sky',
      priority: item.priority,
      status: 'pending',
      linkedTaskId: null,
      recurrence: { frequency: 'none', endDate: null },
      excludedDates: [],
      occurrenceOverrides: {},
      createdAt: '',
      updatedAt: '',
    };

    const resolvedCandidate = resolveActivitiesForDate([candidateActivity], item.date);
    const overlaps = detectConflicts([...existingForDay, ...resolvedCandidate]);
    if (overlaps.length > 0) {
      conflictsCount += overlaps.length;
      reviewDailyIds.add(item.id);
      const otherTitle =
        overlaps[0].first.activityId === candidateActivity.id
          ? overlaps[0].second.title
          : overlaps[0].first.title;
      reviewItems.push({
        id: item.id,
        section: 'daily',
        title,
        reason: `Overlaps "${otherTitle}" on ${item.date} (${overlaps[0].overlapMinutes}m).`,
        sourcePage: item.sourcePage,
      });
      continue;
    }

    stagedActivities.push(candidateActivity);
    autoDailyItems.push(item);
    addedTitles.push(title);
  }

  // Flag previously synced items from this file that are absent in the updated PDF (never delete silently)
  if (hasPreviousImportFromFile) {
    for (const prior of priorSameFileActivities) {
      if (!matchedPriorIds.has(prior.id)) {
        // Also check if another rule in incoming weekly/daily matches its title
        const stillPresentInIncoming =
          plan.weeklyPlans.some(
            (w) => w.included && normalizeTitleKey(w.title) === normalizeTitleKey(prior.title)
          ) ||
          plan.dailyPlans.some(
            (d) => d.included && normalizeTitleKey(d.title) === normalizeTitleKey(prior.title)
          );
        if (!stillPresentInIncoming) {
          removedTitles.push(`${prior.title} (${prior.startTime}–${prior.endTime})`);
        }
      }
    }
  }

  // --- 3. VALIDATE & EVALUATE DEADLINES -> TASKS BACKLOG ---
  const autoDeadlines: PdfDeadlineItem[] = [];
  for (const dl of plan.deadlines) {
    if (!dl.included) continue;
    const title = dl.title.trim();
    if (!title) continue;

    if (!isStrictValidISODate(dl.dueDate) || dl.provenance !== 'explicit') {
      reviewDeadlineIds.add(dl.id);
      reviewItems.push({
        id: dl.id,
        section: 'deadlines',
        title,
        reason: dl.dueDate
          ? `Suggested due date (${dl.dueDate}) needs review before saving.`
          : 'Missing explicit due date — review or assign a date before adding.',
        sourcePage: dl.sourcePage,
      });
      continue;
    }

    const dlFingerprint = computeImportFingerprint(
      plan.fileName,
      title,
      dl.dueDate,
      dl.dueTime ?? dl.kind
    );
    const matchesExisting = existingTasks.some(
      (t) =>
        normalizeTitleKey(t.title) === normalizeTitleKey(title) &&
        t.dueDate === dl.dueDate
    );

    if (fingerprintSet.has(dlFingerprint) || matchesExisting) {
      duplicatesSkipped += 1;
      continue;
    }

    autoDeadlines.push(dl);
  }

  // --- 4. VALIDATE & EVALUATE MONTHLY ROADMAPS -> NOTES ---
  const autoMonthlyGoals: PdfMonthlyGoalItem[] = [];
  for (const mg of plan.monthlyGoals) {
    if (!mg.included) continue;
    const goalsClean = mg.goals.map((g) => g.trim()).filter(Boolean);
    if (goalsClean.length === 0) continue;

    const noteTitle = `${mg.monthLabel}${mg.year ? ` ${mg.year}` : ''} Monthly Goals`;
    const noteFingerprint = computeImportFingerprint(
      plan.fileName,
      noteTitle,
      `${mg.year ?? ''}-${String(mg.month).padStart(2, '0')}`,
      'monthly-goal'
    );
    const matchesExisting = existingNotes.some(
      (n) =>
        normalizeTitleKey(n.title) === normalizeTitleKey(noteTitle) &&
        n.content.includes(goalsClean[0])
    );

    if (fingerprintSet.has(noteFingerprint) || matchesExisting) {
      duplicatesSkipped += 1;
      continue;
    }

    autoMonthlyGoals.push({ ...mg, goals: goalsClean });
  }

  // --- 5. VALIDATE & EVALUATE ROADMAP MILESTONES -> NOTES ---
  const autoRoadmapMilestones: PdfRoadmapMilestoneItem[] = [];
  const rawMilestonesList = plan.roadmapMilestones ?? [];
  const activeMilestones = rawMilestonesList.filter((m) => m.included && m.title.trim());
  if (activeMilestones.length > 0) {
    const rmNoteTitle = `${plan.fileName.replace(/\.pdf$/i, '')} — Roadmap Milestones`;
    const rmFingerprint = computeImportFingerprint(
      plan.fileName,
      rmNoteTitle,
      String(activeMilestones.length),
      'roadmap-milestones'
    );
    const matchesExistingRm = existingNotes.some(
      (n) =>
        normalizeTitleKey(n.title) === normalizeTitleKey(rmNoteTitle) &&
        n.content.includes(activeMilestones[0].title.trim())
    );
    if (fingerprintSet.has(rmFingerprint) || matchesExistingRm) {
      duplicatesSkipped += activeMilestones.length;
    } else {
      autoRoadmapMilestones.push(...activeMilestones);
    }
  }

  const payload: StructuredPdfImportPayload = {
    sourceFile: plan.fileName,
    ...(autoWeeklyItems.length > 0
      ? {
          weekly: {
            items: autoWeeklyItems,
            breakPeriods: [],
            selectedWeekdays: Array.from(new Set(autoWeeklyItems.map((w) => w.weekday))),
            includeBreaks: false,
            oneDayOnly: false,
            startDate: effectiveWeeklyStartDate,
            endDate: batchWeeklyEndDate,
          },
        }
      : {}),
    ...(autoDailyItems.length > 0 ? { dailyItems: autoDailyItems } : {}),
    ...(autoMonthlyGoals.length > 0 ? { monthlyGoals: autoMonthlyGoals } : {}),
    ...(autoRoadmapMilestones.length > 0 ? { roadmapMilestones: autoRoadmapMilestones } : {}),
    ...(autoDeadlines.length > 0 ? { deadlines: autoDeadlines } : {}),
  };

  // Clone plan marking only un-synced / review-required items as checked for follow-up review
  const reviewPlan: StructuredPdfPlan = {
    ...plan,
    weeklyPlans: plan.weeklyPlans.map((w) => ({
      ...w,
      included: reviewWeeklyIds.has(w.id),
    })),
    dailyPlans: plan.dailyPlans.map((d) => ({
      ...d,
      included: reviewDailyIds.has(d.id),
    })),
    deadlines: plan.deadlines.map((dl) => ({
      ...dl,
      included: reviewDeadlineIds.has(dl.id),
    })),
    monthlyGoals: plan.monthlyGoals.map((mg) => ({
      ...mg,
      included: !autoMonthlyGoals.some((a) => a.id === mg.id) && mg.included,
    })),
    roadmapMilestones: rawMilestonesList.map((rm) => ({
      ...rm,
      included: !autoRoadmapMilestones.some((a) => a.id === rm.id) && rm.included,
    })),
  };

  const readyWeeklyRulesCount = groupWeeklyPlansIntoScheduleActivities(autoWeeklyItems, [], {
    selectedWeekdays: Array.from(new Set(autoWeeklyItems.map((w) => w.weekday))),
    includeBreaks: false,
    oneDayOnly: false,
    startDate: effectiveWeeklyStartDate,
    endDate: batchWeeklyEndDate,
    sourceFile: plan.fileName,
    timeZone,
  }).length;

  return {
    payload,
    reviewPlan,
    reviewItems,
    duplicatesSkipped,
    conflictsCount,
    readyActivitiesCount: readyWeeklyRulesCount + autoDailyItems.length,
    readyTasksCount: autoDeadlines.length,
    readyNotesCount: autoMonthlyGoals.length + (autoRoadmapMilestones.length > 0 ? 1 : 0),
    timetableDiff: {
      hasPreviousImportFromFile,
      addedTitles,
      changedTitles,
      removedTitles,
    },
  };
}
