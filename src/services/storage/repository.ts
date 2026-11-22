import {
  ActiveTimerState,
  ActivityCategory,
  AppSettings,
  DayFlowState,
  FocusSession,
  HabitItem,
  QuickNote,
  ScheduleActivity,
  StudyQuotation,
  TaskItem,
} from '../../types/dayflow';
import { generateId, getTodayISO, shiftDateISO } from '../../utils/dateTime';
import { normalizeThemeMode } from '../../utils/theme';

export const STORAGE_KEY = 'dayflow_app_state_v1';
export const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: AppSettings = {
  userName: 'Alex',
  theme: 'paper',
  timeFormat: '12h',
  weekStart: 'monday',
  defaultFocusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  soundAlerts: true,
  notificationsEnabled: false,
  reminderLeadMinutes: 10,
  dailyCapacityHours: 8,
  preferredMusicUrl: null,
};

export const DEFAULT_ACTIVE_TIMER: ActiveTimerState = {
  mode: 'focus',
  status: 'idle',
  durationSeconds: 25 * 60,
  startedAtMs: null,
  elapsedBeforePauseMs: 0,
  linkedActivityId: null,
};

export interface IDataRepository {
  load(): { state: DayFlowState; recoveredFromCorruption: boolean };
  save(state: DayFlowState): void;
  exportJSON(state: DayFlowState): string;
  parseAndValidateImport(rawJson: string): DayFlowState;
  clear(): DayFlowState;
}

export function createEmptyState(settingsOverride?: Partial<AppSettings>): DayFlowState {
  const settings = { ...DEFAULT_SETTINGS, ...settingsOverride };
  return {
    version: CURRENT_SCHEMA_VERSION,
    tasks: [],
    activities: [],
    focusSessions: [],
    activeTimer: {
      ...DEFAULT_ACTIVE_TIMER,
      durationSeconds: settings.defaultFocusMinutes * 60,
    },
    habits: [],
    habitLogs: {},
    notes: [],
    quotations: [],
    importedFingerprints: [],
    settings,
  };
}

