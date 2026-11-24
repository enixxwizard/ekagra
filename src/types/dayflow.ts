export type NavPage =
  | 'plan'
  | 'focus'
  | 'capture'
  | 'library'
  | 'calendar'
  | 'insights'
  | 'settings';

export type PriorityLevel = 'low' | 'medium' | 'high';

export type ActivityStatus = 'pending' | 'completed' | 'skipped';

export type ActivityCategory =
  | 'Work'
  | 'Study'
  | 'Health'
  | 'Personal'
  | 'Deep Focus'
  | 'Admin';

export type ActivityColor =
  | 'indigo'
  | 'emerald'
  | 'amber'
  | 'sky'
  | 'rose'
  | 'violet'
  | 'slate';

export type RecurrenceFrequency =
  | 'none'
  | 'daily'
  | 'weekdays'
  | 'weekends'
  | 'custom_weekdays'
  | 'weekly';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  daysOfWeek?: number[]; // 0 = Sunday .. 6 = Saturday
  endDate?: string | null; // YYYY-MM-DD
}

export interface MonthlyPhaseOverride {
  year: number;
  month: number; // 1..12
  title?: string;
  focusTopic?: string;
  description?: string;
}

export interface ActivityOverride {
  title?: string;
  description?: string;
  startTime?: string; // HH:mm
  endTime?: string; // HH:mm
  category?: ActivityCategory;
  color?: ActivityColor;
  priority?: PriorityLevel;
  status?: ActivityStatus;
}

export interface ScheduleActivity {
  id: string;
  title: string;
  description: string;
  date: string; // YYYY-MM-DD (start date for recurring)
  startTime: string; // HH:mm (24h)
  endTime: string; // HH:mm (24h)
  category: ActivityCategory;
  color: ActivityColor;
  priority: PriorityLevel;
  status: ActivityStatus;
  linkedTaskId: string | null;
  recurrence: RecurrenceRule;
  excludedDates?: string[];
  occurrenceOverrides?: Record<string, ActivityOverride>;
  monthlyPhaseOverrides?: MonthlyPhaseOverride[];
  isOptional?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedActivity {
  instanceId: string; // `${activityId}::${date}`
  activityId: string;
  occurrenceDate: string; // YYYY-MM-DD
  title: string;
  description: string;
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  category: ActivityCategory;
  color: ActivityColor;
  priority: PriorityLevel;
  status: ActivityStatus;
  linkedTaskId: string | null;
  isRecurring: boolean;
  recurrence: RecurrenceRule;
  hasOverride: boolean;
  isOptional?: boolean;
}

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  priority: PriorityLevel;
  dueDate: string | null; // YYYY-MM-DD
  category: ActivityCategory;
  completed: boolean;
  completedAt: string | null;
  estimatedMinutes: number;
  scheduledActivityId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FocusModeType = 'focus' | 'short_break' | 'long_break';

export interface FocusSession {
  id: string;
  activityId: string | null;
  activityTitle: string | null;
  category: ActivityCategory;
  mode: FocusModeType;
  plannedMinutes: number;
  actualMinutes: number;
  startedAt: string;
  endedAt: string;
  date: string; // YYYY-MM-DD local date
  completed: boolean;
  reflection?: string | null;
}

export interface ActiveTimerState {
  mode: FocusModeType;
  status: 'idle' | 'running' | 'paused';
  durationSeconds: number;
  startedAtMs: number | null;
  elapsedBeforePauseMs: number;
  linkedActivityId: string | null;
}

export type HabitFrequency = 'daily' | 'weekly';

export interface HabitItem {
  id: string;
  title: string;
  description: string;
  frequency: HabitFrequency;
  targetPerWeek: number; // 7 for daily, 1-7 for weekly
  category: ActivityCategory;
  color: ActivityColor;
  createdAt: string;
}

export interface QuickNote {
  id: string;
  title: string;
  content: string;
  category: ActivityCategory;
  linkedTaskId: string | null;
  linkedActivityId: string | null;
  linkedFocusSessionId: string | null;
  sourceQuotationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudyQuotation {
  id: string;
  text: string;
  sourceFile: string;
  pageNumber: number | null;
  category: ActivityCategory;
  dateCaptured: string; // YYYY-MM-DD
  createdAt: string;
}

export type PdfDateStatus = 'explicit' | 'suggested';

export interface PdfSuggestedActivity {
  id: string;
  title: string;
  notes: string;
  date: string; // YYYY-MM-DD
  dateStatus: PdfDateStatus;
  startTime: string; // HH:mm
  timeStatus: PdfDateStatus;
  durationMinutes: number;
  category: ActivityCategory;
  priority: PriorityLevel;
  sourceFile: string;
  pageNumber: number;
  kind: 'activity' | 'deadline' | 'exam' | 'task';
  fingerprint: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface PdfExtractedQuotation {
  id: string;
  text: string;
  category: ActivityCategory;
  sourceFile: string;
  pageNumber: number;
  fingerprint: string;
  saved: boolean;
}

export type ResolvedTheme = 'midnight' | 'paper' | 'slate' | 'sand';
export type ThemeMode = ResolvedTheme | 'system';
export type TimeFormat = '12h' | '24h';
export type WeekStartDay = 'monday' | 'sunday';

export interface AppSettings {
  userName: string;
  theme: ThemeMode;
  timeFormat: TimeFormat;
  weekStart: WeekStartDay;
  defaultFocusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  soundAlerts: boolean;
  notificationsEnabled: boolean;
  reminderLeadMinutes: 0 | 5 | 10 | 15;
  dailyCapacityHours: number;
  preferredMusicUrl: string | null;
  autoSyncPdfSchedule: boolean;
  preferredResourceLanguage?: string | null;
  ekuMuted?: boolean;
}

export interface DayFlowState {
  version: number;
  tasks: TaskItem[];
  activities: ScheduleActivity[];
  focusSessions: FocusSession[];
  activeTimer: ActiveTimerState;
  habits: HabitItem[];
  habitLogs: Record<string, string[]>; // YYYY-MM-DD -> habitId[]
  notes: QuickNote[];
  quotations: StudyQuotation[];
  importedFingerprints: string[];
  settings: AppSettings;
}

export interface ActivityConflict {
  first: ResolvedActivity;
  second: ResolvedActivity;
  overlapMinutes: number;
}

export interface TimeSlotSuggestion {
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
}

export interface BreakSuggestion {
  afterActivity: ResolvedActivity;
  beforeActivity: ResolvedActivity;
  contiguousMinutes: number;
  suggestedBreakStart: string;
  suggestedBreakEnd: string;
}

export interface DayLoadAnalysis {
  date: string;
  plannedMinutes: number;
  isOverloaded: boolean;
  capacityMinutes: number;
  conflicts: ActivityConflict[];
  breakSuggestions: BreakSuggestion[];
}

export interface ToastMessage {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description?: string;
}
