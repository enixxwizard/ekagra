import React, { useEffect, useMemo, useState } from 'react';
import { BiIcon } from '../ui/BiIcon';
import type { StructuredPdfImportPayload, StructuredPdfImportResult } from '../../context/DayFlowContext';
import type { ActivityCategory, ScheduleActivity, TimeFormat } from '../../types/dayflow';
import type {
  PdfDailyPlanItem,
  PdfDeadlineItem,
  PdfMonthlyGoalItem,
  PdfRoadmapMilestoneItem,
  PdfWeeklyPlanItem,
  StructuredPdfPlan,
} from '../../types/pdfSchedule';
import { formatTimeDisplay, getLocalTimeZoneName, getTodayISO } from '../../utils/dateTime';
import {
  evaluateSchedulePdfPlan,
  formatMinutesAsHoursLabel,
} from '../../utils/intelligentScheduleValidator';
import {
  MON_TO_SUN_ORDER,
  timeToMinutes,
  WEEKDAY_FULL_NAMES,
  WEEKDAY_SHORT_NAMES,
} from '../../utils/pdfSchemaValidator';
import {
  describeRecurrence,
  detectRecurringScheduleConflicts,
  groupWeeklyPlansIntoScheduleActivities,
} from '../../utils/recurrence';

const CATEGORIES: ActivityCategory[] = [
  'Study',
  'Work',
  'Deep Focus',
  'Health',
  'Personal',
  'Admin',
];

type PreviewTab = 'weekly' | 'daily' | 'monthly' | 'deadlines';
type WeeklyScopeMode = 'full' | 'selected_days' | 'one_day';

interface SmartPdfImportPreviewProps {
  plan: StructuredPdfPlan;
  onUpdatePlan: (updater: (prev: StructuredPdfPlan) => StructuredPdfPlan) => void;
  existingActivities: ScheduleActivity[];
  timeFormat: TimeFormat;
  onImport: (payload: StructuredPdfImportPayload) => StructuredPdfImportResult;
  onNotify: (msg: { type: 'success' | 'info' | 'warning'; title: string; description?: string }) => void;
  onOpenCalendar?: () => void;
  autoSyncedSummary?: string | null;
}

