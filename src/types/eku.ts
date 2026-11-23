import type {
  ActivityCategory,
  FocusModeType,
  PriorityLevel,
  RecurrenceRule,
} from './dayflow';

export type ScheduleEnhancementChange =
  | {
      type: 'reschedule_activity';
      activityId: string;
      activityTitle: string;
      occurrenceDate: string; // YYYY-MM-DD
      newDate: string; // YYYY-MM-DD
      newStartTime: string; // HH:mm
      newEndTime: string; // HH:mm
      scope: 'single' | 'series';
    }
  | {
      type: 'schedule_task';
      taskId: string;
      taskTitle: string;
      date: string; // YYYY-MM-DD
      startTime: string; // HH:mm
      endTime: string; // HH:mm
    }
  | {
      type: 'insert_break';
      title: string;
      date: string; // YYYY-MM-DD
      startTime: string; // HH:mm
      endTime: string; // HH:mm
    };

export interface ScheduleEnhancementSuggestion {
  id: string;
  title: string;
  reason: string;
  evidence: string;
  changes: ScheduleEnhancementChange[];
  beforePreview: string;
  afterPreview: string;
  tradeOffs: string;
}

export interface EnhancerActivitySnapshot {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  category: ActivityCategory;
  priority: PriorityLevel;
  status: 'pending' | 'completed' | 'skipped';
  linkedTaskId: string | null;
  recurrence: RecurrenceRule;
  excludedDates?: string[];
  occurrenceOverrides?: Record<
    string,
    {
      title?: string;
      startTime?: string;
      endTime?: string;
      category?: ActivityCategory;
      priority?: PriorityLevel;
      status?: 'pending' | 'completed' | 'skipped';
    }
  >;
}

export interface EnhancerTaskSnapshot {
  id: string;
  title: string;
  priority: PriorityLevel;
  dueDate: string | null;
  category: ActivityCategory;
  completed: boolean;
  estimatedMinutes: number;
  scheduledActivityId: string | null;
}

export interface DeterministicOverlapFinding {
  date: string;
  firstActivityId: string;
  firstTitle: string;
  firstTime: string;
  secondActivityId: string;
  secondTitle: string;
  secondTime: string;
  overlapMinutes: number;
}

export interface DeterministicDaySummary {
  date: string;
  weekday: string;
  plannedMinutes: number;
  capacityMinutes: number;
  isOverloaded: boolean;
  overloadMinutes: number;
  freeMinutesAfterNow: number;
  openSlots: Array<{ startTime: string; endTime: string; durationMinutes: number }>;
  blocks: Array<{
    activityId: string;
    title: string;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    category: ActivityCategory;
    priority: PriorityLevel;
    isRecurring: boolean;
    commitmentType: 'fixed' | 'flexible';
    isBreak: boolean;
  }>;
  contiguousWorkRuns: Array<{
    afterActivityId: string;
    afterTitle: string;
    beforeTitle: string;
    contiguousMinutes: number;
    suggestedBreakStart: string;
    suggestedBreakEnd: string;
  }>;
}

export interface DeterministicDeadlineFinding {
  taskId: string;
  title: string;
  dueDate: string | null;
  priority: PriorityLevel;
  estimatedMinutes: number;
  issue: 'overdue' | 'unscheduled_due_soon' | 'insufficient_time' | 'scheduled_after_due';
  detail: string;
}

export interface DeterministicScheduleReport {
  todayISO: string;
  horizonEndISO: string;
  nowMinutes: number;
  timeZone: string;
  dailyCapacityHours: number;
  totalSourceActivities: number;
  validOccurrencesCount: number;
  invalidActivitiesCount: number;
  days: DeterministicDaySummary[];
  overlaps: DeterministicOverlapFinding[];
  overloadedDaysCount: number;
  deadlineFindings: DeterministicDeadlineFinding[];
  flexibleBlocksCount: number;
  fixedBlocksCount: number;
  hasActionableFindings: boolean;
}

export interface EkuFocusSnapshot {
  timerStatus: 'idle' | 'running' | 'paused';
  timerMode: FocusModeType;
  remainingMinutes: number;
  linkedActivityTitle: string | null;
  todayFocusMinutes: number;
  weeklyFocusMinutes: number;
  todayHabitsCompleted: number;
  totalHabits: number;
}

export interface EkuWorkspaceSnapshot {
  todayISO: string;
  nowMinutes: number;
  timeZone: string;
  dailyCapacityHours: number;
  preferredLanguage: string | null;
  activities: EnhancerActivitySnapshot[];
  tasks: EnhancerTaskSnapshot[];
  focusSummary: EkuFocusSnapshot;
}

export type EkuAvatarEmotion =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'success'
  | 'error';

export type EkuResourceType =
  | 'youtube_video'
  | 'direct_pdf'
  | 'pdf_host_page'
  | 'official_docs'
  | 'university_notes'
  | 'educational_site';

export interface EkuResourceItem {
  id: string;
  title: string;
  url: string;
  sourceName: string;
  language: string;
  resourceType: EkuResourceType;
  snippet: string;
  verifiedReachable: boolean;
  languageConfidence: 'audio_metadata_confirmed' | 'title_or_metadata_only';
  disclaimer?: string;
}

export interface EkuResourceLanguageNotice {
  requestedLanguage: string;
  missingPdfInRequestedLanguage?: boolean;
  alternativePdfAvailable?: boolean;
  needsLanguageSelection?: boolean;
  questionPrompt?: string;
  topic?: string;
}

export type EkuPendingProposal =
  | {
      id: string;
      kind: 'schedule_changes';
      title: string;
      reason: string;
      tradeOffs: string;
      beforePreview: string;
      afterPreview: string;
      changes: ScheduleEnhancementChange[];
      status: 'pending' | 'approved' | 'dismissed';
    }
  | {
      id: string;
      kind: 'create_task';
      title: string;
      taskTitle: string;
      dueDate: string | null;
      priority: PriorityLevel;
      category: ActivityCategory;
      estimatedMinutes: number;
      status: 'pending' | 'approved' | 'dismissed';
    }
  | {
      id: string;
      kind: 'create_reminder';
      title: string;
      reminderTitle: string;
      date: string;
      startTime: string;
      endTime: string;
      category: ActivityCategory;
      priority: PriorityLevel;
      hasConflictWarning?: string | null;
      status: 'pending' | 'approved' | 'dismissed';
    };

export interface EkuFocusAction {
  type: 'start_focus' | 'pause_focus';
  mode: FocusModeType;
  durationMinutes: number;
  activityId: string | null;
  activityTitle: string | null;
}

export interface EkuChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface EkuChatRequestBody {
  message: string;
  history: EkuChatHistoryItem[];
  snapshot: EkuWorkspaceSnapshot;
}

export interface EkuChatResponseBody {
  reply: string;
  emotion: EkuAvatarEmotion;
  proposals: EkuPendingProposal[];
  focusActions: EkuFocusAction[];
  resources: EkuResourceItem[];
  languageNotice?: EkuResourceLanguageNotice | null;
  detectedPreferredLanguage?: string | null;
}

export interface EkuChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  proposals?: EkuPendingProposal[];
  focusActions?: EkuFocusAction[];
  resources?: EkuResourceItem[];
  languageNotice?: EkuResourceLanguageNotice | null;
  isError?: boolean;
}
