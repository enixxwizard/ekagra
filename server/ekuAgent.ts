import { format, parseISO } from 'date-fns';
import type { ActivityCategory, FocusModeType, PriorityLevel, ScheduleActivity, TaskItem } from '../src/types/dayflow';
import type {
  EkuChatRequestBody,
  EkuChatResponseBody,
  EkuFocusAction,
  EkuPendingProposal,
  EkuResourceItem,
  EkuResourceLanguageNotice,
  EkuWorkspaceSnapshot,
  EnhancerActivitySnapshot,
  EnhancerTaskSnapshot,
  ScheduleEnhancementChange,
} from '../src/types/eku';
import {
  getActivityDurationMinutes,
  minutesToTime24,
  parseTimeToMinutes,
  shiftDateISO,
} from '../src/utils/dateTime';
import { resolveActivitiesForDate } from '../src/utils/recurrence';
import {
  isValidIsoDate,
  isValidTime24,
  runDeterministicScheduleAnalysis,
  sanitizeActivitiesForAnalysis,
  toStrictMinutes,
  validateSingleChangeCandidate,
} from '../src/utils/scheduleEngine';
import { detectConflicts } from '../src/utils/scheduler';
import { executeResourceSearch, normalizeLanguageName } from './ekuSearch';

const ALLOWED_CATEGORIES = new Set<ActivityCategory>([
  'Work',
  'Study',
  'Health',
  'Personal',
  'Deep Focus',
  'Admin',
]);
const ALLOWED_PRIORITIES = new Set<PriorityLevel>(['low', 'medium', 'high']);
const ALLOWED_STATUSES = new Set(['pending', 'completed', 'skipped']);
const ALLOWED_FREQUENCIES = new Set([
  'none',
  'daily',
  'weekdays',
  'weekends',
  'weekly',
  'custom_weekdays',
]);

interface OpenAIResponsesToolCall {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

interface OpenAIResponsesOutputMessage {
  type: 'message';
  content?: Array<{ type?: string; text?: string }>;
}

interface OpenAIResponsesApiResponse {
  id: string;
  output_text?: string;
  output?: Array<OpenAIResponsesToolCall | OpenAIResponsesOutputMessage | { type: string }>;
  error?: { message?: string; code?: string };
}

export function getOpenAIConfig() {
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  const model = (process.env.OPENAI_MODEL || '').trim() || 'gpt-4.1-mini';
  return {
    configured: Boolean(apiKey && apiKey !== 'MY_OPENAI_API_KEY'),
    apiKey,
    model,
  };
}

export function sanitizeEkuRequestBody(raw: unknown): {
  valid: boolean;
  error?: string;
  data?: EkuChatRequestBody;
} {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Request payload must be a JSON object.' };
  }
  const obj = raw as Record<string, unknown>;
  const message = typeof obj.message === 'string' ? obj.message.trim().slice(0, 1200) : '';
  if (!message) {
    return { valid: false, error: 'Please enter a message or voice command for Eku.' };
  }

  const rawHistory = Array.isArray(obj.history) ? obj.history : [];
  const history = rawHistory
    .slice(-10)
    .filter(
      (h): h is { role: 'user' | 'assistant'; content: string } =>
        Boolean(h) &&
        typeof h === 'object' &&
        ((h as Record<string, unknown>).role === 'user' ||
          (h as Record<string, unknown>).role === 'assistant') &&
        typeof (h as Record<string, unknown>).content === 'string'
    )
    .map((h) => ({
      role: h.role,
      content: h.content.trim().slice(0, 1000),
    }))
    .filter((h) => Boolean(h.content));

  const rawSnap =
    obj.snapshot && typeof obj.snapshot === 'object'
      ? (obj.snapshot as Record<string, unknown>)
      : {};

  const todayISO = isValidIsoDate(rawSnap.todayISO)
    ? rawSnap.todayISO
    : new Date().toISOString().slice(0, 10);
  const nowMinutes =
    typeof rawSnap.nowMinutes === 'number' && Number.isFinite(rawSnap.nowMinutes)
      ? Math.max(0, Math.min(1439, Math.round(rawSnap.nowMinutes)))
      : new Date().getHours() * 60 + new Date().getMinutes();
  const timeZone =
    typeof rawSnap.timeZone === 'string' && rawSnap.timeZone.trim()
      ? rawSnap.timeZone.trim().slice(0, 64)
      : 'Local Time';
  const dailyCapacityHours =
    typeof rawSnap.dailyCapacityHours === 'number' && Number.isFinite(rawSnap.dailyCapacityHours)
      ? Math.max(2, Math.min(16, rawSnap.dailyCapacityHours))
      : 8;
  const preferredLanguage =
    typeof rawSnap.preferredLanguage === 'string'
      ? normalizeLanguageName(rawSnap.preferredLanguage)
      : null;

