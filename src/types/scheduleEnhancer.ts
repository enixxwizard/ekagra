import type { ActivityCategory, PriorityLevel, RecurrenceRule } from './dayflow';

export type EnhancerStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

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

export interface ScheduleEnhancementRequestBody {
  todayISO: string;
  nowMinutes: number;
  timeZone: string;
  dailyCapacityHours: number;
  activities: EnhancerActivitySnapshot[];
  tasks: EnhancerTaskSnapshot[];
}

export interface ScheduleEnhancementResponseBody {
  status: 'success' | 'empty';
  emptyReason?: 'no_activities' | 'no_improvements';
  message?: string;
  summary: string;
  suggestions: ScheduleEnhancementSuggestion[];
  deterministicSummary: {
    overlapsCount: number;
    overloadedDaysCount: number;
    deadlineConflictsCount: number;
    flexibleBlocksCount: number;
    breakOpportunitiesCount: number;
  };
  rejectedCount?: number;
}