export function createSeedState(): DayFlowState {
  const today = getTodayISO();
  const yesterday = shiftDateISO(today, -1);
  const twoDaysAgo = shiftDateISO(today, -2);
  const threeDaysAgo = shiftDateISO(today, -3);
  const fourDaysAgo = shiftDateISO(today, -4);
  const fiveDaysAgo = shiftDateISO(today, -5);
  const sixDaysAgo = shiftDateISO(today, -6);
  const tomorrow = shiftDateISO(today, 1);
  const nextWeek = shiftDateISO(today, 4);
  const nowISO = new Date().toISOString();

  const codingId = generateId();
  const jecaId = generateId();
  const englishId = generateId();
  const exerciseId = generateId();
  const morningId = generateId();
  const readingId = generateId();

  const activities: ScheduleActivity[] = [
    {
      id: morningId,
      title: 'Morning routine',
      description: 'Hydration, light stretching, and reviewing the daily plan.',
      date: sixDaysAgo,
      startTime: '07:00',
      endTime: '07:45',
      category: 'Personal',
      color: 'amber',
      priority: 'medium',
      status: 'pending',
      linkedTaskId: null,
      recurrence: { frequency: 'daily', endDate: null },
      excludedDates: [],
      occurrenceOverrides: {
        [yesterday]: { status: 'completed' },
        [twoDaysAgo]: { status: 'completed' },
      },
      createdAt: nowISO,
      updatedAt: nowISO,
    },
    {
      id: codingId,
      title: 'Coding practice',
      description: 'Data structures, algorithms, and TypeScript component architecture.',
      date: sixDaysAgo,
      startTime: '09:00',
      endTime: '10:30',
      category: 'Work',
      color: 'indigo',
      priority: 'high',
      status: 'pending',
      linkedTaskId: null,
      recurrence: { frequency: 'weekdays', endDate: null },
      excludedDates: [],
      occurrenceOverrides: {
        [yesterday]: { status: 'completed' },
        [twoDaysAgo]: { status: 'completed' },
      },
      createdAt: nowISO,
      updatedAt: nowISO,
    },
    {
      id: jecaId,
      title: 'JECA preparation',
      description: 'Focused problem solving on C, OS concepts, and quantitative aptitude.',
      date: sixDaysAgo,
      startTime: '11:00',
      endTime: '13:00',
      category: 'Study',
      color: 'sky',
      priority: 'high',
      status: 'pending',
      linkedTaskId: null,
      recurrence: { frequency: 'weekdays', endDate: null },
      excludedDates: [],
      occurrenceOverrides: {
        [yesterday]: { status: 'completed' },
      },
      createdAt: nowISO,
      updatedAt: nowISO,
    },
    {
      id: englishId,
      title: 'English speaking',
      description: 'Structured conversation drills, clarity practice, and vocabulary notes.',
      date: sixDaysAgo,
      startTime: '15:00',
      endTime: '16:00',
      category: 'Study',
      color: 'violet',
      priority: 'medium',
      status: 'pending',
      linkedTaskId: null,
      recurrence: { frequency: 'daily', endDate: null },
      excludedDates: [],
      occurrenceOverrides: {
        [yesterday]: { status: 'completed' },
      },
      createdAt: nowISO,
      updatedAt: nowISO,
    },
    {
      id: exerciseId,
      title: 'Exercise',
      description: 'Strength & mobility session followed by a 20-minute cooldown walk.',
      date: sixDaysAgo,
      startTime: '18:00',
      endTime: '19:00',
      category: 'Health',
      color: 'emerald',
      priority: 'high',
      status: 'pending',
      linkedTaskId: null,
      recurrence: { frequency: 'daily', endDate: null },
      excludedDates: [],
      occurrenceOverrides: {
        [yesterday]: { status: 'completed' },
        [twoDaysAgo]: { status: 'completed' },
      },
      createdAt: nowISO,
      updatedAt: nowISO,
    },
    {
      id: readingId,
      title: 'Reading',
      description: 'Uninterrupted technical or non-fiction reading before winding down.',
      date: sixDaysAgo,
      startTime: '21:00',
      endTime: '22:00',
      category: 'Personal',
      color: 'slate',
      priority: 'low',
      status: 'pending',
      linkedTaskId: null,
      recurrence: { frequency: 'daily', endDate: null },
      excludedDates: [],
      occurrenceOverrides: {
        [twoDaysAgo]: { status: 'completed' },
      },
      createdAt: nowISO,
      updatedAt: nowISO,
    },
  ];

  const tasks: TaskItem[] = [
    {
      id: generateId(),
      title: 'Solve 15 dynamic programming problems',
      description: 'Focus on memoization patterns and state transitions.',
      priority: 'high',
      dueDate: today,
      category: 'Study',
      completed: false,
      completedAt: null,
      estimatedMinutes: 60,
      scheduledActivityId: codingId,
      createdAt: nowISO,
      updatedAt: nowISO,
    },
    {
      id: generateId(),
      title: 'Review OS virtual memory & paging notes',
      description: 'Summarize page replacement algorithms and solve mock questions.',
      priority: 'high',
      dueDate: today,
      category: 'Study',
      completed: false,
      completedAt: null,
      estimatedMinutes: 45,
      scheduledActivityId: null,
      createdAt: nowISO,
      updatedAt: nowISO,
    },
    {
      id: generateId(),
      title: 'Refactor portfolio project API client',
      description: 'Extract storage interface and add strict TypeScript response guards.',
      priority: 'medium',
      dueDate: tomorrow,
      category: 'Work',
      completed: false,
      completedAt: null,
      estimatedMinutes: 60,
      scheduledActivityId: null,
      createdAt: nowISO,
      updatedAt: nowISO,
    },
    {
      id: generateId(),
      title: 'Take full-length JECA practice paper',
      description: 'Timed 2-hour simulation under exam conditions.',
      priority: 'high',
      dueDate: nextWeek,
      category: 'Study',
      completed: false,
      completedAt: null,
      estimatedMinutes: 120,
      scheduledActivityId: null,
      createdAt: nowISO,
      updatedAt: nowISO,
    },
    {
      id: generateId(),
      title: 'Organize weekly desk & backup study notes',
      description: 'Export JSON backup and archive completed weekly checklists.',
      priority: 'low',
      dueDate: today,
      category: 'Admin',
      completed: true,
      completedAt: nowISO,
      estimatedMinutes: 20,
      scheduledActivityId: null,
      createdAt: yesterday,
      updatedAt: nowISO,
    },
  ];

  const habit1 = generateId();
  const habit2 = generateId();
  const habit3 = generateId();
  const habit4 = generateId();

  const habits: HabitItem[] = [
    {
      id: habit1,
      title: 'Morning planning & hydration',
      description: 'Review day blocks before 8 AM with a full glass of water.',
      frequency: 'daily',
      targetPerWeek: 7,
      category: 'Personal',
      color: 'amber',
      createdAt: sixDaysAgo,
    },
    {
      id: habit2,
      title: '90 min uninterrupted deep work',
      description: 'At least one distraction-free study or coding block.',
      frequency: 'daily',
      targetPerWeek: 7,
      category: 'Deep Focus',
      color: 'indigo',
      createdAt: sixDaysAgo,
    },
    {
      id: habit3,
      title: 'Evening physical exercise',
      description: '45+ minutes of strength, cardio, or mobility training.',
      frequency: 'daily',
      targetPerWeek: 7,
      category: 'Health',
      color: 'emerald',
      createdAt: sixDaysAgo,
    },
    {
      id: habit4,
      title: 'Weekly retrospective & review',
      description: 'Audit unfinished tasks and set next week priorities.',
      frequency: 'weekly',
      targetPerWeek: 2,
      category: 'Admin',
      color: 'sky',
      createdAt: sixDaysAgo,
    },
  ];

  const habitLogs: Record<string, string[]> = {
    [sixDaysAgo]: [habit1, habit2, habit3],
    [fiveDaysAgo]: [habit1, habit2, habit4],
    [fourDaysAgo]: [habit1, habit3],
    [threeDaysAgo]: [habit1, habit2, habit3],
    [twoDaysAgo]: [habit1, habit2, habit3],
    [yesterday]: [habit1, habit2, habit3, habit4],
  };

  const focusSessions: FocusSession[] = [
    {
      id: generateId(),
      activityId: codingId,
      activityTitle: 'Coding practice',
      category: 'Work',
      mode: 'focus',
      plannedMinutes: 50,
      actualMinutes: 50,
      startedAt: `${fiveDaysAgo}T09:05:00.000Z`,
      endedAt: `${fiveDaysAgo}T09:55:00.000Z`,
      date: fiveDaysAgo,
      completed: true,
    },
    {
      id: generateId(),
      activityId: jecaId,
      activityTitle: 'JECA preparation',
      category: 'Study',
      mode: 'focus',
      plannedMinutes: 60,
      actualMinutes: 60,
      startedAt: `${fourDaysAgo}T11:00:00.000Z`,
      endedAt: `${fourDaysAgo}T12:00:00.000Z`,
      date: fourDaysAgo,
      completed: true,
    },
    {
      id: generateId(),
      activityId: codingId,
      activityTitle: 'Coding practice',
      category: 'Work',
      mode: 'focus',
      plannedMinutes: 45,
      actualMinutes: 45,
      startedAt: `${threeDaysAgo}T09:15:00.000Z`,
      endedAt: `${threeDaysAgo}T10:00:00.000Z`,
      date: threeDaysAgo,
      completed: true,
    },
    {
      id: generateId(),
      activityId: jecaId,
      activityTitle: 'JECA preparation',
      category: 'Study',
      mode: 'focus',
      plannedMinutes: 50,
      actualMinutes: 50,
      startedAt: `${twoDaysAgo}T11:10:00.000Z`,
      endedAt: `${twoDaysAgo}T12:00:00.000Z`,
      date: twoDaysAgo,
      completed: true,
    },
    {
      id: generateId(),
      activityId: englishId,
      activityTitle: 'English speaking',
      category: 'Study',
      mode: 'focus',
      plannedMinutes: 30,
      actualMinutes: 30,
      startedAt: `${yesterday}T15:00:00.000Z`,
      endedAt: `${yesterday}T15:30:00.000Z`,
      date: yesterday,
      completed: true,
    },
    {
      id: generateId(),
      activityId: codingId,
      activityTitle: 'Coding practice',
      category: 'Work',
      mode: 'focus',
      plannedMinutes: 60,
      actualMinutes: 60,
      startedAt: `${yesterday}T09:00:00.000Z`,
      endedAt: `${yesterday}T10:00:00.000Z`,
      date: yesterday,
      completed: true,
    },
  ];

  const notes: QuickNote[] = [
    {
      id: generateId(),
      title: 'DP state transition checklist',
      content: 'Define base case first, then verify subproblem ordering before writing memoization.',
      category: 'Study',
      linkedTaskId: tasks[0].id,
      linkedActivityId: codingId,
      linkedFocusSessionId: null,
      createdAt: nowISO,
      updatedAt: nowISO,
    },
  ];

  const quotations: StudyQuotation[] = [
    {
      id: generateId(),
      text: 'Amortized analysis measures the average cost per operation over a worst-case sequence of operations, not an average input.',
      sourceFile: 'Algorithms_Notes.pdf',
      pageNumber: 14,
      category: 'Study',
      dateCaptured: yesterday,
      createdAt: nowISO,
    },
  ];

  return {
    version: CURRENT_SCHEMA_VERSION,
    tasks,
    activities,
    focusSessions,
    activeTimer: { ...DEFAULT_ACTIVE_TIMER },
    habits,
    habitLogs,
    notes,
    quotations,
    importedFingerprints: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function sanitizeCategoryValue(val: unknown): ActivityCategory {
  if (
    val === 'Work' ||
    val === 'Study' ||
    val === 'Health' ||
    val === 'Personal' ||
    val === 'Deep Focus' ||
    val === 'Admin'
  ) {
    return val;
  }
  return 'Study';
}

function validateAndSanitizeState(raw: unknown): DayFlowState {
  if (!isObject(raw)) {
    throw new Error('Root storage payload must be a JSON object.');
  }

  if (
    !Array.isArray(raw.tasks) ||
    !Array.isArray(raw.activities) ||
    !Array.isArray(raw.focusSessions) ||
    !Array.isArray(raw.habits) ||
    !isObject(raw.habitLogs) ||
    !isObject(raw.settings)
  ) {
    throw new Error('Backup data is missing required DayFlow collections.');
  }

  const validTasks: TaskItem[] = raw.tasks
    .filter((t): t is TaskItem => isObject(t) && typeof t.id === 'string' && typeof t.title === 'string')
    .map((t) => ({
      id: t.id,
      title: t.title,
      description: typeof t.description === 'string' ? t.description : '',
      priority: t.priority === 'low' || t.priority === 'medium' || t.priority === 'high' ? t.priority : 'medium',
      dueDate: typeof t.dueDate === 'string' ? t.dueDate : null,
      category: sanitizeCategoryValue(t.category),
      completed: Boolean(t.completed),
      completedAt: typeof t.completedAt === 'string' ? t.completedAt : null,
      estimatedMinutes: typeof t.estimatedMinutes === 'number' && t.estimatedMinutes > 0 ? t.estimatedMinutes : 30,
      scheduledActivityId: typeof t.scheduledActivityId === 'string' ? t.scheduledActivityId : null,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date().toISOString(),
    }));

  const validActivities: ScheduleActivity[] = raw.activities
    .filter(
      (a): a is ScheduleActivity =>
        isObject(a) &&
        typeof a.id === 'string' &&
        typeof a.title === 'string' &&
        typeof a.date === 'string' &&
        typeof a.startTime === 'string' &&
        typeof a.endTime === 'string'
    )
    .map((a) => ({
      ...a,
      description: typeof a.description === 'string' ? a.description : '',
      category: sanitizeCategoryValue(a.category),
      color: typeof a.color === 'string' ? a.color : 'indigo',
      priority: a.priority === 'low' || a.priority === 'medium' || a.priority === 'high' ? a.priority : 'medium',
      status: a.status === 'completed' || a.status === 'skipped' || a.status === 'pending' ? a.status : 'pending',
      linkedTaskId: typeof a.linkedTaskId === 'string' ? a.linkedTaskId : null,
      recurrence: isObject(a.recurrence)
        ? {
            frequency:
              a.recurrence.frequency === 'daily' ||
              a.recurrence.frequency === 'weekdays' ||
              a.recurrence.frequency === 'weekends' ||
              a.recurrence.frequency === 'custom_weekdays' ||
              a.recurrence.frequency === 'weekly'
                ? a.recurrence.frequency
                : 'none',
            daysOfWeek: Array.isArray(a.recurrence.daysOfWeek) ? a.recurrence.daysOfWeek : undefined,
            endDate: typeof a.recurrence.endDate === 'string' ? a.recurrence.endDate : null,
          }
        : { frequency: 'none', endDate: null },
      excludedDates: Array.isArray(a.excludedDates) ? a.excludedDates : [],
      occurrenceOverrides: isObject(a.occurrenceOverrides) ? a.occurrenceOverrides : {},
      createdAt: typeof a.createdAt === 'string' ? a.createdAt : new Date().toISOString(),
      updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : new Date().toISOString(),
    }));

  const validSessions: FocusSession[] = raw.focusSessions
    .filter(
      (s): s is FocusSession =>
        isObject(s) &&
        typeof s.id === 'string' &&
        typeof s.date === 'string' &&
        typeof s.actualMinutes === 'number'
    )
    .map((s) => ({
      ...s,
      reflection: typeof s.reflection === 'string' ? s.reflection : null,
    }));

  const validHabits: HabitItem[] = raw.habits.filter(
    (h): h is HabitItem => isObject(h) && typeof h.id === 'string' && typeof h.title === 'string'
  );

  const validHabitLogs: Record<string, string[]> = {};
  for (const [dateKey, list] of Object.entries(raw.habitLogs)) {
    if (Array.isArray(list)) {
      validHabitLogs[dateKey] = list.filter((id): id is string => typeof id === 'string');
    }
  }

  // Backward-compatible optional collections (notes, quotations, importedFingerprints)
  const validNotes: QuickNote[] = Array.isArray(raw.notes)
    ? raw.notes
        .filter((n): n is QuickNote => isObject(n) && typeof n.id === 'string' && typeof n.content === 'string')
        .map((n) => ({
          id: n.id,
          title: typeof n.title === 'string' ? n.title : '',
          content: n.content,
          category: sanitizeCategoryValue(n.category),
          linkedTaskId: typeof n.linkedTaskId === 'string' ? n.linkedTaskId : null,
          linkedActivityId: typeof n.linkedActivityId === 'string' ? n.linkedActivityId : null,
          linkedFocusSessionId: typeof n.linkedFocusSessionId === 'string' ? n.linkedFocusSessionId : null,
          sourceQuotationId: typeof n.sourceQuotationId === 'string' ? n.sourceQuotationId : null,
          createdAt: typeof n.createdAt === 'string' ? n.createdAt : new Date().toISOString(),
          updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : new Date().toISOString(),
        }))
    : [];

  const validQuotations: StudyQuotation[] = Array.isArray(raw.quotations)
    ? raw.quotations
        .filter((q): q is StudyQuotation => isObject(q) && typeof q.id === 'string' && typeof q.text === 'string')
        .map((q) => ({
          id: q.id,
          text: q.text,
          sourceFile: typeof q.sourceFile === 'string' ? q.sourceFile : 'Imported PDF',
          pageNumber: typeof q.pageNumber === 'number' ? q.pageNumber : null,
          category: sanitizeCategoryValue(q.category),
          dateCaptured: typeof q.dateCaptured === 'string' ? q.dateCaptured : getTodayISO(),
          createdAt: typeof q.createdAt === 'string' ? q.createdAt : new Date().toISOString(),
        }))
    : [];

  const validFingerprints: string[] = Array.isArray(raw.importedFingerprints)
    ? raw.importedFingerprints.filter((f): f is string => typeof f === 'string')
    : [];

  const rawSettings = raw.settings as Partial<AppSettings>;
  const settings: AppSettings = {
    userName: typeof rawSettings.userName === 'string' && rawSettings.userName.trim() ? rawSettings.userName : DEFAULT_SETTINGS.userName,
    theme: rawSettings.theme !== undefined ? normalizeThemeMode(rawSettings.theme) : DEFAULT_SETTINGS.theme,
    timeFormat: rawSettings.timeFormat === '12h' || rawSettings.timeFormat === '24h' ? rawSettings.timeFormat : DEFAULT_SETTINGS.timeFormat,
    weekStart: rawSettings.weekStart === 'monday' || rawSettings.weekStart === 'sunday' ? rawSettings.weekStart : DEFAULT_SETTINGS.weekStart,
    defaultFocusMinutes:
      typeof rawSettings.defaultFocusMinutes === 'number' && rawSettings.defaultFocusMinutes >= 5 && rawSettings.defaultFocusMinutes <= 180
        ? rawSettings.defaultFocusMinutes
        : DEFAULT_SETTINGS.defaultFocusMinutes,
    shortBreakMinutes:
      typeof rawSettings.shortBreakMinutes === 'number' && rawSettings.shortBreakMinutes >= 1 && rawSettings.shortBreakMinutes <= 60
        ? rawSettings.shortBreakMinutes
        : DEFAULT_SETTINGS.shortBreakMinutes,
    longBreakMinutes:
      typeof rawSettings.longBreakMinutes === 'number' && rawSettings.longBreakMinutes >= 5 && rawSettings.longBreakMinutes <= 90
        ? rawSettings.longBreakMinutes
        : DEFAULT_SETTINGS.longBreakMinutes,
    soundAlerts: typeof rawSettings.soundAlerts === 'boolean' ? rawSettings.soundAlerts : DEFAULT_SETTINGS.soundAlerts,
    notificationsEnabled:
      typeof rawSettings.notificationsEnabled === 'boolean' ? rawSettings.notificationsEnabled : DEFAULT_SETTINGS.notificationsEnabled,
    reminderLeadMinutes:
      rawSettings.reminderLeadMinutes === 0 ||
      rawSettings.reminderLeadMinutes === 5 ||
      rawSettings.reminderLeadMinutes === 10 ||
      rawSettings.reminderLeadMinutes === 15
        ? rawSettings.reminderLeadMinutes
        : DEFAULT_SETTINGS.reminderLeadMinutes,
    dailyCapacityHours:
      typeof rawSettings.dailyCapacityHours === 'number' && rawSettings.dailyCapacityHours >= 2 && rawSettings.dailyCapacityHours <= 16
        ? rawSettings.dailyCapacityHours
        : DEFAULT_SETTINGS.dailyCapacityHours,
    preferredMusicUrl:
      typeof rawSettings.preferredMusicUrl === 'string' && rawSettings.preferredMusicUrl.trim()
        ? rawSettings.preferredMusicUrl.trim()
        : null,
  };

  const rawTimer = isObject(raw.activeTimer) ? (raw.activeTimer as Partial<ActiveTimerState>) : {};
  const activeTimer: ActiveTimerState = {
    mode:
      rawTimer.mode === 'focus' || rawTimer.mode === 'short_break' || rawTimer.mode === 'long_break'
        ? rawTimer.mode
        : 'focus',
    status: rawTimer.status === 'running' || rawTimer.status === 'paused' || rawTimer.status === 'idle' ? rawTimer.status : 'idle',
    durationSeconds:
      typeof rawTimer.durationSeconds === 'number' && rawTimer.durationSeconds > 0
        ? rawTimer.durationSeconds
        : settings.defaultFocusMinutes * 60,
    startedAtMs: typeof rawTimer.startedAtMs === 'number' ? rawTimer.startedAtMs : null,
    elapsedBeforePauseMs: typeof rawTimer.elapsedBeforePauseMs === 'number' ? rawTimer.elapsedBeforePauseMs : 0,
    linkedActivityId: typeof rawTimer.linkedActivityId === 'string' ? rawTimer.linkedActivityId : null,
  };

  return {
    version: CURRENT_SCHEMA_VERSION,
    tasks: validTasks,
    activities: validActivities,
    focusSessions: validSessions,
    activeTimer,
    habits: validHabits,
    habitLogs: validHabitLogs,
    notes: validNotes,
    quotations: validQuotations,
    importedFingerprints: validFingerprints,
    settings,
  };
}

export class LocalStorageRepository implements IDataRepository {
  load(): { state: DayFlowState; recoveredFromCorruption: boolean } {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const seeded = createSeedState();
        this.save(seeded);
        return { state: seeded, recoveredFromCorruption: false };
      }
      const parsed = JSON.parse(raw);
      const validated = validateAndSanitizeState(parsed);
      return { state: validated, recoveredFromCorruption: false };
    } catch {
      try {
        const corrupt = localStorage.getItem(STORAGE_KEY);
        if (corrupt) {
          localStorage.setItem(`${STORAGE_KEY}_corrupt_backup`, corrupt);
        }
      } catch {
        // Ignore quarantine error
      }
      const fresh = createSeedState();
      this.save(fresh);
      return { state: fresh, recoveredFromCorruption: true };
    }
  }

  save(state: DayFlowState): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore quota exceeded silently
    }
  }

  exportJSON(state: DayFlowState): string {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        app: 'DayFlow',
        data: state,
      },
      null,
      2
    );
  }

  parseAndValidateImport(rawJson: string): DayFlowState {
    const parsed = JSON.parse(rawJson);
    const payload = isObject(parsed) && isObject(parsed.data) ? parsed.data : parsed;
    return validateAndSanitizeState(payload);
  }

  clear(): DayFlowState {
    const empty = createEmptyState();
    this.save(empty);
    return empty;
  }
}

export const dayFlowRepository: IDataRepository = new LocalStorageRepository();