  const cleanActivities: EnhancerActivitySnapshot[] = [];
  for (const item of Array.isArray(rawSnap.activities) ? rawSnap.activities.slice(0, 300) : []) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string' || typeof a.title !== 'string') continue;
    const recRaw = (a.recurrence && typeof a.recurrence === 'object'
      ? a.recurrence
      : {}) as Record<string, unknown>;
    const rawFreq = recRaw.frequency === 'custom' ? 'custom_weekdays' : recRaw.frequency;
    const frequency =
      typeof rawFreq === 'string' && ALLOWED_FREQUENCIES.has(rawFreq)
        ? (rawFreq as EnhancerActivitySnapshot['recurrence']['frequency'])
        : 'none';
    const daysOfWeek = Array.isArray(recRaw.daysOfWeek)
      ? recRaw.daysOfWeek.filter(
          (d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6
        )
      : undefined;
    const endDate =
      typeof recRaw.endDate === 'string' && isValidIsoDate(recRaw.endDate)
        ? recRaw.endDate
        : null;

    const overrides: EnhancerActivitySnapshot['occurrenceOverrides'] = {};
    if (a.occurrenceOverrides && typeof a.occurrenceOverrides === 'object') {
      for (const [k, v] of Object.entries(a.occurrenceOverrides as Record<string, unknown>)) {
        if (!isValidIsoDate(k) || !v || typeof v !== 'object') continue;
        const ov = v as Record<string, unknown>;
        overrides[k] = {
          title: typeof ov.title === 'string' ? ov.title.trim().slice(0, 120) : undefined,
          startTime: isValidTime24(ov.startTime) ? ov.startTime : undefined,
          endTime: isValidTime24(ov.endTime) ? ov.endTime : undefined,
          category:
            typeof ov.category === 'string' && ALLOWED_CATEGORIES.has(ov.category as ActivityCategory)
              ? (ov.category as ActivityCategory)
              : undefined,
          priority:
            typeof ov.priority === 'string' && ALLOWED_PRIORITIES.has(ov.priority as PriorityLevel)
              ? (ov.priority as PriorityLevel)
              : undefined,
          status:
            typeof ov.status === 'string' && ALLOWED_STATUSES.has(ov.status)
              ? (ov.status as EnhancerActivitySnapshot['status'])
              : undefined,
        };
      }
    }

    cleanActivities.push({
      id: a.id.trim().slice(0, 80),
      title: a.title.trim().slice(0, 120),
      date: typeof a.date === 'string' ? a.date.trim() : '',
      startTime: typeof a.startTime === 'string' ? a.startTime.trim() : '',
      endTime: typeof a.endTime === 'string' ? a.endTime.trim() : '',
      category:
        typeof a.category === 'string' && ALLOWED_CATEGORIES.has(a.category as ActivityCategory)
          ? (a.category as ActivityCategory)
          : 'Study',
      priority:
        typeof a.priority === 'string' && ALLOWED_PRIORITIES.has(a.priority as PriorityLevel)
          ? (a.priority as PriorityLevel)
          : 'medium',
      status:
        typeof a.status === 'string' && ALLOWED_STATUSES.has(a.status)
          ? (a.status as EnhancerActivitySnapshot['status'])
          : 'pending',
      linkedTaskId: typeof a.linkedTaskId === 'string' ? a.linkedTaskId.trim().slice(0, 80) : null,
      recurrence: { frequency, daysOfWeek, endDate },
      excludedDates: Array.isArray(a.excludedDates)
        ? a.excludedDates.filter((d): d is string => isValidIsoDate(d))
        : [],
      occurrenceOverrides: overrides,
    });
  }

  const cleanTasks: EnhancerTaskSnapshot[] = [];
  for (const item of Array.isArray(rawSnap.tasks) ? rawSnap.tasks.slice(0, 200) : []) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || typeof t.title !== 'string') continue;
    cleanTasks.push({
      id: t.id.trim().slice(0, 80),
      title: t.title.trim().slice(0, 120),
      priority:
        typeof t.priority === 'string' && ALLOWED_PRIORITIES.has(t.priority as PriorityLevel)
          ? (t.priority as PriorityLevel)
          : 'medium',
      dueDate: typeof t.dueDate === 'string' && isValidIsoDate(t.dueDate) ? t.dueDate : null,
      category:
        typeof t.category === 'string' && ALLOWED_CATEGORIES.has(t.category as ActivityCategory)
          ? (t.category as ActivityCategory)
          : 'Study',
      completed: Boolean(t.completed),
      estimatedMinutes:
        typeof t.estimatedMinutes === 'number' && Number.isFinite(t.estimatedMinutes)
          ? Math.max(10, Math.min(480, Math.round(t.estimatedMinutes)))
          : 30,
      scheduledActivityId:
        typeof t.scheduledActivityId === 'string' ? t.scheduledActivityId.trim().slice(0, 80) : null,
    });
  }

  const rawFocus =
    rawSnap.focusSummary && typeof rawSnap.focusSummary === 'object'
      ? (rawSnap.focusSummary as Record<string, unknown>)
      : {};

  const snapshot: EkuWorkspaceSnapshot = {
    todayISO,
    nowMinutes,
    timeZone,
    dailyCapacityHours,
    preferredLanguage,
    activities: cleanActivities,
    tasks: cleanTasks,
    focusSummary: {
      timerStatus:
        rawFocus.timerStatus === 'running' || rawFocus.timerStatus === 'paused'
          ? rawFocus.timerStatus
          : 'idle',
      timerMode:
        rawFocus.timerMode === 'short_break' || rawFocus.timerMode === 'long_break'
          ? rawFocus.timerMode
          : 'focus',
      remainingMinutes:
        typeof rawFocus.remainingMinutes === 'number' && Number.isFinite(rawFocus.remainingMinutes)
          ? Math.max(0, Math.min(180, Math.round(rawFocus.remainingMinutes)))
          : 25,
      linkedActivityTitle:
        typeof rawFocus.linkedActivityTitle === 'string'
          ? rawFocus.linkedActivityTitle.trim().slice(0, 120)
          : null,
      todayFocusMinutes:
        typeof rawFocus.todayFocusMinutes === 'number' && Number.isFinite(rawFocus.todayFocusMinutes)
          ? Math.max(0, Math.round(rawFocus.todayFocusMinutes))
          : 0,
      weeklyFocusMinutes:
        typeof rawFocus.weeklyFocusMinutes === 'number' && Number.isFinite(rawFocus.weeklyFocusMinutes)
          ? Math.max(0, Math.round(rawFocus.weeklyFocusMinutes))
          : 0,
      todayHabitsCompleted:
        typeof rawFocus.todayHabitsCompleted === 'number' && Number.isFinite(rawFocus.todayHabitsCompleted)
          ? Math.max(0, Math.round(rawFocus.todayHabitsCompleted))
          : 0,
      totalHabits:
        typeof rawFocus.totalHabits === 'number' && Number.isFinite(rawFocus.totalHabits)
          ? Math.max(0, Math.round(rawFocus.totalHabits))
          : 0,
    },
  };

  return {
    valid: true,
    data: { message, history, snapshot },
  };
}