export const SmartPdfImportPreview: React.FC<SmartPdfImportPreviewProps> = ({
  plan,
  onUpdatePlan,
  existingActivities,
  timeFormat,
  onImport,
  onNotify,
  onOpenCalendar,
  autoSyncedSummary,
}) => {
  const todayISO = getTodayISO();
  const timeZone = getLocalTimeZoneName();

  const [activeTab, setActiveTab] = useState<PreviewTab>('weekly');
  const [scopeMode, setScopeMode] = useState<WeeklyScopeMode>('full');
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [oneDayTarget, setOneDayTarget] = useState<number>(1);
  const [includeBreaks, setIncludeBreaks] = useState<boolean>(false);
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [dateConfirmedByUser, setDateConfirmedByUser] = useState<boolean>(false);
  const [editingWeeklyId, setEditingWeeklyId] = useState<string | null>(null);
  const [lastImportResult, setLastImportResult] = useState<StructuredPdfImportResult | null>(null);
  const [importedSections, setImportedSections] = useState<Record<PreviewTab, boolean>>({
    weekly: false,
    daily: false,
    monthly: false,
    deadlines: false,
  });

  // Sync defaults whenever a new PDF extraction arrives
  useEffect(() => {
    const hasMilestones = (plan.roadmapMilestones?.length ?? 0) > 0;
    if (plan.weeklyPlans.length > 0) setActiveTab('weekly');
    else if (plan.dailyPlans.length > 0) setActiveTab('daily');
    else if (plan.monthlyGoals.length > 0 || hasMilestones) setActiveTab('monthly');
    else if (plan.deadlines.length > 0) setActiveTab('deadlines');
    else setActiveTab('weekly');

    const detectedDays = Array.from(
      new Set(plan.weeklyPlans.filter((w) => w.included).map((w) => w.weekday))
    );
    const fallbackDays = Array.from(new Set(plan.weeklyPlans.map((w) => w.weekday)));
    const initialDays = detectedDays.length > 0 ? detectedDays : fallbackDays;
    if (initialDays.length > 0) {
      setSelectedDays(initialDays);
      setOneDayTarget(initialDays.includes(1) ? 1 : initialDays[0]);
    } else {
      setSelectedDays([1, 2, 3, 4, 5, 6]);
    }

    const firstStart =
      plan.metadata?.suggestedStartDate ??
      plan.weeklyPlans.find((w) => w.startDate)?.startDate ??
      plan.dailyPlans.find((d) => d.date)?.date ??
      '';
    const firstEnd =
      plan.metadata?.suggestedEndDate ??
      plan.weeklyPlans.find((w) => w.endDate)?.endDate ??
      '';

    setStartDate(firstStart);
    setEndDate(firstEnd);
    setDateConfirmedByUser(plan.metadata?.dateRangeProvenance === 'explicit');
    setScopeMode('full');
    setEditingWeeklyId(null);
    setLastImportResult(null);
    setImportedSections({ weekly: false, daily: false, monthly: false, deadlines: false });
  }, [plan.documentHash, plan.analysisSource]);

  const evaluation = useMemo(() => {
    return evaluateSchedulePdfPlan(plan, {
      existingActivities,
      overrideStartDate: startDate || null,
      overrideEndDate: endDate || null,
      referenceDateISO: todayISO,
      dateConfirmedByUser,
    });
  }, [plan, existingActivities, startDate, endDate, todayISO, dateConfirmedByUser]);

  const effectiveSelectedWeekdays = useMemo(() => {
    if (scopeMode === 'one_day') {
      return [oneDayTarget];
    }
    if (scopeMode === 'full') {
      const detected = Array.from(
        new Set(plan.weeklyPlans.filter((w) => w.included).map((w) => w.weekday))
      );
      return detected.length > 0 ? detected : selectedDays;
    }
    return selectedDays;
  }, [scopeMode, oneDayTarget, plan.weeklyPlans, selectedDays]);

  const weeklySelectedMinutes = useMemo(() => {
    const allowed = new Set(effectiveSelectedWeekdays);
    let total = 0;
    for (const item of plan.weeklyPlans) {
      if (!item.included || !allowed.has(item.weekday)) continue;
      if (scopeMode === 'one_day' && item.weekday !== oneDayTarget) continue;
      const diff = timeToMinutes(item.endTime) - timeToMinutes(item.startTime);
      if (diff > 0) total += diff;
    }
    return total;
  }, [plan.weeklyPlans, effectiveSelectedWeekdays, scopeMode, oneDayTarget]);

  const previewGroupedRules = useMemo(() => {
    const effectiveStart = startDate || todayISO;
    return groupWeeklyPlansIntoScheduleActivities(plan.weeklyPlans, plan.breakPeriods, {
      selectedWeekdays: effectiveSelectedWeekdays,
      includeBreaks,
      oneDayOnly: scopeMode === 'one_day',
      startDate: effectiveStart,
      endDate: endDate || null,
      sourceFile: plan.fileName,
      timeZone,
    });
  }, [
    plan.weeklyPlans,
    plan.breakPeriods,
    plan.fileName,
    effectiveSelectedWeekdays,
    includeBreaks,
    scopeMode,
    startDate,
    endDate,
    todayISO,
    timeZone,
  ]);

  const weeklyConflicts = useMemo(() => {
    if (previewGroupedRules.length === 0 || !startDate) return [];
    return detectRecurringScheduleConflicts(
      previewGroupedRules,
      existingActivities,
      startDate
    );
  }, [previewGroupedRules, existingActivities, startDate]);

  const updateWeeklyItem = (id: string, patch: Partial<PdfWeeklyPlanItem>) => {
    onUpdatePlan((prev) => ({
      ...prev,
      weeklyPlans: prev.weeklyPlans.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      ),
    }));
  };

  const updateDailyItem = (id: string, patch: Partial<PdfDailyPlanItem>) => {
    onUpdatePlan((prev) => ({
      ...prev,
      dailyPlans: prev.dailyPlans.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      ),
    }));
  };

  const updateMonthlyGoal = (id: string, patch: Partial<PdfMonthlyGoalItem>) => {
    onUpdatePlan((prev) => ({
      ...prev,
      monthlyGoals: prev.monthlyGoals.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      ),
    }));
  };

  const updateMilestoneItem = (id: string, patch: Partial<PdfRoadmapMilestoneItem>) => {
    onUpdatePlan((prev) => ({
      ...prev,
      roadmapMilestones: (prev.roadmapMilestones ?? []).map((item) =>
        item.id === id ? { ...item, ...patch } : item
      ),
    }));
  };

  const updateDeadlineItem = (id: string, patch: Partial<PdfDeadlineItem>) => {
    onUpdatePlan((prev) => ({
      ...prev,
      deadlines: prev.deadlines.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      ),
    }));
  };

  const toggleDaySelection = (dayNum: number) => {
    if (scopeMode === 'one_day') {
      setOneDayTarget(dayNum);
      return;
    }
    if (scopeMode === 'full') {
      setScopeMode('selected_days');
    }
    setSelectedDays((prev) =>
      prev.includes(dayNum) ? prev.filter((d) => d !== dayNum) : [...prev, dayNum]
    );
  };

  const handleImportWeekly = () => {
    if (!startDate) {
      onNotify({
        type: 'warning',
        title: 'Start date required.',
        description: 'Select a start date before importing this recurring weekly timetable.',
      });
      return;
    }
    if (previewGroupedRules.length === 0) {
      onNotify({
        type: 'info',
        title: 'Nothing selected to import',
        description: 'Select at least one weekday and activity slot first.',
      });
      return;
    }

    setDateConfirmedByUser(true);
    const res = onImport({
      sourceFile: plan.fileName,
      weekly: {
        items: plan.weeklyPlans,
        breakPeriods: plan.breakPeriods,
        selectedWeekdays: effectiveSelectedWeekdays,
        includeBreaks,
        oneDayOnly: scopeMode === 'one_day',
        startDate,
        endDate: endDate || null,
      },
    });

    setLastImportResult(res);
    setImportedSections((prev) => ({ ...prev, weekly: true }));
    onNotify({
      type: res.conflictsCount > 0 ? 'warning' : 'success',
      title:
        res.activitiesAdded > 0
          ? `Imported ${res.activitiesAdded} ${
              res.recurringRulesAdded > 0 ? 'recurring rule' : 'schedule block'
            }${res.activitiesAdded === 1 ? '' : 's'}`
          : 'No new recurring rules added',
      description: [
        res.skippedDuplicates > 0 ? `${res.skippedDuplicates} duplicate skipped` : null,
        res.conflictsCount > 0 ? `${res.conflictsCount} overlap with existing schedule` : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'Your weekly timetable is now active across Calendar, Plan, Focus & Reminders.',
    });
  };

  const handleImportDaily = () => {
    const selected = plan.dailyPlans.filter((d) => d.included);
    if (selected.length === 0) {
      onNotify({ type: 'info', title: 'Select at least one daily activity.' });
      return;
    }
    const normalizedDaily = selected.map((d) => ({
      ...d,
      date: d.date ?? (startDate || null),
    }));
    if (normalizedDaily.some((d) => !d.date)) {
      onNotify({
        type: 'warning',
        title: 'Start date required.',
        description: 'Choose a date for undated daily study blocks before importing.',
      });
      return;
    }

    const res = onImport({
      sourceFile: plan.fileName,
      dailyItems: normalizedDaily,
    });
    setLastImportResult(res);
    setImportedSections((prev) => ({ ...prev, daily: true }));
    onNotify({
      type: res.conflictsCount > 0 ? 'warning' : 'success',
      title: `Added ${res.activitiesAdded} daily ${res.activitiesAdded === 1 ? 'activity' : 'activities'}`,
      description:
        res.skippedDuplicates > 0
          ? `${res.skippedDuplicates} duplicate skipped.`
          : 'Added to your timeline.',
    });
  };

  const handleImportMonthly = () => {
    const selectedMonthly = plan.monthlyGoals.filter((m) => m.included && m.goals.length > 0);
    const selectedMilestones = (plan.roadmapMilestones ?? []).filter((m) => m.included && m.title.trim());
    if (selectedMonthly.length === 0 && selectedMilestones.length === 0) {
      onNotify({ type: 'info', title: 'Select at least one roadmap goal or milestone.' });
      return;
    }
    const res = onImport({
      sourceFile: plan.fileName,
      monthlyGoals: selectedMonthly,
      roadmapMilestones: selectedMilestones,
    });
    setLastImportResult(res);
    setImportedSections((prev) => ({ ...prev, monthly: true }));
    onNotify({
      type: 'success',
      title: `Saved ${res.notesAdded} roadmap ${res.notesAdded === 1 ? 'note' : 'notes'}`,
      description: 'Saved as structured roadmap goals & milestones without inventing fake daily sessions.',
    });
  };

  const handleImportDeadlines = () => {
    const selected = plan.deadlines.filter((dl) => dl.included);
    if (selected.length === 0) {
      onNotify({ type: 'info', title: 'Select at least one deadline or exam.' });
      return;
    }
    const res = onImport({
      sourceFile: plan.fileName,
      deadlines: selected,
    });
    setLastImportResult(res);
    setImportedSections((prev) => ({ ...prev, deadlines: true }));
    onNotify({
      type: 'success',
      title: `Added ${res.tasksAdded} deadline ${res.tasksAdded === 1 ? 'task' : 'tasks'}`,
      description: 'Added to your Tasks backlog with original due dates preserved.',
    });
  };

  const handleSyncAllSections = () => {
    const hasWeeklyItems = previewGroupedRules.length > 0;
    const selectedDaily = plan.dailyPlans
      .filter((d) => d.included)
      .map((d) => ({ ...d, date: d.date ?? (startDate || null) }));
    const hasUndatedDaily = selectedDaily.some((d) => !d.date);

    if ((hasWeeklyItems && !startDate) || hasUndatedDaily) {
      onNotify({
        type: 'warning',
        title: 'Start date required.',
        description: 'Select a valid Start date before syncing this schedule.',
      });
      return;
    }

    const selectedMonthly = plan.monthlyGoals.filter((m) => m.included && m.goals.length > 0);
    const selectedMilestones = (plan.roadmapMilestones ?? []).filter((m) => m.included && m.title.trim());
    const selectedDeadlines = plan.deadlines.filter((dl) => dl.included);

    setDateConfirmedByUser(true);
    const res = onImport({
      sourceFile: plan.fileName,
      ...(hasWeeklyItems
        ? {
            weekly: {
              items: plan.weeklyPlans,
              breakPeriods: plan.breakPeriods,
              selectedWeekdays: effectiveSelectedWeekdays,
              includeBreaks,
              oneDayOnly: scopeMode === 'one_day',
              startDate,
              endDate: endDate || null,
            },
          }
        : {}),
      ...(selectedDaily.length > 0 ? { dailyItems: selectedDaily } : {}),
      ...(selectedMonthly.length > 0 ? { monthlyGoals: selectedMonthly } : {}),
      ...(selectedMilestones.length > 0 ? { roadmapMilestones: selectedMilestones } : {}),
      ...(selectedDeadlines.length > 0 ? { deadlines: selectedDeadlines } : {}),
    });

    setLastImportResult(res);
    setImportedSections({
      weekly: hasWeeklyItems,
      daily: selectedDaily.length > 0,
      monthly: selectedMonthly.length > 0 || selectedMilestones.length > 0,
      deadlines: selectedDeadlines.length > 0,
    });

    const totalAdded = res.activitiesAdded + res.tasksAdded + res.notesAdded;
    onNotify({
      type: res.conflictsCount > 0 ? 'warning' : totalAdded > 0 ? 'success' : 'info',
      title:
        totalAdded > 0
          ? `Synced schedule (${res.activitiesAdded} activities, ${res.notesAdded} roadmap notes, ${res.tasksAdded} deadlines)`
          : 'Already up to date',
      description:
        [
          res.skippedDuplicates > 0 ? `${res.skippedDuplicates} duplicates skipped` : null,
          res.conflictsCount > 0 ? `${res.conflictsCount} scheduling conflicts preserved for review` : null,
        ]
          .filter(Boolean)
          .join(' · ') || 'Calendar, Plan Dashboard, Focus Mode, and Reminders refreshed immediately.',
    });
  };

  const sourceBadge =
    plan.analysisSource === 'gemini-multimodal'
      ? 'Gemini Multimodal'
      : plan.analysisSource === 'gemini'
      ? 'Gemini AI'
      : 'Local table parser';

  const statusTone =
    evaluation.statusCode === 'conflicts_detected' || evaluation.statusCode === 'start_date_required'
      ? 'border-amber-300 bg-amber-50/70 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
      : evaluation.statusCode === 'clarification_required'
      ? 'border-sky-300 bg-sky-50/70 text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300'
      : 'border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]';

  const sundayPolicyLabel =
    plan.metadata?.sundayPolicy === 'rest'
      ? 'Sunday: Rest'
      : plan.metadata?.sundayPolicy === 'optional_review'
      ? 'Sunday: Optional review'
      : null;

  const milestonesList = plan.roadmapMilestones ?? [];
  const roadmapCount = plan.monthlyGoals.length + milestonesList.length;

  const tabs: Array<{ id: PreviewTab; label: string; count: number; icon: React.ReactNode }> = [
    {
      id: 'weekly',
      label: 'Weekly Plan',
      count: plan.weeklyPlans.length,
      icon: <BiIcon name="calendar3" className="text-xs" />,
    },
    {
      id: 'daily',
      label: 'Daily Plan',
      count: plan.dailyPlans.length,
      icon: <BiIcon name="calendar-event" className="text-xs" />,
    },
    {
      id: 'monthly',
      label: 'Roadmap & Months',
      count: roadmapCount,
      icon: <BiIcon name="bullseye" className="text-xs" />,
    },
    {
      id: 'deadlines',
      label: 'Deadlines',
      count: plan.deadlines.length,
      icon: <BiIcon name="check2-square" className="text-xs" />,
    },
  ];

  const weekdayLabel =
    effectiveSelectedWeekdays.length > 0
      ? effectiveSelectedWeekdays
          .slice()
          .sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b))
          .map((d) => WEEKDAY_SHORT_NAMES[d])
          .join(', ')
      : 'None';

  return (
    <section className="space-y-4 rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
      {/* Document & Status Header */}
      <div className="flex flex-col justify-between gap-3 border-b border-[var(--df-border)] pb-4 sm:flex-row sm:items-start">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg font-bold text-[var(--df-text)]">
              {plan.fileName}
            </h3>
            <span className={`rounded-lg border px-2.5 py-0.5 text-[11px] font-semibold ${statusTone}`}>
              {evaluation.statusMessage}
            </span>
            <span className="rounded-lg bg-[var(--df-surface-subtle)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--df-text)]">
              {evaluation.scheduleTypeLabel}
            </span>
            <span className="inline-flex items-center gap-1 rounded-lg bg-[var(--df-surface-subtle)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--df-text-muted)]">
              {plan.analysisSource !== 'local' && <BiIcon name="stars" className="text-[11px]" />}
              {sourceBadge}
              {plan.cached ? ' · Cached' : ''}
            </span>
          </div>
          <p className="text-xs text-[var(--df-text-muted)]">
            Timezone: {timeZone} · Weekly timetables save as compact recurring rules instead of repeated daily copies.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {onOpenCalendar && (lastImportResult || autoSyncedSummary) && (
            <button
              type="button"
              onClick={onOpenCalendar}
              className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-[var(--df-border-strong)] bg-[var(--df-bg)] px-3.5 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-accent)]"
            >
              <BiIcon name="calendar3" className="text-xs" />
              Open Calendar
            </button>
          )}
          <button
            type="button"
            onClick={handleSyncAllSections}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-4 text-xs font-semibold text-[var(--df-accent-fg)] hover:brightness-95"
          >
            <BiIcon name="check2-all" className="text-sm" />
            {dateConfirmedByUser || !evaluation.hasInferredDates
              ? 'Confirm & Sync Schedule'
              : 'Confirm Dates & Sync'}
          </button>
        </div>
      </div>

      {/* Auto-sync / Last Import Banner */}
      {(autoSyncedSummary || lastImportResult) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] px-4 py-2.5 text-xs text-[var(--df-accent-soft-fg)]">
          <div className="flex items-center gap-2 font-semibold">
            <BiIcon name="check-circle-fill" className="text-sm shrink-0" />
            <span>
              {autoSyncedSummary ??
                `Synced ${lastImportResult!.activitiesAdded} activities (${lastImportResult!.recurringRulesAdded} recurring), ${lastImportResult!.notesAdded} roadmap notes, ${lastImportResult!.tasksAdded} deadlines.`}
            </span>
          </div>
          {lastImportResult && lastImportResult.skippedDuplicates > 0 && (
            <span className="font-mono text-[11px]">
              {lastImportResult.skippedDuplicates} duplicates skipped
            </span>
          )}
        </div>
      )}

      {/* Structured Schedule Overview Metrics */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
            Start Date
          </p>
          <p className="mt-1 font-mono text-xs font-bold text-[var(--df-text)]">
            {startDate || 'Not set'}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
            End Date
          </p>
          <p className="mt-1 font-mono text-xs font-bold text-[var(--df-text)]">
            {endDate || 'Ongoing'}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
            Weekdays
          </p>
          <p className="mt-1 truncate text-xs font-bold text-[var(--df-text)]" title={weekdayLabel}>
            {weekdayLabel}
          </p>
          {sundayPolicyLabel && (
            <p className="mt-0.5 text-[10px] text-[var(--df-text-muted)]">{sundayPolicyLabel}</p>
          )}
        </div>
        <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
            Weekly Study Hours
          </p>
          <p className="mt-1 font-mono text-xs font-bold text-[var(--df-text)]">
            {formatMinutesAsHoursLabel(weeklySelectedMinutes)}
          </p>
          {evaluation.optionalWeeklyMinutes > 0 && (
            <p className="mt-0.5 text-[10px] text-[var(--df-text-muted)]">
              +{formatMinutesAsHoursLabel(evaluation.optionalWeeklyMinutes)} optional
            </p>
          )}
        </div>
        <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
            Break Periods
          </p>
          <p className="mt-1 font-mono text-xs font-bold text-[var(--df-text)]">
            {plan.breakPeriods.length}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
            Conflicts
          </p>
          <p
            className={`mt-1 font-mono text-xs font-bold ${
              evaluation.conflictsCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--df-text)]'
            }`}
          >
            {evaluation.conflictsCount}
          </p>
        </div>
      </div>

      {/* Missing Info / Clarification / Conflicts Callout */}
      {(evaluation.missingInformation.length > 0 ||
        evaluation.clarificationReasons.length > 0 ||
        evaluation.conflictMessages.length > 0 ||
        plan.warnings.length > 0) && (
        <div
          role="status"
          className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50/70 p-3.5 dark:border-amber-900/50 dark:bg-amber-950/25"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
            <BiIcon name="exclamation-triangle" className="text-sm shrink-0" />
            <span>
              {evaluation.statusMessage} Review details below before syncing:
            </span>
          </div>
          <ul className="space-y-1 pl-6 text-xs text-[var(--df-text-muted)] list-disc">
            {evaluation.missingInformation.map((m, i) => (
              <li key={`miss-${i}`}>{m}</li>
            ))}
            {evaluation.clarificationReasons.map((c, i) => (
              <li key={`clar-${i}`}>{c}</li>
            ))}
            {evaluation.conflictMessages.map((msg, i) => (
              <li key={`conf-${i}`} className="font-medium text-amber-800 dark:text-amber-300">
                {msg}
              </li>
            ))}
            {plan.warnings.map((w) => (
              <li key={w.id}>
                {w.message}
                {w.sourcePage ? ` (p. ${w.sourcePage})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 4 Classification Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-2xl bg-[var(--df-surface-subtle)] p-1">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold transition-colors ${
                isActive
                  ? 'bg-[var(--df-surface)] text-[var(--df-text)]'
                  : 'text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
              <span
                className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] ${
                  isActive
                    ? 'bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]'
                    : 'bg-black/5 text-[var(--df-text-muted)] dark:bg-white/10'
                }`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: WEEKLY PLAN */}
      {activeTab === 'weekly' && (
        <div className="space-y-4">
          {plan.weeklyPlans.length === 0 && plan.breakPeriods.length === 0 ? (
            <p className="py-8 text-center text-xs text-[var(--df-text-muted)]">
              No recurring weekly timetable detected. Check Daily Plan, Roadmap &amp; Months, or Deadlines tabs.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-4 lg:grid-cols-12">
                <div className="space-y-2 lg:col-span-7">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
                      Import scope
                    </span>
                    {(
                      [
                        { id: 'full', label: 'Full weekly plan' },
                        { id: 'selected_days', label: 'Selected days' },
                        { id: 'one_day', label: 'One-day plan' },
                      ] as const
                    ).map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => setScopeMode(mode.id)}
                        className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors ${
                          scopeMode === mode.id
                            ? 'bg-[var(--df-cta)] text-[var(--df-cta-fg)]'
                            : 'border border-[var(--df-border)] bg-[var(--df-surface)] text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
                        }`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {MON_TO_SUN_ORDER.map((dayNum) => {
                      const active = effectiveSelectedWeekdays.includes(dayNum);
                      return (
                        <button
                          key={dayNum}
                          type="button"
                          onClick={() => toggleDaySelection(dayNum)}
                          className={`min-w-[44px] rounded-lg px-2 py-1 text-xs font-semibold transition-colors ${
                            active
                              ? 'bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                              : 'border border-[var(--df-border)] bg-[var(--df-surface)] text-[var(--df-text-muted)]'
                          }`}
                        >
                          {WEEKDAY_SHORT_NAMES[dayNum]}
                        </button>
                      );
                    })}
                  </div>

                  <label className="inline-flex cursor-pointer items-center gap-2 pt-1 text-xs text-[var(--df-text)]">
                    <input
                      type="checkbox"
                      checked={includeBreaks}
                      onChange={(e) => setIncludeBreaks(e.target.checked)}
                      className="h-4 w-4 rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                    />
                    <span>
                      Include Break / Lunch periods ({plan.breakPeriods.length}) as optional unavailable blocks
                    </span>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2.5 lg:col-span-5 lg:self-start">
                  <div>
                    <label className="block text-[11px] font-medium text-[var(--df-text-muted)]">
                      Starts on {!startDate && <span className="text-amber-600">*required</span>}
                    </label>
                    <input
                      type="date"
                      aria-label="Schedule start date"
                      value={startDate}
                      onChange={(e) => {
                        setStartDate(e.target.value);
                        if (e.target.value) setDateConfirmedByUser(true);
                      }}
                      className={`mt-1 w-full rounded-xl border bg-[var(--df-surface)] px-2.5 py-2 font-mono text-xs text-[var(--df-text)] ${
                        !startDate
                          ? 'border-amber-400 ring-1 ring-amber-400/50'
                          : 'border-[var(--df-border)]'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-[var(--df-text-muted)]">
                      Ends on (optional)
                    </label>
                    <input
                      type="date"
                      aria-label="Schedule end date"
                      value={endDate}
                      disabled={scopeMode === 'one_day'}
                      onChange={(e) => {
                        setEndDate(e.target.value);
                        setDateConfirmedByUser(true);
                      }}
                      className="mt-1 w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-2 font-mono text-xs text-[var(--df-text)] disabled:opacity-50"
                    />
                  </div>
                </div>
              </div>

              {/* Monday–Sunday Timetable Grid */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-7">
                {MON_TO_SUN_ORDER.map((dayNum) => {
                  const isDaySelected = effectiveSelectedWeekdays.includes(dayNum);
                  const dayStudyItems = plan.weeklyPlans
                    .filter((item) => item.weekday === dayNum)
                    .sort((a, b) => a.startTime.localeCompare(b.startTime));
                  const dayBreaks = plan.breakPeriods.filter(
                    (b) => b.weekdays.length === 0 || b.weekdays.includes(dayNum)
                  );

                  const combined = [
                    ...dayStudyItems.map((s) => ({ kind: 'study' as const, startTime: s.startTime, item: s })),
                    ...dayBreaks.map((b) => ({ kind: 'break' as const, startTime: b.startTime, item: b })),
                  ].sort((a, b) => a.startTime.localeCompare(b.startTime));

                  return (
                    <div
                      key={dayNum}
                      className={`flex flex-col rounded-2xl border p-2.5 transition-opacity ${
                        isDaySelected || dayNum === 0
                          ? 'border-[var(--df-border)] bg-[var(--df-bg)]'
                          : 'border-[var(--df-border)] bg-[var(--df-bg)] opacity-50'
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between border-b border-[var(--df-border)] pb-1.5">
                        <span className="text-xs font-bold text-[var(--df-text)]">
                          {WEEKDAY_SHORT_NAMES[dayNum]}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--df-text-muted)]">
                          {dayStudyItems.filter((s) => s.included).length}
                        </span>
                      </div>

                      {combined.length === 0 ? (
                        <p className="py-4 text-center text-[11px] text-[var(--df-text-subtle)]">
                          {dayNum === 0 && plan.metadata?.sundayPolicy === 'optional_review'
                            ? 'Optional review'
                            : 'Rest / open'}
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {combined.map((entry) => {
                            if (entry.kind === 'break') {
                              const brk = entry.item;
                              return (
                                <div
                                  key={`${dayNum}-${brk.id}`}
                                  className={`rounded-xl border border-dashed px-2 py-1.5 text-[11px] ${
                                    includeBreaks && isDaySelected
                                      ? 'border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]'
                                      : 'border-[var(--df-border-strong)] bg-[var(--df-surface)] opacity-75 text-[var(--df-text-muted)]'
                                  }`}
                                >
                                  <div className="flex items-center gap-1 font-medium">
                                    <BiIcon name="cup-hot" className="text-[11px] shrink-0" />
                                    <span className="truncate">{brk.title}</span>
                                  </div>
                                  <div className="mt-0.5 font-mono text-[10px] opacity-80">
                                    {formatTimeDisplay(brk.startTime, timeFormat)}–{formatTimeDisplay(brk.endTime, timeFormat)}
                                  </div>
                                </div>
                              );
                            }

                            const item = entry.item;
                            const isEditing = editingWeeklyId === item.id;

                            return (
                              <div
                                key={item.id}
                                className={`rounded-xl border p-2 text-xs transition-colors ${
                                  item.included
                                    ? 'border-[var(--df-border)] bg-[var(--df-surface)]'
                                    : 'border-dashed border-[var(--df-border-strong)] bg-[var(--df-surface)] opacity-60'
                                }`}
                              >
                                {isEditing ? (
                                  <div className="space-y-1.5">
                                    <input
                                      type="text"
                                      value={item.title}
                                      onChange={(e) =>
                                        updateWeeklyItem(item.id, { title: e.target.value })
                                      }
                                      className="w-full rounded-lg border border-[var(--df-border-strong)] bg-[var(--df-bg)] px-1.5 py-1 text-xs font-semibold text-[var(--df-text)]"
                                    />
                                    <div className="grid grid-cols-2 gap-1">
                                      <input
                                        type="time"
                                        value={item.startTime}
                                        onChange={(e) =>
                                          updateWeeklyItem(item.id, { startTime: e.target.value })
                                        }
                                        className="rounded-lg border border-[var(--df-border)] bg-[var(--df-bg)] px-1 py-0.5 font-mono text-[10px] text-[var(--df-text)]"
                                      />
                                      <input
                                        type="time"
                                        value={item.endTime}
                                        onChange={(e) =>
                                          updateWeeklyItem(item.id, { endTime: e.target.value })
                                        }
                                        className="rounded-lg border border-[var(--df-border)] bg-[var(--df-bg)] px-1 py-0.5 font-mono text-[10px] text-[var(--df-text)]"
                                      />
                                    </div>
                                    <select
                                      value={item.weekday}
                                      onChange={(e) =>
                                        updateWeeklyItem(item.id, {
                                          weekday: Number(e.target.value),
                                        })
                                      }
                                      className="w-full rounded-lg border border-[var(--df-border)] bg-[var(--df-bg)] px-1.5 py-1 text-[11px] text-[var(--df-text)]"
                                    >
                                      {MON_TO_SUN_ORDER.map((wd) => (
                                        <option key={wd} value={wd}>
                                          {WEEKDAY_FULL_NAMES[wd]}
                                        </option>
                                      ))}
                                    </select>
                                    <select
                                      value={item.category}
                                      onChange={(e) =>
                                        updateWeeklyItem(item.id, {
                                          category: e.target.value as ActivityCategory,
                                        })
                                      }
                                      className="w-full rounded-lg border border-[var(--df-border)] bg-[var(--df-bg)] px-1.5 py-1 text-[11px] text-[var(--df-text)]"
                                    >
                                      {CATEGORIES.map((c) => (
                                        <option key={c} value={c}>
                                          {c}
                                        </option>
                                      ))}
                                    </select>
                                    <button
                                      type="button"
                                      onClick={() => setEditingWeeklyId(null)}
                                      className="w-full rounded-lg bg-[var(--df-cta)] py-1 text-[11px] font-semibold text-[var(--df-cta-fg)]"
                                    >
                                      Done
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <div className="flex items-start justify-between gap-1">
                                      <button
                                        type="button"
                                        onClick={() => setEditingWeeklyId(item.id)}
                                        className="text-left text-xs font-semibold leading-snug text-[var(--df-text)] hover:underline"
                                      >
                                        {item.title}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          updateWeeklyItem(item.id, { included: !item.included })
                                        }
                                        title={item.included ? 'Exclude slot' : 'Include slot'}
                                        className="shrink-0 rounded p-0.5 text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
                                      >
                                        {item.included ? (
                                          <BiIcon name="x-lg" className="text-[11px]" />
                                        ) : (
                                          <BiIcon name="check-lg" className="text-[11px]" />
                                        )}
                                      </button>
                                    </div>
                                    <div className="mt-1 flex items-center justify-between gap-1">
                                      <span className="font-mono text-[10px] text-[var(--df-text-muted)]">
                                        {formatTimeDisplay(item.startTime, timeFormat)}–{formatTimeDisplay(item.endTime, timeFormat)}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => setEditingWeeklyId(item.id)}
                                        aria-label={`Edit ${item.title}`}
                                        className="text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
                                      >
                                        <BiIcon name="pencil" className="text-[10px]" />
                                      </button>
                                    </div>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {item.optional && (
                                        <span className="inline-block rounded bg-[var(--df-surface-subtle)] px-1 py-0.5 text-[9px] font-medium text-[var(--df-text-muted)]">
                                          Optional
                                        </span>
                                      )}
                                      {item.monthlyOverrides && item.monthlyOverrides.length > 0 && (
                                        <span className="inline-block rounded bg-[var(--df-accent-soft)] px-1 py-0.5 text-[9px] font-medium text-[var(--df-accent-soft-fg)]">
                                          Monthly focus ({item.monthlyOverrides.length}mo)
                                        </span>
                                      )}
                                      {item.provenance !== 'explicit' && (
                                        <span className="inline-block rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                                          {item.provenance}
                                        </span>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Compact Rule Preview + Import Action */}
              <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-4 sm:flex-row sm:items-center">
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-[var(--df-text)]">
                    Creates {previewGroupedRules.length}{' '}
                    {scopeMode === 'one_day' ? 'one-time activity' : 'recurring schedule rule'}
                    {previewGroupedRules.length === 1 ? '' : 's'}
                  </p>
                  <p className="text-[11px] text-[var(--df-text-muted)]">
                    {previewGroupedRules
                      .slice(0, 3)
                      .map((r) => `${r.title} (${describeRecurrence(r)})`)
                      .join(' · ')}
                    {previewGroupedRules.length > 3 ? ` · +${previewGroupedRules.length - 3} more` : ''}
                  </p>
                  {weeklyConflicts.length > 0 && (
                    <p className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                      <BiIcon name="exclamation-triangle" className="text-xs shrink-0" />
                      {weeklyConflicts.length} overlap{weeklyConflicts.length === 1 ? '' : 's'} with your existing schedule (first: &ldquo;{weeklyConflicts[0].incomingTitle}&rdquo; vs &ldquo;{weeklyConflicts[0].existingTitle}&rdquo; on {weeklyConflicts[0].date}).
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleImportWeekly}
                  disabled={previewGroupedRules.length === 0 || !startDate}
                  className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-5 text-xs font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <BiIcon name="check-lg" className="text-xs" />
                  {importedSections.weekly
                    ? 'Weekly Plan Imported (Import Again)'
                    : scopeMode === 'one_day'
                    ? 'Import One-Day Plan'
                    : 'Import Weekly Plan'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 2: DAILY PLAN */}
      {activeTab === 'daily' && (
        <div className="space-y-3">
          {plan.dailyPlans.length === 0 ? (
            <p className="py-8 text-center text-xs text-[var(--df-text-muted)]">
              No standalone daily study blocks found in this document.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-[var(--df-text-muted)]">
                  Dated or routine study blocks. Undated blocks require picking a date before importing.
                </p>
                <button
                  type="button"
                  onClick={handleImportDaily}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-4 text-xs font-semibold text-[var(--df-accent-fg)] whitespace-nowrap shrink-0"
                >
                  <BiIcon name="check-lg" className="text-xs" />
                  {importedSections.daily ? 'Imported Daily Items' : 'Import Selected Daily'}
                </button>
              </div>
              {plan.dailyPlans.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-col gap-3 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3.5 sm:flex-row sm:items-center"
                >
                  <input
                    type="checkbox"
                    checked={item.included}
                    onChange={(e) => updateDailyItem(item.id, { included: e.target.checked })}
                    className="h-4 w-4 rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={item.title}
                        onChange={(e) => updateDailyItem(item.id, { title: e.target.value })}
                        className="min-w-[180px] flex-1 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:bg-[var(--df-surface)]"
                      />
                      <span className="text-[11px] text-[var(--df-text-muted)]">
                        p. {item.sourcePage} · {item.date ? `Date: ${item.dateProvenance}` : 'Select date'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <input
                        type="date"
                        value={item.date ?? startDate ?? ''}
                        onChange={(e) =>
                          updateDailyItem(item.id, {
                            date: e.target.value || null,
                            dateProvenance: e.target.value ? 'explicit' : 'suggested',
                          })
                        }
                        className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--df-text)]"
                      />
                      <input
                        type="time"
                        value={item.startTime}
                        onChange={(e) => updateDailyItem(item.id, { startTime: e.target.value })}
                        className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--df-text)]"
                      />
                      <input
                        type="time"
                        value={item.endTime}
                        onChange={(e) => updateDailyItem(item.id, { endTime: e.target.value })}
                        className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--df-text)]"
                      />
                      <select
                        value={item.category}
                        onChange={(e) =>
                          updateDailyItem(item.id, {
                            category: e.target.value as ActivityCategory,
                          })
                        }
                        className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 text-xs text-[var(--df-text)]"
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* TAB 3: ROADMAP & MONTHS */}
      {activeTab === 'monthly' && (
        <div className="space-y-4">
          {roadmapCount === 0 ? (
            <p className="py-8 text-center text-xs text-[var(--df-text-muted)]">
              No monthly goals or roadmap milestones detected in this document.
            </p>
          ) : (
            <>
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                <p className="text-xs text-[var(--df-text-muted)]">
                  Monthly technical goals &amp; roadmap milestones save cleanly without inventing fake daily calendar sessions.
                </p>
                <button
                  type="button"
                  onClick={handleImportMonthly}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-4 text-xs font-semibold text-[var(--df-accent-fg)] whitespace-nowrap shrink-0"
                >
                  <BiIcon name="journal-text" className="text-xs" />
                  {importedSections.monthly ? 'Saved Roadmap Notes' : 'Save Roadmap to Notes'}
                </button>
              </div>

              {plan.monthlyGoals.length > 0 && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {plan.monthlyGoals.map((mg) => (
                    <div
                      key={mg.id}
                      className="space-y-2.5 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <label className="inline-flex items-center gap-2 text-sm font-bold text-[var(--df-text)]">
                          <input
                            type="checkbox"
                            checked={mg.included}
                            onChange={(e) =>
                              updateMonthlyGoal(mg.id, { included: e.target.checked })
                            }
                            className="h-4 w-4 rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                          />
                          <span>
                            {mg.monthLabel}
                            {mg.year ? ` ${mg.year}` : ''}
                          </span>
                        </label>
                        <span className="text-[11px] text-[var(--df-text-muted)]">
                          p. {mg.sourcePage} · {mg.category}
                        </span>
                      </div>
                      <textarea
                        rows={3}
                        value={mg.goals.join('\n')}
                        onChange={(e) =>
                          updateMonthlyGoal(mg.id, {
                            goals: e.target.value
                              .split('\n')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] p-2.5 text-xs leading-relaxed text-[var(--df-text)]"
                      />
                    </div>
                  ))}
                </div>
              )}

              {milestonesList.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--df-text-muted)]">
                    Roadmap Milestones ({milestonesList.length})
                  </h4>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {milestonesList.map((rm) => (
                      <div
                        key={rm.id}
                        className="flex items-start gap-2.5 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3"
                      >
                        <input
                          type="checkbox"
                          checked={rm.included}
                          onChange={(e) =>
                            updateMilestoneItem(rm.id, { included: e.target.checked })
                          }
                          className="mt-1 h-4 w-4 rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="rounded bg-[var(--df-accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--df-accent-soft-fg)]">
                              {rm.phaseLabel}
                            </span>
                            <span className="text-[10px] text-[var(--df-text-muted)]">
                              p. {rm.sourcePage}
                            </span>
                          </div>
                          <input
                            type="text"
                            value={rm.title}
                            onChange={(e) =>
                              updateMilestoneItem(rm.id, { title: e.target.value })
                            }
                            className="mt-1.5 w-full rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-xs font-semibold text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:bg-[var(--df-surface)]"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* TAB 4: DEADLINES */}
      {activeTab === 'deadlines' && (
        <div className="space-y-3">
          {plan.deadlines.length === 0 ? (
            <p className="py-8 text-center text-xs text-[var(--df-text-muted)]">
              No explicit assignments, submissions, or exam deadlines detected.
            </p>
          ) : (
            <>
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                <p className="text-xs text-[var(--df-text-muted)]">
                  Saved directly to your Tasks backlog. Missing dates remain blank unless you fill them in.
                </p>
                <button
                  type="button"
                  onClick={handleImportDeadlines}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-4 text-xs font-semibold text-[var(--df-accent-fg)] whitespace-nowrap shrink-0"
                >
                  <BiIcon name="check-lg" className="text-xs" />
                  {importedSections.deadlines ? 'Added to Tasks' : 'Add Selected to Tasks'}
                </button>
              </div>
              {plan.deadlines.map((dl) => (
                <div
                  key={dl.id}
                  className="flex flex-col gap-3 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-3.5 sm:flex-row sm:items-center"
                >
                  <input
                    type="checkbox"
                    checked={dl.included}
                    onChange={(e) => updateDeadlineItem(dl.id, { included: e.target.checked })}
                    className="h-4 w-4 rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={dl.title}
                        onChange={(e) => updateDeadlineItem(dl.id, { title: e.target.value })}
                        className="min-w-[200px] flex-1 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:bg-[var(--df-surface)]"
                      />
                      <span className="rounded bg-[var(--df-surface-subtle)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--df-text)]">
                        {dl.kind}
                      </span>
                      <span className="text-[11px] text-[var(--df-text-muted)]">
                        p. {dl.sourcePage} · {dl.dueDate ? 'Explicit due date' : 'No date in PDF'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <input
                        type="date"
                        value={dl.dueDate ?? ''}
                        onChange={(e) =>
                          updateDeadlineItem(dl.id, {
                            dueDate: e.target.value || null,
                            provenance: e.target.value ? 'explicit' : 'inferred',
                          })
                        }
                        className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--df-text)]"
                      />
                      <input
                        type="time"
                        value={dl.dueTime ?? ''}
                        onChange={(e) =>
                          updateDeadlineItem(dl.id, { dueTime: e.target.value || null })
                        }
                        className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--df-text)]"
                      />
                      <select
                        value={dl.priority}
                        onChange={(e) =>
                          updateDeadlineItem(dl.id, {
                            priority: e.target.value as PdfDeadlineItem['priority'],
                          })
                        }
                        className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 text-xs text-[var(--df-text)]"
                      >
                        <option value="high">High priority</option>
                        <option value="medium">Medium priority</option>
                        <option value="low">Low priority</option>
                      </select>
                      <select
                        value={dl.category}
                        onChange={(e) =>
                          updateDeadlineItem(dl.id, {
                            category: e.target.value as ActivityCategory,
                          })
                        }
                        className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 text-xs text-[var(--df-text)]"
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
};