const EKU_TOOLS = [
  {
    type: 'function',
    name: 'get_calendar_events',
    description: 'Read scheduled calendar events for a date or date range (up to 14 days).',
    parameters: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD start date (defaults to todayISO).' },
        endDate: { type: 'string', description: 'YYYY-MM-DD end date (defaults to startDate).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'detect_schedule_conflicts',
    description: 'Detect overlapping blocks, overloaded days, and deadline risks across upcoming days.',
    parameters: {
      type: 'object',
      properties: {
        horizonDays: { type: 'integer', description: 'Days to analyze (1 to 14, default 7).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'propose_optimized_schedule',
    description:
      'Analyze fixed vs flexible commitments, open slots, break gaps, and urgent unscheduled tasks for a target date or horizon so you can build conflict-free schedule proposals.',
    parameters: {
      type: 'object',
      properties: {
        targetDate: { type: 'string', description: 'Target YYYY-MM-DD date to prioritize.' },
        horizonDays: { type: 'integer', description: 'Days to inspect (1 to 7, default 3).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'update_calendar_events',
    description:
      'Queue validated calendar/schedule modifications (reschedule activities, schedule tasks into open slots, or insert recovery breaks) for explicit student approval. Never alters fixed past events or overlaps.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short summary title of this plan proposal.' },
        reason: { type: 'string', description: 'Why these edits improve the student schedule.' },
        tradeOffs: { type: 'string', description: 'Honest trade-offs or Minimal trade-off.' },
        beforePreview: { type: 'string', description: 'Brief before state summary.' },
        afterPreview: { type: 'string', description: 'Brief after state summary.' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['reschedule_activity', 'schedule_task', 'insert_break'],
              },
              activityId: { type: 'string' },
              occurrenceDate: { type: 'string' },
              newDate: { type: 'string' },
              newStartTime: { type: 'string' },
              newEndTime: { type: 'string' },
              scope: { type: 'string', enum: ['single', 'series'] },
              taskId: { type: 'string' },
              title: { type: 'string' },
              date: { type: 'string' },
              startTime: { type: 'string' },
              endTime: { type: 'string' },
            },
            required: ['type'],
          },
        },
      },
      required: ['title', 'reason', 'changes'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_study_task',
    description:
      'Queue a new study task for explicit user confirmation before saving to the Tasks backlog.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Clear actionable task title.' },
        dueDate: { type: ['string', 'null'], description: 'Optional YYYY-MM-DD due date.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        category: {
          type: 'string',
          enum: ['Work', 'Study', 'Health', 'Personal', 'Deep Focus', 'Admin'],
        },
        estimatedMinutes: { type: 'integer', description: 'Estimated duration in minutes (10-480).' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'start_focus_session',
    description: 'Start the EKAGRA Focus timer with a specific duration in minutes.',
    parameters: {
      type: 'object',
      properties: {
        durationMinutes: { type: 'integer', description: 'Duration in minutes (5 to 180, default 25).' },
        mode: { type: 'string', enum: ['focus', 'short_break', 'long_break'] },
        activityId: { type: ['string', 'null'], description: 'Optional existing activity ID to link.' },
      },
      required: ['durationMinutes'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'pause_focus_session',
    description: 'Pause the currently running EKAGRA Focus timer.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_reminder',
    description:
      'Queue a timed reminder/study block on the EKAGRA schedule for user confirmation (triggers Ekagra full-screen and browser notifications).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to remind the student to do.' },
        date: { type: 'string', description: 'YYYY-MM-DD date (defaults to todayISO).' },
        time: { type: 'string', description: '24-hour HH:mm start time.' },
        durationMinutes: { type: 'integer', description: 'Duration in minutes (15 to 180, default 30).' },
        category: {
          type: 'string',
          enum: ['Work', 'Study', 'Health', 'Personal', 'Deep Focus', 'Admin'],
        },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['title', 'date', 'time'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_study_progress',
    description:
      'Get real current study progress: open/completed tasks, overdue items, next upcoming activity, active focus timer, and daily/weekly focus minutes.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'search_learning_resources',
    description:
      'Search real educational resources (YouTube videos, official docs, university notes, direct PDFs). Must verify or ask preferredLanguage first unless already known.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Academic subject or concept to search for.' },
        preferredLanguage: {
          type: ['string', 'null'],
          description:
            'Preferred language (e.g. English, Tamil, Hindi). Omit or pass null if not yet stated or remembered.',
        },
        includePdfs: { type: 'boolean' },
        includeVideos: { type: 'boolean' },
        allowFallbackPdfLanguage: {
          type: 'boolean',
          description:
            'Set true ONLY when the student explicitly approves viewing an alternative-language (e.g. English) PDF after being informed.',
        },
      },
      required: ['topic'],
      additionalProperties: false,
    },
  },
];

interface ExecutionContext {
  snapshot: EkuWorkspaceSnapshot;
  validActivities: ScheduleActivity[];
  sanitizedTasks: TaskItem[];
  proposals: EkuPendingProposal[];
  focusActions: EkuFocusAction[];
  resources: EkuResourceItem[];
  languageNotice: EkuResourceLanguageNotice | null;
  detectedPreferredLanguage: string | null;
}

async function runToolCall(
  name: string,
  argsRaw: Record<string, unknown>,
  ctx: ExecutionContext
): Promise<unknown> {
  const { snapshot, validActivities, sanitizedTasks } = ctx;

  switch (name) {
    case 'get_calendar_events': {
      const startDate = isValidIsoDate(argsRaw.startDate) ? argsRaw.startDate : snapshot.todayISO;
      const endDate = isValidIsoDate(argsRaw.endDate) ? argsRaw.endDate : startDate;
      const days: Array<{ date: string; weekday: string; events: unknown[] }> = [];
      let cursor = startDate;
      for (let i = 0; i < 14; i++) {
        if (cursor > endDate) break;
        const resolved = resolveActivitiesForDate(validActivities, cursor).map((a) => ({
          activityId: a.activityId,
          title: a.title,
          startTime: a.startTime,
          endTime: a.endTime,
          durationMinutes: getActivityDurationMinutes(a.startTime, a.endTime),
          category: a.category,
          priority: a.priority,
          status: a.status,
          isRecurring: a.isRecurring,
        }));
        days.push({
          date: cursor,
          weekday: format(parseISO(cursor), 'EEEE'),
          events: resolved,
        });
        cursor = shiftDateISO(cursor, 1);
      }
      return { startDate, endDate, days };
    }

    case 'detect_schedule_conflicts': {
      const horizonDays =
        typeof argsRaw.horizonDays === 'number'
          ? Math.max(1, Math.min(14, Math.round(argsRaw.horizonDays)))
          : 7;
      const report = runDeterministicScheduleAnalysis({
        activities: validActivities,
        tasks: sanitizedTasks,
        todayISO: snapshot.todayISO,
        nowMinutes: snapshot.nowMinutes,
        timeZone: snapshot.timeZone,
        dailyCapacityHours: snapshot.dailyCapacityHours,
        horizonDays,
      });
      return {
        overlaps: report.overlaps,
        overloadedDaysCount: report.overloadedDaysCount,
        deadlineFindings: report.deadlineFindings,
        daysSummary: report.days.map((d) => ({
          date: d.date,
          weekday: d.weekday,
          plannedMinutes: d.plannedMinutes,
          capacityMinutes: d.capacityMinutes,
          isOverloaded: d.isOverloaded,
          freeMinutesAfterNow: d.freeMinutesAfterNow,
        })),
      };
    }

    case 'propose_optimized_schedule': {
      const targetDate = isValidIsoDate(argsRaw.targetDate)
        ? argsRaw.targetDate
        : snapshot.todayISO;
      const horizonDays =
        typeof argsRaw.horizonDays === 'number'
          ? Math.max(1, Math.min(7, Math.round(argsRaw.horizonDays)))
          : 3;
      const startAnalysisISO = targetDate > snapshot.todayISO ? targetDate : snapshot.todayISO;
      const report = runDeterministicScheduleAnalysis({
        activities: validActivities,
        tasks: sanitizedTasks,
        todayISO: startAnalysisISO,
        nowMinutes: startAnalysisISO === snapshot.todayISO ? snapshot.nowMinutes : 0,
        timeZone: snapshot.timeZone,
        dailyCapacityHours: snapshot.dailyCapacityHours,
        horizonDays,
      });
      const unscheduledTasks = sanitizedTasks
        .filter((t) => !t.completed && !t.scheduledActivityId)
        .map((t) => ({
          taskId: t.id,
          title: t.title,
          priority: t.priority,
          dueDate: t.dueDate,
          estimatedMinutes: t.estimatedMinutes,
          category: t.category,
        }));
      return {
        todayISO: snapshot.todayISO,
        nowTime24: minutesToTime24(snapshot.nowMinutes),
        targetDate,
        overlaps: report.overlaps,
        deadlineFindings: report.deadlineFindings,
        unscheduledTasks,
        days: report.days,
      };
    }

    case 'update_calendar_events': {
      const title =
        typeof argsRaw.title === 'string' && argsRaw.title.trim()
          ? argsRaw.title.trim().slice(0, 120)
          : 'Proposed schedule adjustment';
      const reason =
        typeof argsRaw.reason === 'string' && argsRaw.reason.trim()
          ? argsRaw.reason.trim().slice(0, 320)
          : 'Optimizes your open slots without conflicts.';
      const tradeOffs =
        typeof argsRaw.tradeOffs === 'string' && argsRaw.tradeOffs.trim()
          ? argsRaw.tradeOffs.trim().slice(0, 200)
          : 'Minimal trade-off';
      const beforePreview =
        typeof argsRaw.beforePreview === 'string' && argsRaw.beforePreview.trim()
          ? argsRaw.beforePreview.trim().slice(0, 240)
          : 'Current schedule';
      const afterPreview =
        typeof argsRaw.afterPreview === 'string' && argsRaw.afterPreview.trim()
          ? argsRaw.afterPreview.trim().slice(0, 240)
          : title;

      const rawChanges = Array.isArray(argsRaw.changes) ? argsRaw.changes.slice(0, 6) : [];
      if (rawChanges.length === 0) {
        return { accepted: false, error: 'At least one change entry is required.' };
      }

      const activityMap = new Map(validActivities.map((a) => [a.id, a]));
      const taskMap = new Map(sanitizedTasks.map((t) => [t.id, t]));
      const normalizedChanges: ScheduleEnhancementChange[] = [];

      for (const rawCh of rawChanges) {
        if (!rawCh || typeof rawCh !== 'object') {
          return { accepted: false, error: 'Invalid change item.' };
        }
        const ch = rawCh as Record<string, unknown>;
        if (ch.type === 'reschedule_activity') {
          const activityId = typeof ch.activityId === 'string' ? ch.activityId.trim() : '';
          const act = activityMap.get(activityId);
          if (!act) {
            return { accepted: false, error: `Unknown activityId "${activityId}".` };
          }
          const occurrenceDate = typeof ch.occurrenceDate === 'string' ? ch.occurrenceDate.trim() : '';
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
        } else if (ch.type === 'schedule_task') {
          const taskId = typeof ch.taskId === 'string' ? ch.taskId.trim() : '';
          const task = taskMap.get(taskId);
          if (!task) {
            return { accepted: false, error: `Unknown taskId "${taskId}".` };
          }
          normalizedChanges.push({
            type: 'schedule_task',
            taskId,
            taskTitle: task.title,
            date: typeof ch.date === 'string' ? ch.date.trim() : '',
            startTime: typeof ch.startTime === 'string' ? ch.startTime.trim() : '',
            endTime: typeof ch.endTime === 'string' ? ch.endTime.trim() : '',
          });
        } else if (ch.type === 'insert_break') {
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
          return { accepted: false, error: `Unsupported change type "${String(ch.type)}".` };
        }
      }

      for (const ch of normalizedChanges) {
        const validation = validateSingleChangeCandidate(ch, {
          activities: validActivities,
          tasks: sanitizedTasks,
          todayISO: snapshot.todayISO,
          nowMinutes: snapshot.nowMinutes,
          siblingChanges: normalizedChanges,
        });
        if (!validation.valid) {
          return { accepted: false, error: validation.error };
        }
      }

      const proposalId = `eku-sched-${Date.now()}-${ctx.proposals.length + 1}`;
      ctx.proposals.push({
        id: proposalId,
        kind: 'schedule_changes',
        title,
        reason,
        tradeOffs,
        beforePreview,
        afterPreview,
        changes: normalizedChanges,
        status: 'pending',
      });

      return {
        accepted: true,
        proposalId,
        status: 'awaiting_user_confirmation',
        changesCount: normalizedChanges.length,
      };
    }

    case 'create_study_task': {
      const title = typeof argsRaw.title === 'string' ? argsRaw.title.trim().slice(0, 120) : '';
      if (!title) {
        return { accepted: false, error: 'Task title cannot be empty.' };
      }
      const dueDate =
        typeof argsRaw.dueDate === 'string' && isValidIsoDate(argsRaw.dueDate)
          ? argsRaw.dueDate
          : null;
      const priority: PriorityLevel =
        typeof argsRaw.priority === 'string' && ALLOWED_PRIORITIES.has(argsRaw.priority as PriorityLevel)
          ? (argsRaw.priority as PriorityLevel)
          : 'medium';
      const category: ActivityCategory =
        typeof argsRaw.category === 'string' && ALLOWED_CATEGORIES.has(argsRaw.category as ActivityCategory)
          ? (argsRaw.category as ActivityCategory)
          : 'Study';
      const estimatedMinutes =
        typeof argsRaw.estimatedMinutes === 'number' && Number.isFinite(argsRaw.estimatedMinutes)
          ? Math.max(10, Math.min(480, Math.round(argsRaw.estimatedMinutes)))
          : 45;

      const proposalId = `eku-task-${Date.now()}-${ctx.proposals.length + 1}`;
      ctx.proposals.push({
        id: proposalId,
        kind: 'create_task',
        title: `Add task: ${title}`,
        taskTitle: title,
        dueDate,
        priority,
        category,
        estimatedMinutes,
        status: 'pending',
      });

      return {
        accepted: true,
        proposalId,
        status: 'awaiting_user_confirmation',
        taskTitle: title,
      };
    }

    case 'start_focus_session': {
      const durationMinutes =
        typeof argsRaw.durationMinutes === 'number' && Number.isFinite(argsRaw.durationMinutes)
          ? Math.max(5, Math.min(180, Math.round(argsRaw.durationMinutes)))
          : 25;
      const mode: FocusModeType =
        argsRaw.mode === 'short_break' || argsRaw.mode === 'long_break'
          ? argsRaw.mode
          : 'focus';
      const activityId =
        typeof argsRaw.activityId === 'string' && argsRaw.activityId.trim()
          ? validActivities.find((a) => a.id === argsRaw.activityId)?.id ?? null
          : null;
      const activityTitle = activityId
        ? validActivities.find((a) => a.id === activityId)?.title ?? null
        : null;

      ctx.focusActions.push({
        type: 'start_focus',
        mode,
        durationMinutes,
        activityId,
        activityTitle,
      });

      return {
        started: true,
        mode,
        durationMinutes,
        activityTitle,
      };
    }

    case 'pause_focus_session': {
      if (snapshot.focusSummary.timerStatus !== 'running') {
        return { paused: false, message: 'No focus session is currently running.' };
      }
      ctx.focusActions.push({
        type: 'pause_focus',
        mode: snapshot.focusSummary.timerMode,
        durationMinutes: snapshot.focusSummary.remainingMinutes,
        activityId: null,
        activityTitle: snapshot.focusSummary.linkedActivityTitle,
      });
      return { paused: true };
    }

    case 'create_reminder': {
      const reminderTitle =
        typeof argsRaw.title === 'string' ? argsRaw.title.trim().slice(0, 120) : '';
      if (!reminderTitle) {
        return { accepted: false, error: 'Reminder title is required.' };
      }
      const date = isValidIsoDate(argsRaw.date) ? argsRaw.date : snapshot.todayISO;
      const time = isValidTime24(argsRaw.time) ? argsRaw.time : '';
      const startMin = toStrictMinutes(time);
      if (startMin === null) {
        return { accepted: false, error: 'Reminder time must be valid 24-hour HH:mm.' };
      }
      if (date < snapshot.todayISO) {
        return { accepted: false, error: 'Cannot set a reminder on a past date.' };
      }
      if (date === snapshot.todayISO && startMin < snapshot.nowMinutes) {
        return { accepted: false, error: 'That time has already passed today.' };
      }

      const durationMinutes =
        typeof argsRaw.durationMinutes === 'number' && Number.isFinite(argsRaw.durationMinutes)
          ? Math.max(15, Math.min(180, Math.round(argsRaw.durationMinutes)))
          : 30;
      const endMin = Math.min(23 * 60 + 55, startMin + durationMinutes);
      const endTime = minutesToTime24(endMin);
      const category: ActivityCategory =
        typeof argsRaw.category === 'string' && ALLOWED_CATEGORIES.has(argsRaw.category as ActivityCategory)
          ? (argsRaw.category as ActivityCategory)
          : 'Study';
      const priority: PriorityLevel =
        typeof argsRaw.priority === 'string' && ALLOWED_PRIORITIES.has(argsRaw.priority as PriorityLevel)
          ? (argsRaw.priority as PriorityLevel)
          : 'high';

      const existing = resolveActivitiesForDate(validActivities, date).filter(
        (a) => a.status !== 'skipped'
      );
      const candidateResolved = {
        instanceId: 'reminder-preview',
        activityId: 'reminder-preview',
        occurrenceDate: date,
        title: reminderTitle,
        description: '',
        startTime: time,
        endTime,
        category,
        color: 'indigo' as const,
        priority,
        status: 'pending' as const,
        linkedTaskId: null,
        isRecurring: false,
        recurrence: { frequency: 'none' as const, endDate: null },
        hasOverride: false,
      };
      const overlaps = detectConflicts([...existing, candidateResolved]).filter(
        (c) =>
          c.first.activityId === 'reminder-preview' || c.second.activityId === 'reminder-preview'
      );
      const conflictWarning =
        overlaps.length > 0
          ? `Overlaps with "${
              overlaps[0].first.activityId === 'reminder-preview'
                ? overlaps[0].second.title
                : overlaps[0].first.title
            }".`
          : null;

      const proposalId = `eku-rem-${Date.now()}-${ctx.proposals.length + 1}`;
      ctx.proposals.push({
        id: proposalId,
        kind: 'create_reminder',
        title: `Reminder: ${reminderTitle}`,
        reminderTitle,
        date,
        startTime: time,
        endTime,
        category,
        priority,
        hasConflictWarning: conflictWarning,
        status: 'pending',
      });

      return {
        accepted: true,
        proposalId,
        status: 'awaiting_user_confirmation',
        date,
        startTime: time,
        endTime,
        conflictWarning,
      };
    }

    case 'get_study_progress': {
      const todayActivities = resolveActivitiesForDate(validActivities, snapshot.todayISO);
      const pendingToday = todayActivities.filter((a) => a.status === 'pending');
      const completedToday = todayActivities.filter((a) => a.status === 'completed');

      const activeNow = pendingToday.find((a) => {
        const s = parseTimeToMinutes(a.startTime);
        const e = parseTimeToMinutes(a.endTime);
        return snapshot.nowMinutes >= s && snapshot.nowMinutes < e;
      });
      const nextActivity =
        activeNow ??
        pendingToday.find((a) => parseTimeToMinutes(a.endTime) > snapshot.nowMinutes) ??
        null;

      const openTasks = sanitizedTasks.filter((t) => !t.completed);
      const completedTasks = sanitizedTasks.filter((t) => t.completed);
      const overdueTasks = openTasks.filter(
        (t) => t.dueDate !== null && t.dueDate < snapshot.todayISO
      );
      const nextPriorityTask = [...openTasks].sort((a, b) => {
        const rank = { high: 0, medium: 1, low: 2 };
        return rank[a.priority] - rank[b.priority];
      })[0] ?? null;

      return {
        todayISO: snapshot.todayISO,
        nowTime24: minutesToTime24(snapshot.nowMinutes),
        todayActivitiesTotal: todayActivities.length,
        todayActivitiesCompleted: completedToday.length,
        activeOrNextActivity: nextActivity
          ? {
              title: nextActivity.title,
              startTime: nextActivity.startTime,
              endTime: nextActivity.endTime,
              category: nextActivity.category,
              happeningNow: nextActivity === activeNow,
            }
          : null,
        openTasksCount: openTasks.length,
        completedTasksCount: completedTasks.length,
        overdueTasksCount: overdueTasks.length,
        nextPriorityTask: nextPriorityTask
          ? {
              title: nextPriorityTask.title,
              priority: nextPriorityTask.priority,
              dueDate: nextPriorityTask.dueDate,
              estimatedMinutes: nextPriorityTask.estimatedMinutes,
            }
          : null,
        focusSummary: snapshot.focusSummary,
      };
    }

    case 'search_learning_resources': {
      const topic = typeof argsRaw.topic === 'string' ? argsRaw.topic : '';
      const argLang = normalizeLanguageName(
        typeof argsRaw.preferredLanguage === 'string' ? argsRaw.preferredLanguage : null
      );
      const effectiveLanguage = argLang ?? snapshot.preferredLanguage;
      if (argLang) {
        ctx.detectedPreferredLanguage = argLang;
      }

      const result = await executeResourceSearch({
        topic,
        preferredLanguage: effectiveLanguage,
        includePdfs: typeof argsRaw.includePdfs === 'boolean' ? argsRaw.includePdfs : true,
        includeVideos: typeof argsRaw.includeVideos === 'boolean' ? argsRaw.includeVideos : true,
        allowFallbackPdfLanguage: Boolean(argsRaw.allowFallbackPdfLanguage),
      });

      if (result.resources.length > 0) {
        ctx.resources = result.resources;
      }
      if (result.languageNotice) {
        ctx.languageNotice = result.languageNotice;
      }
      return result;
    }

    default:
      return { error: `Unknown tool "${name}".` };
  }
}

function extractOpenAIReplyText(resp: OpenAIResponsesApiResponse): string {
  if (typeof resp.output_text === 'string' && resp.output_text.trim()) {
    return resp.output_text.trim();
  }
  const parts: string[] = [];
  for (const item of resp.output ?? []) {
    if (item.type === 'message') {
      const msg = item as OpenAIResponsesOutputMessage;
      for (const block of msg.content ?? []) {
        if (typeof block.text === 'string' && block.text.trim()) {
          parts.push(block.text.trim());
        }
      }
    }
  }
  return parts.join('\n\n').trim();
}

export async function runEkuConversationTurn(
  reqData: EkuChatRequestBody
): Promise<EkuChatResponseBody> {
  const openai = getOpenAIConfig();
  if (!openai.configured) {
    const err = new Error(
      'OpenAI API key is not configured on this server. Add OPENAI_API_KEY in Settings > Secrets to enable Eku.'
    ) as Error & { status?: number };
    err.status = 503;
    throw err;
  }

  const { snapshot } = reqData;
  const { valid: validActivities } = sanitizeActivitiesForAnalysis(snapshot.activities);
  const sanitizedTasks: TaskItem[] = snapshot.tasks.map((t) => ({
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

  const tomorrowISO = shiftDateISO(snapshot.todayISO, 1);
  const instructions = [
    'You are Eku, the friendly, concise, intelligent study companion robot inside EKAGRA.',
    `Current local date: ${snapshot.todayISO} (tomorrow is ${tomorrowISO}), current local time: ${minutesToTime24(snapshot.nowMinutes)}, timezone: ${snapshot.timeZone}.`,
    `Saved preferred learning resource language: ${snapshot.preferredLanguage ?? 'not set yet'}.`,
    '',
    'CORE RULES:',
    '1. Always use EKAGRA tools to read real schedule events, tasks, study progress, focus state, or educational resources — NEVER invent events, links, or progress numbers.',
    '2. When a student asks to optimize or organize their schedule (e.g. "manage my best possible schedule for tomorrow"):',
    '   - First call propose_optimized_schedule (and/or detect_schedule_conflicts) to inspect real fixed vs flexible blocks, deadlines, open slots, and break gaps.',
    '   - Then call update_calendar_events with valid conflict-free future-time changes so the student gets an interactive approval card. NEVER claim changes are already saved before user approval.',
    '3. When asked to add a task or reminder (e.g. "Remind me to revise Java at 8 PM"), call create_study_task or create_reminder so the student can confirm before saving.',
    '4. When asked to start or pause a focus timer ("Start a 45-minute focus session"), call start_focus_session or pause_focus_session directly.',
    '5. RESOURCE SEARCH RULES:',
    '   - If the student asks for learning resources and preferredLanguage is "not set yet" AND their prompt does not state a language, call search_learning_resources with preferredLanguage: null (or ask them directly which language they prefer first).',
    '   - Only return links returned by search_learning_resources; NEVER invent URLs or describe unverified spoken audio language as guaranteed.',
    '   - If languageNotice reports missingPdfInRequestedLanguage, present the videos/resources found in that language and explicitly ask whether they want an alternative-language (e.g., English) PDF instead.',
    '6. Keep replies clear, encouraging, concise (easy to read in a compact floating chat drawer and natural if spoken aloud). Do not dump raw markdown links if resource cards already show them cleanly.',
  ].join('\n');

  const inputMessages = [
    ...reqData.history.map((h) => ({
      role: h.role,
      content: h.content,
    })),
    {
      role: 'user' as const,
      content: reqData.message,
    },
  ];

  const ctx: ExecutionContext = {
    snapshot,
    validActivities,
    sanitizedTasks,
    proposals: [],
    focusActions: [],
    resources: [],
    languageNotice: null,
    detectedPreferredLanguage: null,
  };

  let previousResponseId: string | undefined;
  let nextInput: unknown = inputMessages;
  let finalReply = '';

  for (let step = 0; step < 5; step++) {
    const bodyPayload: Record<string, unknown> = {
      model: openai.model,
      instructions,
      input: nextInput,
      tools: EKU_TOOLS,
      tool_choice: 'auto',
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openai.apiKey}`,
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(20_000),
    });

    const json = (await response.json().catch(() => ({}))) as OpenAIResponsesApiResponse;

    if (!response.ok) {
      const upstreamMsg = json?.error?.message || `OpenAI API returned HTTP ${response.status}`;
      const err = new Error(
        response.status === 401 || response.status === 403
          ? 'OpenAI API authentication failed on the server. Verify OPENAI_API_KEY configuration.'
          : response.status === 429
          ? 'OpenAI rate limit reached. Please wait a moment and try again.'
          : upstreamMsg
      ) as Error & { status?: number };
      err.status = response.status === 401 || response.status === 403 ? 403 : response.status >= 400 ? response.status : 502;
      throw err;
    }

    previousResponseId = json.id;
    const toolCalls = (json.output ?? []).filter(
      (item): item is OpenAIResponsesToolCall =>
        item.type === 'function_call' &&
        typeof (item as OpenAIResponsesToolCall).call_id === 'string' &&
        typeof (item as OpenAIResponsesToolCall).name === 'string'
    );

    if (toolCalls.length === 0) {
      finalReply = extractOpenAIReplyText(json);
      break;
    }

    const toolOutputs: Array<{
      type: 'function_call_output';
      call_id: string;
      output: string;
    }> = [];

    for (const tc of toolCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(tc.arguments || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedArgs = parsed as Record<string, unknown>;
        }
      } catch {
        parsedArgs = {};
      }
      const toolResult = await runToolCall(tc.name, parsedArgs, ctx);
      toolOutputs.push({
        type: 'function_call_output',
        call_id: tc.call_id,
        output: JSON.stringify(toolResult),
      });
    }

    nextInput = toolOutputs;
  }

  if (!finalReply) {
    finalReply =
      ctx.proposals.length > 0
        ? 'I prepared a schedule proposal below for your approval.'
        : ctx.resources.length > 0
        ? 'Here are the verified study resources I found for you.'
        : ctx.focusActions.length > 0
        ? 'Done — your focus timer has been updated.'
        : 'I processed your request, but did not receive a complete summary. Please try asking again.';
  }

  return {
    reply: finalReply,
    emotion:
      ctx.proposals.length > 0 || ctx.focusActions.length > 0 ? 'success' : 'speaking',
    proposals: ctx.proposals,
    focusActions: ctx.focusActions,
    resources: ctx.resources,
    languageNotice: ctx.languageNotice,
    detectedPreferredLanguage: ctx.detectedPreferredLanguage,
  };
}
