import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import {
  createEmptyState,
  dayFlowRepository,
  hybridLocalRepository,
} from '../services/storage/repository';
import { idbClearAllStoresExceptBlobs } from '../services/storage/indexedDb';
import { preferencesStore } from '../services/storage/preferencesStore';
import { publishSyncEvent, subscribeSyncChannel } from '../services/storage/syncChannel';
import { supabaseDayFlowRepository } from '../services/storage/supabaseRepository';
import {
  ActivityCategory,
  ActivityColor,
  ActivityOverride,
  ActivityStatus,
  AppSettings,
  DayFlowState,
  FocusModeType,
  FocusSession,
  HabitItem,
  NavPage,
  PdfSuggestedActivity,
  PriorityLevel,
  QuickNote,
  RecurrenceRule,
  ResolvedActivity,
  ResolvedTheme,
  ScheduleActivity,
  StudyQuotation,
  TaskItem,
  ToastMessage,
} from '../types/dayflow';
import type {
  PdfAutoSyncCommitResult,
  PdfBreakPeriodItem,
  PdfDailyPlanItem,
  PdfDeadlineItem,
  PdfMonthlyGoalItem,
  PdfRoadmapMilestoneItem,
  PdfWeeklyPlanItem,
  StructuredPdfPlan,
} from '../types/pdfSchedule';
import type { ScheduleEnhancementChange } from '../types/eku';
import type { ActiveReminderItem, CalendarFocusTarget } from '../types/reminder';
import { CATEGORY_DEFAULT_COLORS } from '../utils/colors';
import {
  generateId,
  getLocalTimeZoneName,
  getTodayISO,
  minutesToTime24,
  parseTimeToMinutes,
} from '../utils/dateTime';
import {
  clearAllReminderStateForScope,
  clearReminderKeysForActivityIds,
  evaluateActivityReminders,
  hydrateReminderStateFromIndexedDb,
  markReminderDismissed,
  markReminderSnoozed,
} from '../utils/notifications';
import { evaluatePdfAutoSync } from '../utils/pdfAutoSync';
import { computeImportFingerprint } from '../utils/pdfExtractor';
import {
  sanitizeIsoDate,
  sanitizeTime24,
  timeToMinutes,
} from '../utils/pdfSchemaValidator';
import type { StrictScheduleSession } from '../utils/strictScheduleValidator';
import {
  detectRecurringScheduleConflicts,
  groupWeeklyPlansIntoScheduleActivities,
  resolveActivitiesForDate,
} from '../utils/recurrence';
import { detectConflicts } from '../utils/scheduler';
import { playGentleChime } from '../utils/sound';
import { applyThemeToDocument, resolveTheme } from '../utils/theme';

export interface ActivityFormInput {
  id?: string;
  title: string;
  description: string;
  date: string;
  startTime: string;
  endTime: string;
  category: ActivityCategory;
  color: ActivityColor;
  priority: PriorityLevel;
  status?: ActivityStatus;
  linkedTaskId?: string | null;
  recurrence: RecurrenceRule;
}

export interface TaskFormInput {
  id?: string;
  title: string;
  description: string;
  priority: PriorityLevel;
  dueDate: string | null;
  category: ActivityCategory;
  estimatedMinutes: number;
}

export interface HabitFormInput {
  id?: string;
  title: string;
  description: string;
  frequency: 'daily' | 'weekly';
  targetPerWeek: number;
  category: ActivityCategory;
  color: ActivityColor;
}

export interface QuickNoteFormInput {
  id?: string;
  title: string;
  content: string;
  category: ActivityCategory;
  linkedTaskId?: string | null;
  linkedActivityId?: string | null;
  linkedFocusSessionId?: string | null;
  sourceQuotationId?: string | null;
}

export interface StudyQuotationFormInput {
  text: string;
  sourceFile: string;
  pageNumber: number | null;
  category: ActivityCategory;
  dateCaptured?: string;
  fingerprint?: string;
}

export type CalendarSubTab = 'timeline' | 'month';
export type InsightsSubTab = 'overview' | 'habits' | 'tasks';

export interface StructuredPdfImportPayload {
  sourceFile: string;
  weekly?: {
    items: PdfWeeklyPlanItem[];
    breakPeriods: PdfBreakPeriodItem[];
    selectedWeekdays: number[];
    includeBreaks: boolean;
    oneDayOnly: boolean;
    startDate: string;
    endDate: string | null;
  };
  dailyItems?: PdfDailyPlanItem[];
  monthlyGoals?: PdfMonthlyGoalItem[];
  roadmapMilestones?: PdfRoadmapMilestoneItem[];
  deadlines?: PdfDeadlineItem[];
}

export interface StructuredPdfImportResult {
  activitiesAdded: number;
  recurringRulesAdded: number;
  tasksAdded: number;
  notesAdded: number;
  skippedDuplicates: number;
  conflictsCount: number;
}

export interface ConfirmSchedulePdfResult {
  ok: boolean;
  persisted: boolean;
  activitiesAdded: number;
  duplicatesSkipped: number;
  conflictsCount: number;
  error?: string;
}

export interface QuickActivitySheetPayload {
  isOpen: boolean;
  initialDate?: string;
  initialStartTime?: string;
  initialEndTime?: string;
  initialTitle?: string;
  initialDescription?: string;
  initialCategory?: ActivityCategory;
  editingActivity?: ResolvedActivity | null;
}

interface DayFlowContextValue {
  state: DayFlowState;
  activePage: NavPage;
  setActivePage: (page: NavPage) => void;
  calendarTab: CalendarSubTab;
  setCalendarTab: (tab: CalendarSubTab) => void;
  insightsTab: InsightsSubTab;
  setInsightsTab: (tab: InsightsSubTab) => void;
  resolvedTheme: ResolvedTheme;
  remainingSeconds: number;
  toasts: ToastMessage[];
  pushToast: (toast: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: string) => void;
  // Quick-add modal triggers
  isQuickAddTaskOpen: boolean;
  setQuickAddTaskOpen: (open: boolean) => void;
  quickActivitySheet: QuickActivitySheetPayload;
  openQuickActivitySheet: (opts?: Omit<QuickActivitySheetPayload, 'isOpen'>) => void;
  closeQuickActivitySheet: () => void;
  // Tasks
  saveTask: (input: TaskFormInput) => TaskItem;
  toggleTask: (taskId: string) => void;
  deleteTask: (taskId: string) => void;
  scheduleTaskAsActivity: (
    taskId: string,
    date: string,
    startTime: string,
    endTime: string
  ) => void;
  moveTaskToDate: (taskId: string, newDate: string) => void;
  // Schedule Activities
  saveActivity: (input: ActivityFormInput) => ScheduleActivity;
  updateActivityOccurrence: (
    activityId: string,
    occurrenceDate: string,
    patch: ActivityOverride & { date?: string },
    scope: 'single' | 'series'
  ) => void;
  setActivityStatus: (
    activityId: string,
    occurrenceDate: string,
    status: ActivityStatus
  ) => void;
  deleteActivity: (
    activityId: string,
    occurrenceDate?: string,
    scope?: 'single' | 'series'
  ) => void;
  rolloverActivityToDate: (activity: ResolvedActivity, targetDate: string) => void;
  applyScheduleEnhancements: (
    changes: ScheduleEnhancementChange[]
  ) => Promise<{ appliedCount: number; persisted: boolean; error?: string }>;
  // Full-screen activity reminders & calendar deep-link
  reminderQueue: ActiveReminderItem[];
  calendarFocusTarget: CalendarFocusTarget | null;
  consumeCalendarFocusTarget: () => void;
  viewReminderInSchedule: (reminderKey: string) => void;
  snoozeReminder: (reminderKey: string, minutes?: number) => void;
  dismissReminder: (reminderKey: string) => void;
  // Focus Timer & Deep Focus State
  isFocusFullscreen: boolean;
  setFocusFullscreen: (fullscreen: boolean) => void;
  isDeepFocusActive: boolean;
  startTimer: () => void;
  startFocusSession: (
    durationMinutes: number,
    mode?: FocusModeType,
    linkedActivityId?: string | null
  ) => void;
  pauseTimer: () => void;
  resumeTimer: () => void;
  resetTimer: (overrideDurationMinutes?: number) => void;
  switchTimerMode: (mode: FocusModeType) => void;
  setTimerLinkedActivity: (activityId: string | null) => void;
  finishAndLogTimerNow: () => void;
  deleteFocusSession: (sessionId: string) => void;
  lastCompletedSessionId: string | null;
  dismissCompletedSessionSummary: () => void;
  updateFocusSessionReflection: (sessionId: string, reflection: string) => void;
  // Habits
  saveHabit: (input: HabitFormInput) => HabitItem;
  deleteHabit: (habitId: string) => void;
  toggleHabitLog: (habitId: string, dateISO: string) => void;
  // Quick Notes & Quotations
  saveNote: (input: QuickNoteFormInput) => QuickNote;
  deleteNote: (noteId: string) => void;
  saveQuotation: (input: StudyQuotationFormInput) => StudyQuotation;
  deleteQuotation: (quotationId: string) => void;
  // PDF Import & Shortcuts
  isFingerprintImported: (fingerprint: string) => boolean;
  importPdfActivities: (
    items: PdfSuggestedActivity[]
  ) => { added: number; skippedDuplicates: number; withConflicts: number };
  importStructuredPdfPlan: (payload: StructuredPdfImportPayload) => StructuredPdfImportResult;
  confirmSchedulePdfSessions: (
    sourceFile: string,
    sessions: StrictScheduleSession[]
  ) => Promise<ConfirmSchedulePdfResult>;
  syncStructuredPdfPlan: (
    plan: StructuredPdfPlan
  ) => Promise<{ commit: PdfAutoSyncCommitResult; reviewPlan: StructuredPdfPlan }>;
  pendingPdfPickerOpen: boolean;
  consumePendingPdfPickerOpen: () => void;
  openCapturePdfImport: () => void;
  // Settings & Storage
  updateSettings: (patch: Partial<AppSettings>) => void;
  exportBackup: () => string;
  exportFullBackup: () => Promise<string>;
  importBackup: (rawJson: string) => void;
  importFullBackup: (rawJson: string) => Promise<void>;
  clearAllData: () => Promise<void>;
}

const DayFlowContext = createContext<DayFlowContextValue | null>(null);

function computeRemainingSeconds(state: DayFlowState, nowMs = Date.now()): number {
  const { activeTimer } = state;
  if (activeTimer.status === 'idle') {
    return activeTimer.durationSeconds;
  }
  if (activeTimer.status === 'paused') {
    const elapsedSec = Math.floor(activeTimer.elapsedBeforePauseMs / 1000);
    return Math.max(0, activeTimer.durationSeconds - elapsedSec);
  }
  const runningDelta = activeTimer.startedAtMs ? Math.max(0, nowMs - activeTimer.startedAtMs) : 0;
  const totalElapsedSec = Math.floor((activeTimer.elapsedBeforePauseMs + runningDelta) / 1000);
  return Math.max(0, activeTimer.durationSeconds - totalElapsedSec);
}

export const DayFlowProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status: authStatus, user, cloudRefreshNonce } = useAuth();

  const [state, setState] = useState<DayFlowState>(() =>
    authStatus === 'guest'
      ? dayFlowRepository.load().state
      : createEmptyState({
          userName: user?.fullName?.trim() || user?.email?.split('@')[0] || 'Alex',
        })
  );
  const [activePage, setActivePageState] = useState<NavPage>(() => {
    const saved = preferencesStore.getPreference('activePage');
    if (
      saved === 'plan' ||
      saved === 'calendar' ||
      saved === 'focus' ||
      saved === 'capture' ||
      saved === 'library' ||
      saved === 'insights' ||
      saved === 'settings'
    ) {
      return saved;
    }
    return 'plan';
  });

  const setActivePage = useCallback((page: NavPage) => {
    preferencesStore.setPreference('activePage', page);
    setActivePageState(page);
  }, []);

  const [calendarTab, setCalendarTab] = useState<CalendarSubTab>('timeline');
  const [insightsTab, setInsightsTab] = useState<InsightsSubTab>('overview');
  const [isQuickAddTaskOpen, setQuickAddTaskOpen] = useState(false);
  const [isFocusFullscreen, setFocusFullscreen] = useState(false);
  const [pendingPdfPickerOpen, setPendingPdfPickerOpen] = useState(false);
  const [quickActivitySheet, setQuickActivitySheet] = useState<QuickActivitySheetPayload>({
    isOpen: false,
  });

  const openCapturePdfImport = useCallback(() => {
    setPendingPdfPickerOpen(true);
    setActivePage('capture');
  }, [setActivePage]);

  const consumePendingPdfPickerOpen = useCallback(() => {
    setPendingPdfPickerOpen(false);
  }, []);

  const openQuickActivitySheet = useCallback(
    (opts?: Omit<QuickActivitySheetPayload, 'isOpen'>) => {
      setQuickActivitySheet({
        isOpen: true,
        ...opts,
      });
    },
    []
  );

  const closeQuickActivitySheet = useCallback(() => {
    setQuickActivitySheet({ isOpen: false, editingActivity: null });
  }, []);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [reminderQueue, setReminderQueue] = useState<ActiveReminderItem[]>([]);
  const [calendarFocusTarget, setCalendarFocusTarget] = useState<CalendarFocusTarget | null>(null);
  const [lastCompletedSessionId, setLastCompletedSessionId] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() =>
    computeRemainingSeconds(state)
  );
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  );

  const corruptionNotifiedRef = useRef(false);
  const cloudWarnedScopeRef = useRef<string | null>(null);
  const cloudSyncErrorShownRef = useRef(false);
  const loadedScopeRef = useRef<string | null>(null);
  const isApplyingRemoteSyncRef = useRef(false);
  const cloudSchemaReadyRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const reminderScopeKey =
    authStatus === 'authenticated' && user ? user.id : 'guest';

  const pushToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = generateId();
    setToasts((prev) => [...prev.slice(-3), { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Hydrate data strictly for the active auth scope (Local IndexedDB vs Authenticated Supabase)
  useEffect(() => {
    if (authStatus === 'guest') {
      let cancelled = false;
      cloudSchemaReadyRef.current = false;
      loadedScopeRef.current = null;

      void Promise.all([
        hybridLocalRepository.loadAsync(),
        hydrateReminderStateFromIndexedDb('guest'),
      ]).then(([loaded]) => {
        if (cancelled) return;
        isApplyingRemoteSyncRef.current = true;
        setState(loaded.state);
        setRemainingSeconds(computeRemainingSeconds(loaded.state));
        loadedScopeRef.current = 'guest';

        if (loaded.recoveredFromCorruption && !corruptionNotifiedRef.current) {
          corruptionNotifiedRef.current = true;
          pushToast({
            type: 'warning',
            title: 'Recovered from invalid local data',
            description:
              'Unreadable device data was safely reset so Ekagra can run normally.',
          });
        }
      });

      return () => {
        cancelled = true;
      };
    }

    if (authStatus === 'authenticated' && user) {
      let cancelled = false;
      loadedScopeRef.current = null;
      cloudSchemaReadyRef.current = false;

      const fallbackName = user.fullName?.trim() || user.email?.split('@')[0] || 'Alex';
      const freshEmpty = createEmptyState({ userName: fallbackName });
      setState(freshEmpty);
      setRemainingSeconds(computeRemainingSeconds(freshEmpty));

      void hydrateReminderStateFromIndexedDb(user.id);

      supabaseDayFlowRepository
        .loadForUser(user.id, fallbackName)
        .then((res) => {
          if (cancelled) return;
          setState(res.state);
          setRemainingSeconds(computeRemainingSeconds(res.state));
          cloudSchemaReadyRef.current = res.schemaReady;
          loadedScopeRef.current = user.id;

          if (res.warning && cloudWarnedScopeRef.current !== user.id) {
            cloudWarnedScopeRef.current = user.id;
            pushToast({
              type: 'warning',
              title: 'Cloud database setup required',
              description: res.warning,
            });
          }
        })
        .catch((err) => {
          if (cancelled) return;
          cloudSchemaReadyRef.current = false;
          loadedScopeRef.current = null;
          pushToast({
            type: 'error',
            title: 'Could not load cloud data',
            description:
              err instanceof Error
                ? err.message
                : 'Unable to reach your Supabase workspace right now.',
          });
        });

      return () => {
        cancelled = true;
      };
    }

    loadedScopeRef.current = null;
    cloudSchemaReadyRef.current = false;
  }, [authStatus, user, cloudRefreshNonce, pushToast]);

  // Multi-tab real-time local workspace & reminder synchronization
  useEffect(() => {
    if (authStatus !== 'guest') return;
    return subscribeSyncChannel(['workspace', 'reminders', 'storage_reset'], (event) => {
      if (event.topic === 'reminders') {
        void hydrateReminderStateFromIndexedDb('guest');
        return;
      }
      void Promise.all([
        hybridLocalRepository.loadAsync(),
        hydrateReminderStateFromIndexedDb('guest'),
      ]).then(([loaded]) => {
        isApplyingRemoteSyncRef.current = true;
        setState(loaded.state);
        setRemainingSeconds(computeRemainingSeconds(loaded.state));
        if (event.topic === 'storage_reset') {
          setReminderQueue([]);
        }
      });
    });
  }, [authStatus]);

  // Persist state changes strictly to the active scope (never mix local and authenticated data)
  useEffect(() => {
    if (authStatus === 'guest') {
      if (loadedScopeRef.current !== 'guest') return;
      if (isApplyingRemoteSyncRef.current) {
        isApplyingRemoteSyncRef.current = false;
        return;
      }
      hybridLocalRepository.save(state);
      return;
    }

    if (authStatus === 'authenticated' && user) {
      if (loadedScopeRef.current !== user.id || !cloudSchemaReadyRef.current) return;
      const userId = user.id;
      const timeoutId = window.setTimeout(() => {
        void supabaseDayFlowRepository
          .saveForUser(userId, state)
          .then(() => {
            cloudSyncErrorShownRef.current = false;
          })
          .catch((err) => {
            if (!cloudSyncErrorShownRef.current) {
              cloudSyncErrorShownRef.current = true;
              pushToast({
                type: 'warning',
                title: 'Cloud sync paused',
                description:
                  err instanceof Error
                    ? `${err.message}. Changes remain active in this tab until sync recovers.`
                    : 'Unable to save changes to cloud right now. Changes remain active in this tab.',
              });
            }
          });
      }, 450);
      return () => window.clearTimeout(timeoutId);
    }
  }, [state, authStatus, user, pushToast]);

  // Watch system theme changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: ResolvedTheme = resolveTheme(state.settings.theme, systemDark);

  useEffect(() => {
    applyThemeToDocument(state.settings.theme, systemDark);
  }, [state.settings.theme, systemDark]);

  // Helper to get mode default duration in seconds
  const getModeDurationSeconds = useCallback(
    (mode: FocusModeType, settings: AppSettings): number => {
      if (mode === 'focus') return settings.defaultFocusMinutes * 60;
      if (mode === 'short_break') return settings.shortBreakMinutes * 60;
      return settings.longBreakMinutes * 60;
    },
    []
  );

  // Complete timer session when countdown reaches zero
  const finalizeTimerSession = useCallback(
    (currentState: DayFlowState, elapsedSeconds: number, completedFull: boolean): DayFlowState => {
      const { activeTimer, activities, settings } = currentState;
      const linkedAct = activeTimer.linkedActivityId
        ? activities.find((a) => a.id === activeTimer.linkedActivityId) ?? null
        : null;

      const actualMinutes = Math.max(1, Math.round(elapsedSeconds / 60));
      const plannedMinutes = Math.max(1, Math.round(activeTimer.durationSeconds / 60));

      const session: FocusSession = {
        id: generateId(),
        activityId: linkedAct?.id ?? null,
        activityTitle: linkedAct?.title ?? null,
        category: linkedAct?.category ?? 'Deep Focus',
        mode: activeTimer.mode,
        plannedMinutes,
        actualMinutes,
        startedAt: new Date(Date.now() - elapsedSeconds * 1000).toISOString(),
        endedAt: new Date().toISOString(),
        date: getTodayISO(),
        completed: completedFull,
        reflection: null,
      };

      const nextMode: FocusModeType = activeTimer.mode;
      const resetDuration = getModeDurationSeconds(nextMode, settings);

      return {
        ...currentState,
        focusSessions: [session, ...currentState.focusSessions],
        activeTimer: {
          mode: nextMode,
          status: 'idle',
          durationSeconds: resetDuration,
          startedAtMs: null,
          elapsedBeforePauseMs: 0,
          linkedActivityId: activeTimer.linkedActivityId,
        },
      };
    },
    [getModeDurationSeconds]
  );

  const timerFinalizingRef = useRef(false);

  // Keep remainingSeconds synchronized whenever timer is idle/paused or duration settings change
  useEffect(() => {
    if (state.activeTimer.status !== 'running') {
      timerFinalizingRef.current = false;
      setRemainingSeconds(computeRemainingSeconds(state));
    }
  }, [
    state.activeTimer.status,
    state.activeTimer.durationSeconds,
    state.activeTimer.elapsedBeforePauseMs,
  ]);

  // Accurate timestamp-based timer loop (handles inactive tabs and refresh recovery)
  useEffect(() => {
    if (state.activeTimer.status !== 'running') {
      return;
    }

    const syncTick = () => {
      const current = stateRef.current;
      if (current.activeTimer.status !== 'running') {
        return;
      }

      const rem = computeRemainingSeconds(current, Date.now());
      setRemainingSeconds(rem);

      if (rem <= 0 && !timerFinalizingRef.current) {
        timerFinalizingRef.current = true;

        if (current.settings.soundAlerts) {
          playGentleChime();
        }

        const nextState = finalizeTimerSession(
          current,
          current.activeTimer.durationSeconds,
          true
        );
        setState(nextState);
        setRemainingSeconds(nextState.activeTimer.durationSeconds);

        const createdSession = nextState.focusSessions[0];
        if (createdSession && current.activeTimer.mode === 'focus') {
          setLastCompletedSessionId(createdSession.id);
        }

        if (
          current.settings.notificationsEnabled &&
          typeof window !== 'undefined' &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          try {
            new Notification('Ekagra Focus Session Complete', {
              body:
                current.activeTimer.mode === 'focus'
                  ? 'Focus block finished! Time for a short break.'
                  : 'Break finished! Ready to focus again.',
            });
          } catch {
            // Ignore notification error
          }
        }

        pushToast({
          type: 'success',
          title:
            current.activeTimer.mode === 'focus'
              ? 'Focus session logged'
              : 'Break complete',
          description: `${Math.round(current.activeTimer.durationSeconds / 60)} minutes recorded.`,
        });
      }
    };

    syncTick();

    const intervalId = window.setInterval(syncTick, 500);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        syncTick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [state.activeTimer.status, state.activeTimer.durationSeconds, finalizeTimerSession, pushToast]);

  // Reminder polling for today's activities (persisted across refreshes, supports queue + snooze)
  useEffect(() => {
    if (authStatus === 'authenticated' && loadedScopeRef.current !== user?.id) {
      return;
    }

    const runCheck = () => {
      const todayISO = getTodayISO();
      const todayActs = resolveActivitiesForDate(state.activities, todayISO);

      // Remove any queued reminder whose activity is no longer pending today
      setReminderQueue((prev) => {
        if (prev.length === 0) return prev;
        const activePendingKeys = new Set(
          todayActs
            .filter((a) => a.status === 'pending')
            .map((a) => `${a.instanceId}::${a.startTime}`)
        );
        const filtered = prev.filter((item) => activePendingKeys.has(item.key));
        return filtered.length === prev.length ? prev : filtered;
      });

      const newlyTriggered = evaluateActivityReminders({
        scopeKey: reminderScopeKey,
        todayActivities: todayActs,
        leadMinutes: state.settings.reminderLeadMinutes,
        timeFormat: state.settings.timeFormat,
        notificationsEnabled: state.settings.notificationsEnabled,
      });

      if (newlyTriggered.length > 0) {
        if (state.settings.soundAlerts) {
          playGentleChime();
        }
        setReminderQueue((prev) => {
          const existingKeys = new Set(prev.map((item) => item.key));
          const additions = newlyTriggered.filter((item) => !existingKeys.has(item.key));
          if (additions.length === 0) return prev;
          return [...prev, ...additions].sort((a, b) =>
            a.startTime.localeCompare(b.startTime)
          );
        });
      }
    };

    runCheck();
    const id = window.setInterval(runCheck, 5000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        runCheck();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [
    authStatus,
    user?.id,
    reminderScopeKey,
    state.activities,
    state.settings.reminderLeadMinutes,
    state.settings.timeFormat,
    state.settings.notificationsEnabled,
    state.settings.soundAlerts,
  ]);

  const consumeCalendarFocusTarget = useCallback(() => {
    setCalendarFocusTarget(null);
  }, []);

  const viewReminderInSchedule = useCallback(
    (reminderKey: string) => {
      const target = reminderQueue.find((r) => r.key === reminderKey);
      markReminderDismissed(reminderScopeKey, reminderKey);
      setReminderQueue((prev) => prev.filter((r) => r.key !== reminderKey));
      if (target) {
        setCalendarTab('timeline');
        setCalendarFocusTarget({
          date: target.occurrenceDate,
          activityId: target.activityId,
          nonce: Date.now(),
        });
        setActivePage('calendar');
      }
    },
    [reminderQueue, reminderScopeKey]
  );

  const snoozeReminder = useCallback(
    (reminderKey: string, minutes = 5) => {
      markReminderSnoozed(reminderScopeKey, reminderKey, minutes);
      setReminderQueue((prev) => prev.filter((r) => r.key !== reminderKey));
      pushToast({
        type: 'info',
        title: `Snoozed for ${minutes} minutes`,
        description: 'Ekagra will remind you again while open.',
      });
    },
    [reminderScopeKey, pushToast]
  );

  const dismissReminder = useCallback(
    (reminderKey: string) => {
      markReminderDismissed(reminderScopeKey, reminderKey);
      setReminderQueue((prev) => prev.filter((r) => r.key !== reminderKey));
    },
    [reminderScopeKey]
  );

  // Task operations
  const saveTask = useCallback((input: TaskFormInput): TaskItem => {
    const now = new Date().toISOString();
    let saved!: TaskItem;
    setState((prev) => {
      const existing = input.id ? prev.tasks.find((t) => t.id === input.id) : undefined;
      if (existing) {
        saved = {
          ...existing,
          title: input.title.trim(),
          description: input.description.trim(),
          priority: input.priority,
          dueDate: input.dueDate,
          category: input.category,
          estimatedMinutes: input.estimatedMinutes,
          updatedAt: now,
        };
        return {
          ...prev,
          tasks: prev.tasks.map((t) => (t.id === existing.id ? saved : t)),
        };
      }
      saved = {
        id: generateId(),
        title: input.title.trim(),
        description: input.description.trim(),
        priority: input.priority,
        dueDate: input.dueDate,
        category: input.category,
        completed: false,
        completedAt: null,
        estimatedMinutes: input.estimatedMinutes,
        scheduledActivityId: null,
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        tasks: [saved, ...prev.tasks],
      };
    });
    return saved;
  }, []);

  const toggleTask = useCallback((taskId: string) => {
    const now = new Date().toISOString();
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              completed: !t.completed,
              completedAt: !t.completed ? now : null,
              updatedAt: now,
            }
          : t
      ),
    }));
  }, []);

  const deleteTask = useCallback((taskId: string) => {
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.filter((t) => t.id !== taskId),
    }));
  }, []);

  const scheduleTaskAsActivity = useCallback(
    (taskId: string, date: string, startTime: string, endTime: string) => {
      const now = new Date().toISOString();
      setState((prev) => {
        const task = prev.tasks.find((t) => t.id === taskId);
        if (!task) return prev;
        const activityId = generateId();
        const colorMap: Record<ActivityCategory, ActivityColor> = {
          Work: 'indigo',
          Study: 'sky',
          Health: 'emerald',
          Personal: 'amber',
          'Deep Focus': 'violet',
          Admin: 'slate',
        };
        const newAct: ScheduleActivity = {
          id: activityId,
          title: task.title,
          description: task.description,
          date,
          startTime,
          endTime,
          category: task.category,
          color: colorMap[task.category] ?? 'indigo',
          priority: task.priority,
          status: 'pending',
          linkedTaskId: task.id,
          recurrence: { frequency: 'none', endDate: null },
          excludedDates: [],
          occurrenceOverrides: {},
          createdAt: now,
          updatedAt: now,
        };
        return {
          ...prev,
          activities: [...prev.activities, newAct],
          tasks: prev.tasks.map((t) =>
            t.id === taskId ? { ...t, scheduledActivityId: activityId, updatedAt: now } : t
          ),
        };
      });
    },
    []
  );

  const moveTaskToDate = useCallback((taskId: string, newDate: string) => {
    const now = new Date().toISOString();
    setState((prev) => ({
      ...prev,
      tasks: prev.tasks.map((t) =>
        t.id === taskId ? { ...t, dueDate: newDate, updatedAt: now } : t
      ),
    }));
  }, []);

  // Activity operations
  const saveActivity = useCallback((input: ActivityFormInput): ScheduleActivity => {
    const now = new Date().toISOString();
    let saved!: ScheduleActivity;
    setState((prev) => {
      const existing = input.id ? prev.activities.find((a) => a.id === input.id) : undefined;
      if (existing) {
        saved = {
          ...existing,
          title: input.title.trim(),
          description: input.description.trim(),
          date: input.date,
          startTime: input.startTime,
          endTime: input.endTime,
          category: input.category,
          color: input.color,
          priority: input.priority,
          status: input.status ?? existing.status,
          linkedTaskId: input.linkedTaskId ?? existing.linkedTaskId,
          recurrence: input.recurrence,
          updatedAt: now,
        };
        return {
          ...prev,
          activities: prev.activities.map((a) => (a.id === existing.id ? saved : a)),
        };
      }
      saved = {
        id: generateId(),
        title: input.title.trim(),
        description: input.description.trim(),
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        category: input.category,
        color: input.color,
        priority: input.priority,
        status: input.status ?? 'pending',
        linkedTaskId: input.linkedTaskId ?? null,
        recurrence: input.recurrence,
        excludedDates: [],
        occurrenceOverrides: {},
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        activities: [...prev.activities, saved],
      };
    });
    clearReminderKeysForActivityIds(reminderScopeKey, [saved.id]);
    return saved;
  }, [reminderScopeKey]);

  const updateActivityOccurrence = useCallback(
    (
      activityId: string,
      occurrenceDate: string,
      patch: ActivityOverride & { date?: string },
      scope: 'single' | 'series'
    ) => {
      const now = new Date().toISOString();
      setState((prev) => ({
        ...prev,
        activities: prev.activities.map((act) => {
          if (act.id !== activityId) return act;
          const isRecurring = (act.recurrence?.frequency ?? 'none') !== 'none';

          if (!isRecurring || scope === 'series') {
            return {
              ...act,
              title: patch.title ?? act.title,
              description: patch.description ?? act.description,
              startTime: patch.startTime ?? act.startTime,
              endTime: patch.endTime ?? act.endTime,
              category: patch.category ?? act.category,
              color: patch.color ?? act.color,
              priority: patch.priority ?? act.priority,
              status: patch.status ?? act.status,
              date: !isRecurring && patch.date ? patch.date : act.date,
              updatedAt: now,
            };
          }

          // Single occurrence override (or move to a different date by excluding + spawning)
          if (patch.date && patch.date !== occurrenceDate) {
            return act;
          }

          const existingOverride = act.occurrenceOverrides?.[occurrenceDate] ?? {};
          return {
            ...act,
            occurrenceOverrides: {
              ...(act.occurrenceOverrides ?? {}),
              [occurrenceDate]: {
                ...existingOverride,
                ...patch,
              },
            },
            updatedAt: now,
          };
        }),
      }));
      clearReminderKeysForActivityIds(reminderScopeKey, [activityId]);
    },
    [reminderScopeKey]
  );

  const setActivityStatus = useCallback(
    (activityId: string, occurrenceDate: string, status: ActivityStatus) => {
      const now = new Date().toISOString();
      setState((prev) => ({
        ...prev,
        activities: prev.activities.map((act) => {
          if (act.id !== activityId) return act;
          const isRecurring = (act.recurrence?.frequency ?? 'none') !== 'none';
          if (!isRecurring) {
            return { ...act, status, updatedAt: now };
          }
          const existingOverride = act.occurrenceOverrides?.[occurrenceDate] ?? {};
          return {
            ...act,
            occurrenceOverrides: {
              ...(act.occurrenceOverrides ?? {}),
              [occurrenceDate]: {
                ...existingOverride,
                status,
              },
            },
            updatedAt: now,
          };
        }),
      }));
    },
    []
  );

  const deleteActivity = useCallback(
    (activityId: string, occurrenceDate?: string, scope: 'single' | 'series' = 'series') => {
      setState((prev) => {
        const target = prev.activities.find((a) => a.id === activityId);
        if (!target) return prev;
        const isRecurring = (target.recurrence?.frequency ?? 'none') !== 'none';

        if (!isRecurring || scope === 'series' || !occurrenceDate) {
          return {
            ...prev,
            activities: prev.activities.filter((a) => a.id !== activityId),
          };
        }

        return {
          ...prev,
          activities: prev.activities.map((a) =>
            a.id === activityId
              ? {
                  ...a,
                  excludedDates: [...(a.excludedDates ?? []), occurrenceDate],
                  updatedAt: new Date().toISOString(),
                }
              : a
          ),
        };
      });
    },
    []
  );

  const rolloverActivityToDate = useCallback((activity: ResolvedActivity, targetDate: string) => {
    const now = new Date().toISOString();
    setState((prev) => {
      const nextActivities = prev.activities.map((a) => {
        if (a.id !== activity.activityId) return a;
        if (!activity.isRecurring) {
          return { ...a, date: targetDate, status: 'pending' as ActivityStatus, updatedAt: now };
        }
        // For recurring past instance, mark old occurrence skipped and create a one-time block on targetDate
        return {
          ...a,
          occurrenceOverrides: {
            ...(a.occurrenceOverrides ?? {}),
            [activity.occurrenceDate]: {
              ...(a.occurrenceOverrides?.[activity.occurrenceDate] ?? {}),
              status: 'skipped' as ActivityStatus,
            },
          },
          updatedAt: now,
        };
      });

      if (activity.isRecurring) {
        const rolled: ScheduleActivity = {
          id: generateId(),
          title: activity.title,
          description: activity.description,
          date: targetDate,
          startTime: activity.startTime,
          endTime: activity.endTime,
          category: activity.category,
          color: activity.color,
          priority: activity.priority,
          status: 'pending',
          linkedTaskId: activity.linkedTaskId,
          recurrence: { frequency: 'none', endDate: null },
          excludedDates: [],
          occurrenceOverrides: {},
          createdAt: now,
          updatedAt: now,
        };
        return { ...prev, activities: [...nextActivities, rolled] };
      }

      return { ...prev, activities: nextActivities };
    });
  }, []);

  const applyScheduleEnhancements = useCallback(
    async (
      changes: ScheduleEnhancementChange[]
    ): Promise<{ appliedCount: number; persisted: boolean; error?: string }> => {
      if (!Array.isArray(changes) || changes.length === 0) {
        return { appliedCount: 0, persisted: false, error: 'No changes to apply.' };
      }

      const touchedActivityIds: string[] = [];

      const applyOnState = (source: DayFlowState): { nextState: DayFlowState; count: number } => {
        const now = new Date().toISOString();
        let nextActivities = [...source.activities];
        let nextTasks = [...source.tasks];
        let count = 0;

        for (const ch of changes) {
          if (ch.type === 'reschedule_activity') {
            const idx = nextActivities.findIndex((a) => a.id === ch.activityId);
            if (idx === -1) continue;
            const act = nextActivities[idx];
            touchedActivityIds.push(act.id);
            const isRecurring = (act.recurrence?.frequency ?? 'none') !== 'none';

            if (!isRecurring) {
              nextActivities[idx] = {
                ...act,
                date: ch.newDate,
                startTime: ch.newStartTime,
                endTime: ch.newEndTime,
                updatedAt: now,
              };
              count += 1;
            } else if (ch.scope === 'series' && ch.newDate === ch.occurrenceDate) {
              nextActivities[idx] = {
                ...act,
                startTime: ch.newStartTime,
                endTime: ch.newEndTime,
                updatedAt: now,
              };
              count += 1;
            } else if (ch.newDate === ch.occurrenceDate) {
              const existingOverride = act.occurrenceOverrides?.[ch.occurrenceDate] ?? {};
              nextActivities[idx] = {
                ...act,
                occurrenceOverrides: {
                  ...(act.occurrenceOverrides ?? {}),
                  [ch.occurrenceDate]: {
                    ...existingOverride,
                    startTime: ch.newStartTime,
                    endTime: ch.newEndTime,
                  },
                },
                updatedAt: now,
              };
              count += 1;
            } else {
              // Moving a single occurrence of a recurring block to another date: exclude original date and spawn a one-time block
              const existingExcluded = act.excludedDates ?? [];
              const nextExcluded = existingExcluded.includes(ch.occurrenceDate)
                ? existingExcluded
                : [...existingExcluded, ch.occurrenceDate];
              nextActivities[idx] = {
                ...act,
                excludedDates: nextExcluded,
                updatedAt: now,
              };
              nextActivities.push({
                id: generateId(),
                title: act.title,
                description: act.description,
                date: ch.newDate,
                startTime: ch.newStartTime,
                endTime: ch.newEndTime,
                category: act.category,
                color: act.color,
                priority: act.priority,
                status: 'pending',
                linkedTaskId: act.linkedTaskId,
                recurrence: { frequency: 'none', endDate: null },
                excludedDates: [],
                occurrenceOverrides: {},
                createdAt: now,
                updatedAt: now,
              });
              count += 1;
            }
          } else if (ch.type === 'schedule_task') {
            const tIdx = nextTasks.findIndex((t) => t.id === ch.taskId && !t.completed);
            if (tIdx === -1) continue;
            const task = nextTasks[tIdx];
            const activityId = generateId();
            nextActivities.push({
              id: activityId,
              title: task.title,
              description: task.description,
              date: ch.date,
              startTime: ch.startTime,
              endTime: ch.endTime,
              category: task.category,
              color: CATEGORY_DEFAULT_COLORS[task.category],
              priority: task.priority,
              status: 'pending',
              linkedTaskId: task.id,
              recurrence: { frequency: 'none', endDate: null },
              excludedDates: [],
              occurrenceOverrides: {},
              createdAt: now,
              updatedAt: now,
            });
            nextTasks[tIdx] = {
              ...task,
              scheduledActivityId: activityId,
              updatedAt: now,
            };
            count += 1;
          } else if (ch.type === 'insert_break') {
            nextActivities.push({
              id: generateId(),
              title: ch.title.trim() || 'Recovery break',
              description: 'Scheduled break added with Eku',
              date: ch.date,
              startTime: ch.startTime,
              endTime: ch.endTime,
              category: 'Health',
              color: 'emerald',
              priority: 'low',
              status: 'pending',
              linkedTaskId: null,
              recurrence: { frequency: 'none', endDate: null },
              excludedDates: [],
              occurrenceOverrides: {},
              createdAt: now,
              updatedAt: now,
            });
            count += 1;
          }
        }

        return {
          nextState: {
            ...source,
            activities: nextActivities,
            tasks: nextTasks,
          },
          count,
        };
      };

      const preview = applyOnState(stateRef.current);
      if (preview.count === 0) {
        return {
          appliedCount: 0,
          persisted: false,
          error: 'Target item no longer exists or is already completed.',
        };
      }

      if (authStatus === 'authenticated' && user) {
        if (loadedScopeRef.current !== user.id || !cloudSchemaReadyRef.current) {
          return {
            appliedCount: 0,
            persisted: false,
            error: 'Cloud workspace is not ready yet. Wait a moment and retry.',
          };
        }
        try {
          await supabaseDayFlowRepository.saveForUser(user.id, preview.nextState);
          cloudSyncErrorShownRef.current = false;
        } catch (err) {
          return {
            appliedCount: 0,
            persisted: false,
            error:
              err instanceof Error
                ? `Could not save to cloud: ${err.message}`
                : 'Could not save schedule changes to Supabase.',
          };
        }
      } else {
        await hybridLocalRepository.saveAsync(preview.nextState);
        isApplyingRemoteSyncRef.current = true;
      }

      setState(preview.nextState);
      clearReminderKeysForActivityIds(reminderScopeKey, touchedActivityIds);
      return { appliedCount: preview.count, persisted: true };
    },
    [authStatus, user, reminderScopeKey]
  );

  // Focus Timer operations
  const startTimer = useCallback(() => {
    setState((prev) => ({
      ...prev,
      activeTimer: {
        ...prev.activeTimer,
        status: 'running',
        startedAtMs: Date.now(),
        elapsedBeforePauseMs: 0,
      },
    }));
  }, []);

  const startFocusSession = useCallback(
    (
      durationMinutes: number,
      mode: FocusModeType = 'focus',
      linkedActivityId?: string | null
    ) => {
      const clampedMinutes = Math.max(1, Math.min(180, Math.round(durationMinutes)));
      const nextSeconds = clampedMinutes * 60;
      setRemainingSeconds(nextSeconds);
      setState((prev) => ({
        ...prev,
        activeTimer: {
          mode,
          status: 'running',
          durationSeconds: nextSeconds,
          startedAtMs: Date.now(),
          elapsedBeforePauseMs: 0,
          linkedActivityId:
            linkedActivityId !== undefined
              ? linkedActivityId
              : prev.activeTimer.linkedActivityId,
        },
      }));
    },
    []
  );

  const pauseTimer = useCallback(() => {
    setState((prev) => {
      if (prev.activeTimer.status !== 'running') return prev;
      const delta = prev.activeTimer.startedAtMs
        ? Math.max(0, Date.now() - prev.activeTimer.startedAtMs)
        : 0;
      return {
        ...prev,
        activeTimer: {
          ...prev.activeTimer,
          status: 'paused',
          startedAtMs: null,
          elapsedBeforePauseMs: prev.activeTimer.elapsedBeforePauseMs + delta,
        },
      };
    });
  }, []);

  const resumeTimer = useCallback(() => {
    setState((prev) => {
      if (prev.activeTimer.status !== 'paused') return prev;
      return {
        ...prev,
        activeTimer: {
          ...prev.activeTimer,
          status: 'running',
          startedAtMs: Date.now(),
        },
      };
    });
  }, []);

  const resetTimer = useCallback(
    (overrideDurationMinutes?: number) => {
      setState((prev) => {
        const nextSeconds =
          typeof overrideDurationMinutes === 'number'
            ? Math.max(60, overrideDurationMinutes * 60)
            : getModeDurationSeconds(prev.activeTimer.mode, prev.settings);
        return {
          ...prev,
          activeTimer: {
            ...prev.activeTimer,
            status: 'idle',
            durationSeconds: nextSeconds,
            startedAtMs: null,
            elapsedBeforePauseMs: 0,
          },
        };
      });
    },
    [getModeDurationSeconds]
  );

  const switchTimerMode = useCallback(
    (mode: FocusModeType) => {
      setState((prev) => {
        const nextDuration = getModeDurationSeconds(mode, prev.settings);
        return {
          ...prev,
          activeTimer: {
            ...prev.activeTimer,
            mode,
            status: 'idle',
            durationSeconds: nextDuration,
            startedAtMs: null,
            elapsedBeforePauseMs: 0,
          },
        };
      });
    },
    [getModeDurationSeconds]
  );

  const setTimerLinkedActivity = useCallback((activityId: string | null) => {
    setState((prev) => ({
      ...prev,
      activeTimer: {
        ...prev.activeTimer,
        linkedActivityId: activityId,
      },
    }));
  }, []);

  const finishAndLogTimerNow = useCallback(() => {
    const current = stateRef.current;
    const rem = computeRemainingSeconds(current, Date.now());
    const elapsed = Math.max(60, current.activeTimer.durationSeconds - rem);
    const next = finalizeTimerSession(current, elapsed, false);
    setState(next);
    setRemainingSeconds(next.activeTimer.durationSeconds);

    const createdSession = next.focusSessions[0];
    if (createdSession && current.activeTimer.mode === 'focus') {
      setLastCompletedSessionId(createdSession.id);
    }

    pushToast({
      type: 'success',
      title: 'Session saved',
      description: 'Focused minutes added to your daily log.',
    });
  }, [finalizeTimerSession, pushToast]);

  const dismissCompletedSessionSummary = useCallback(() => {
    setLastCompletedSessionId(null);
  }, []);

  const updateFocusSessionReflection = useCallback((sessionId: string, reflection: string) => {
    const trimmed = reflection.trim();
    setState((prev) => ({
      ...prev,
      focusSessions: prev.focusSessions.map((s) =>
        s.id === sessionId ? { ...s, reflection: trimmed ? trimmed : null } : s
      ),
    }));
  }, []);

  const deleteFocusSession = useCallback((sessionId: string) => {
    setState((prev) => ({
      ...prev,
      focusSessions: prev.focusSessions.filter((s) => s.id !== sessionId),
    }));
    setLastCompletedSessionId((curr) => (curr === sessionId ? null : curr));
  }, []);

  // Habit operations
  const saveHabit = useCallback((input: HabitFormInput): HabitItem => {
    let saved!: HabitItem;
    setState((prev) => {
      const existing = input.id ? prev.habits.find((h) => h.id === input.id) : undefined;
      if (existing) {
        saved = {
          ...existing,
          title: input.title.trim(),
          description: input.description.trim(),
          frequency: input.frequency,
          targetPerWeek: input.frequency === 'daily' ? 7 : input.targetPerWeek,
          category: input.category,
          color: input.color,
        };
        return {
          ...prev,
          habits: prev.habits.map((h) => (h.id === existing.id ? saved : h)),
        };
      }
      saved = {
        id: generateId(),
        title: input.title.trim(),
        description: input.description.trim(),
        frequency: input.frequency,
        targetPerWeek: input.frequency === 'daily' ? 7 : input.targetPerWeek,
        category: input.category,
        color: input.color,
        createdAt: getTodayISO(),
      };
      return {
        ...prev,
        habits: [...prev.habits, saved],
      };
    });
    return saved;
  }, []);

  const deleteHabit = useCallback((habitId: string) => {
    setState((prev) => {
      const cleanedLogs: Record<string, string[]> = {};
      for (const [dateKey, ids] of Object.entries(prev.habitLogs)) {
        const filtered = ids.filter((id) => id !== habitId);
        if (filtered.length > 0) cleanedLogs[dateKey] = filtered;
      }
      return {
        ...prev,
        habits: prev.habits.filter((h) => h.id !== habitId),
        habitLogs: cleanedLogs,
      };
    });
  }, []);

  const toggleHabitLog = useCallback((habitId: string, dateISO: string) => {
    setState((prev) => {
      const existing = prev.habitLogs[dateISO] ?? [];
      const has = existing.includes(habitId);
      const updated = has
        ? existing.filter((id) => id !== habitId)
        : [...existing, habitId];
      return {
        ...prev,
        habitLogs: {
          ...prev.habitLogs,
          [dateISO]: updated,
        },
      };
    });
  }, []);

  // Quick Notes & Quotations
  const saveNote = useCallback((input: QuickNoteFormInput): QuickNote => {
    const now = new Date().toISOString();
    const id = input.id ?? generateId();
    const nextNote: QuickNote = {
      id,
      title: input.title.trim(),
      content: input.content,
      category: input.category,
      linkedTaskId: input.linkedTaskId ?? null,
      linkedActivityId: input.linkedActivityId ?? null,
      linkedFocusSessionId: input.linkedFocusSessionId ?? null,
      sourceQuotationId: input.sourceQuotationId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    setState((prev) => {
      const existing = prev.notes.find((n) => n.id === id);
      if (existing) {
        const updated: QuickNote = {
          ...existing,
          title: input.title.trim(),
          content: input.content,
          category: input.category,
          linkedTaskId: input.linkedTaskId !== undefined ? input.linkedTaskId : existing.linkedTaskId,
          linkedActivityId:
            input.linkedActivityId !== undefined ? input.linkedActivityId : existing.linkedActivityId,
          linkedFocusSessionId:
            input.linkedFocusSessionId !== undefined
              ? input.linkedFocusSessionId
              : existing.linkedFocusSessionId,
          sourceQuotationId:
            input.sourceQuotationId !== undefined
              ? input.sourceQuotationId
              : existing.sourceQuotationId,
          updatedAt: now,
        };
        return {
          ...prev,
          notes: prev.notes.map((n) => (n.id === id ? updated : n)),
        };
      }
      return {
        ...prev,
        notes: [nextNote, ...prev.notes],
      };
    });

    return nextNote;
  }, []);

  const deleteNote = useCallback((noteId: string) => {
    setState((prev) => ({
      ...prev,
      notes: prev.notes.filter((n) => n.id !== noteId),
    }));
  }, []);

  const saveQuotation = useCallback((input: StudyQuotationFormInput): StudyQuotation => {
    const now = new Date().toISOString();
    const saved: StudyQuotation = {
      id: generateId(),
      text: input.text.trim(),
      sourceFile: input.sourceFile.trim() || 'Captured note',
      pageNumber: input.pageNumber,
      category: input.category,
      dateCaptured: input.dateCaptured ?? getTodayISO(),
      createdAt: now,
    };

    setState((prev) => {
      const alreadyExists = prev.quotations.some(
        (q) => q.text.trim().toLowerCase() === saved.text.toLowerCase()
      );
      if (alreadyExists) return prev;
      const nextFingerprints = input.fingerprint
        ? Array.from(new Set([...prev.importedFingerprints, input.fingerprint]))
        : prev.importedFingerprints;
      return {
        ...prev,
        quotations: [saved, ...prev.quotations],
        importedFingerprints: nextFingerprints,
      };
    });

    return saved;
  }, []);

  const deleteQuotation = useCallback((quotationId: string) => {
    setState((prev) => ({
      ...prev,
      quotations: prev.quotations.filter((q) => q.id !== quotationId),
    }));
  }, []);

  const isFingerprintImported = useCallback(
    (fingerprint: string) => state.importedFingerprints.includes(fingerprint),
    [state.importedFingerprints]
  );

  const importPdfActivities = useCallback(
    (items: PdfSuggestedActivity[]) => {
      const now = new Date().toISOString();
      let added = 0;
      let skippedDuplicates = 0;
      let withConflicts = 0;

      setState((prev) => {
        const nextActivities = [...prev.activities];
        const fingerprintSet = new Set(prev.importedFingerprints);

        for (const item of items) {
          const itemFingerprint = computeImportFingerprint(
            item.sourceFile,
            item.title,
            item.date,
            item.startTime
          );
          const matchingExisting = nextActivities.some(
            (a) =>
              a.date === item.date &&
              a.startTime === item.startTime &&
              a.title.trim().toLowerCase() === item.title.trim().toLowerCase()
          );

          if (
            fingerprintSet.has(item.fingerprint) ||
            fingerprintSet.has(itemFingerprint) ||
            matchingExisting
          ) {
            skippedDuplicates += 1;
            continue;
          }

          const startMin = parseTimeToMinutes(item.startTime);
          const endTime = minutesToTime24(Math.min(23 * 60 + 55, startMin + Math.max(15, item.durationMinutes)));

          const resolvedDay = resolveActivitiesForDate(nextActivities, item.date);
          const candidateResolved: ResolvedActivity = {
            instanceId: `candidate::${item.id}`,
            activityId: item.id,
            occurrenceDate: item.date,
            title: item.title,
            description: item.notes,
            startTime: item.startTime,
            endTime,
            category: item.category,
            color: CATEGORY_DEFAULT_COLORS[item.category] ?? 'sky',
            priority: item.priority,
            status: 'pending',
            linkedTaskId: null,
            isRecurring: false,
            recurrence: { frequency: 'none', endDate: null },
            hasOverride: false,
          };
          if (detectConflicts([...resolvedDay, candidateResolved]).length > 0) {
            withConflicts += 1;
          }

          const sourceMeta = `Source: ${item.sourceFile} (p. ${item.pageNumber})${
            item.notes ? ` · ${item.notes}` : ''
          }`;

          nextActivities.push({
            id: generateId(),
            title: item.title.trim(),
            description: sourceMeta,
            date: item.date,
            startTime: item.startTime,
            endTime,
            category: item.category,
            color: CATEGORY_DEFAULT_COLORS[item.category] ?? 'sky',
            priority: item.priority,
            status: 'pending',
            linkedTaskId: null,
            recurrence: { frequency: 'none', endDate: null },
            excludedDates: [],
            occurrenceOverrides: {},
            createdAt: now,
            updatedAt: now,
          });

          fingerprintSet.add(item.fingerprint);
          fingerprintSet.add(itemFingerprint);
          added += 1;
        }

        return {
          ...prev,
          activities: nextActivities,
          importedFingerprints: Array.from(fingerprintSet),
        };
      });

      return { added, skippedDuplicates, withConflicts };
    },
    []
  );

  const applyStructuredPdfImport = useCallback(
    (
      prev: DayFlowState,
      payload: StructuredPdfImportPayload
    ): {
      nextState: DayFlowState;
      summary: StructuredPdfImportResult;
      addedActivityIds: string[];
    } => {
      const now = new Date().toISOString();
      const nextActivities = [...prev.activities];
      const nextTasks = [...prev.tasks];
      const nextNotes = [...prev.notes];
      const fingerprintSet = new Set(prev.importedFingerprints);
      const addedActivityIds: string[] = [];

      let activitiesAdded = 0;
      let recurringRulesAdded = 0;
      let tasksAdded = 0;
      let notesAdded = 0;
      let skippedDuplicates = 0;
      let conflictsCount = 0;

      // 1. Weekly recurring schedule rules (or 1-day snapshot)
      if (payload.weekly && (payload.weekly.items.length > 0 || payload.weekly.includeBreaks)) {
        const groupedRules = groupWeeklyPlansIntoScheduleActivities(
          payload.weekly.items,
          payload.weekly.breakPeriods,
          {
            selectedWeekdays: payload.weekly.selectedWeekdays,
            includeBreaks: payload.weekly.includeBreaks,
            oneDayOnly: payload.weekly.oneDayOnly,
            startDate: payload.weekly.startDate,
            endDate: payload.weekly.endDate,
            sourceFile: payload.sourceFile,
            timeZone: getLocalTimeZoneName(),
          }
        );

        const newlyAddedRules: ScheduleActivity[] = [];
        for (const rule of groupedRules) {
          const daysSig = [...(rule.recurrence.daysOfWeek ?? [])].sort((a, b) => a - b).join(',');
          const ruleFingerprint = computeImportFingerprint(
            payload.sourceFile,
            rule.title,
            rule.date,
            `${rule.startTime}-${rule.endTime}-${rule.recurrence.frequency}-${daysSig}`
          );

          const matchesExisting = nextActivities.some(
            (a) =>
              a.title.trim().toLowerCase() === rule.title.trim().toLowerCase() &&
              a.startTime === rule.startTime &&
              a.endTime === rule.endTime &&
              a.recurrence.frequency === rule.recurrence.frequency &&
              (rule.recurrence.frequency === 'none'
                ? a.date === rule.date
                : JSON.stringify([...(a.recurrence.daysOfWeek ?? [])].sort()) ===
                  JSON.stringify([...(rule.recurrence.daysOfWeek ?? [])].sort()))
          );

          if (fingerprintSet.has(ruleFingerprint) || matchesExisting) {
            skippedDuplicates += 1;
            continue;
          }

          fingerprintSet.add(ruleFingerprint);
          nextActivities.push(rule);
          newlyAddedRules.push(rule);
          addedActivityIds.push(rule.id);
          activitiesAdded += 1;
          if (rule.recurrence.frequency !== 'none') {
            recurringRulesAdded += 1;
          }
        }

        if (newlyAddedRules.length > 0) {
          const weeklyConflicts = detectRecurringScheduleConflicts(
            newlyAddedRules,
            prev.activities,
            payload.weekly.startDate
          );
          conflictsCount += weeklyConflicts.length;
        }
      }

      // 2. Specific single-date daily plan items (strictly requires explicit date)
      if (payload.dailyItems && payload.dailyItems.length > 0) {
        for (const item of payload.dailyItems) {
          const targetDate = sanitizeIsoDate(item.date);
          if (!targetDate) continue;
          const itemFingerprint = computeImportFingerprint(
            payload.sourceFile,
            item.title,
            targetDate,
            item.startTime
          );
          const matchesExisting = nextActivities.some(
            (a) =>
              a.date === targetDate &&
              a.startTime === item.startTime &&
              a.title.trim().toLowerCase() === item.title.trim().toLowerCase()
          );

          if (fingerprintSet.has(itemFingerprint) || matchesExisting) {
            skippedDuplicates += 1;
            continue;
          }

          const existingForDay = resolveActivitiesForDate(prev.activities, targetDate);
          const candidate: ScheduleActivity = {
            id: generateId(),
            title: item.title.trim(),
            description: `Source: ${payload.sourceFile} (p. ${item.sourcePage})${
              item.notes ? ` · ${item.notes}` : ''
            } · TZ: ${getLocalTimeZoneName()}`,
            date: targetDate,
            startTime: item.startTime,
            endTime: item.endTime,
            category: item.category,
            color: CATEGORY_DEFAULT_COLORS[item.category] ?? 'sky',
            priority: item.priority,
            status: 'pending',
            linkedTaskId: null,
            recurrence: { frequency: 'none', endDate: null },
            excludedDates: [],
            occurrenceOverrides: {},
            ...(item.optional ? { isOptional: true } : {}),
            createdAt: now,
            updatedAt: now,
          };

          const resolvedCandidate = resolveActivitiesForDate([candidate], targetDate);
          if (
            resolvedCandidate.length > 0 &&
            detectConflicts([...existingForDay, ...resolvedCandidate]).length > 0
          ) {
            conflictsCount += 1;
          }

          nextActivities.push(candidate);
          addedActivityIds.push(candidate.id);
          fingerprintSet.add(itemFingerprint);
          activitiesAdded += 1;
        }
      }

      // 3. Monthly learning goals -> Quick Notes (never arbitrary timed calendar blocks)
      if (payload.monthlyGoals && payload.monthlyGoals.length > 0) {
        for (const mg of payload.monthlyGoals) {
          const goalsClean = mg.goals.map((g) => g.trim()).filter(Boolean);
          if (goalsClean.length === 0) continue;

          const noteTitle = `${mg.monthLabel}${mg.year ? ` ${mg.year}` : ''} Monthly Goals`;
          const noteFingerprint = computeImportFingerprint(
            payload.sourceFile,
            noteTitle,
            `${mg.year ?? ''}-${String(mg.month).padStart(2, '0')}`,
            'monthly-goal'
          );

          const matchesExisting = nextNotes.some(
            (n) =>
              n.title.trim().toLowerCase() === noteTitle.toLowerCase() &&
              n.content.includes(goalsClean[0])
          );

          if (fingerprintSet.has(noteFingerprint) || matchesExisting) {
            skippedDuplicates += 1;
            continue;
          }

          const noteContent = [
            `Source: ${payload.sourceFile} (p. ${mg.sourcePage})`,
            '',
            ...goalsClean.map((g) => `• ${g}`),
          ].join('\n');

          nextNotes.unshift({
            id: generateId(),
            title: noteTitle,
            content: noteContent,
            category: mg.category,
            linkedTaskId: null,
            linkedActivityId: null,
            linkedFocusSessionId: null,
            sourceQuotationId: null,
            createdAt: now,
            updatedAt: now,
          });
          fingerprintSet.add(noteFingerprint);
          notesAdded += 1;
        }
      }

      // 3B. Roadmap Milestones -> Structured Capture Note (never fake daily calendar blocks)
      if (payload.roadmapMilestones && payload.roadmapMilestones.length > 0) {
        const activeMilestones = payload.roadmapMilestones.filter((m) => m.title.trim());
        if (activeMilestones.length > 0) {
          const rmNoteTitle = `${payload.sourceFile.replace(/\.pdf$/i, '')} — Roadmap Milestones`;
          const rmFingerprint = computeImportFingerprint(
            payload.sourceFile,
            rmNoteTitle,
            String(activeMilestones.length),
            'roadmap-milestones'
          );

          const matchesExistingRm = nextNotes.some(
            (n) =>
              n.title.trim().toLowerCase() === rmNoteTitle.toLowerCase() &&
              n.content.includes(activeMilestones[0].title.trim())
          );

          if (fingerprintSet.has(rmFingerprint) || matchesExistingRm) {
            skippedDuplicates += activeMilestones.length;
          } else {
            const rmContent = [
              `Source: ${payload.sourceFile}`,
              '',
              ...activeMilestones.map((m) => {
                const targetTag = m.targetDate
                  ? ` (${m.targetDate})`
                  : m.targetMonth
                  ? ` (${m.targetMonth}/${m.targetYear ?? ''})`
                  : '';
                return `• ${m.phaseLabel}: ${m.title}${targetTag}`;
              }),
            ].join('\n');

            nextNotes.unshift({
              id: generateId(),
              title: rmNoteTitle,
              content: rmContent,
              category: activeMilestones[0].category ?? 'Study',
              linkedTaskId: null,
              linkedActivityId: null,
              linkedFocusSessionId: null,
              sourceQuotationId: null,
              createdAt: now,
              updatedAt: now,
            });
            fingerprintSet.add(rmFingerprint);
            notesAdded += 1;
          }
        }
      }

      // 4. Deadlines & Assignments -> Tasks Backlog (preserving null dueDate if omitted in PDF)
      if (payload.deadlines && payload.deadlines.length > 0) {
        for (const dl of payload.deadlines) {
          const dlFingerprint = computeImportFingerprint(
            payload.sourceFile,
            dl.title,
            dl.dueDate,
            dl.dueTime ?? dl.kind
          );

          const matchesExisting = nextTasks.some(
            (t) =>
              t.title.trim().toLowerCase() === dl.title.trim().toLowerCase() &&
              t.dueDate === dl.dueDate
          );

          if (fingerprintSet.has(dlFingerprint) || matchesExisting) {
            skippedDuplicates += 1;
            continue;
          }

          const descParts = [
            `[${dl.kind.toUpperCase()}] Source: ${payload.sourceFile} (p. ${dl.sourcePage})`,
            dl.dueTime ? `Due at ${dl.dueTime}` : null,
            dl.notes || null,
          ].filter(Boolean);

          nextTasks.unshift({
            id: generateId(),
            title: dl.title.trim(),
            description: descParts.join(' · '),
            priority: dl.priority,
            dueDate: dl.dueDate,
            category: dl.category,
            completed: false,
            completedAt: null,
            estimatedMinutes: dl.estimatedMinutes,
            scheduledActivityId: null,
            createdAt: now,
            updatedAt: now,
          });
          fingerprintSet.add(dlFingerprint);
          tasksAdded += 1;
        }
      }

      return {
        nextState: {
          ...prev,
          activities: nextActivities,
          tasks: nextTasks,
          notes: nextNotes,
          importedFingerprints: Array.from(fingerprintSet),
        },
        summary: {
          activitiesAdded,
          recurringRulesAdded,
          tasksAdded,
          notesAdded,
          skippedDuplicates,
          conflictsCount,
        },
        addedActivityIds,
      };
    },
    []
  );

  const importStructuredPdfPlan = useCallback(
    (payload: StructuredPdfImportPayload): StructuredPdfImportResult => {
      const { summary, addedActivityIds } = applyStructuredPdfImport(stateRef.current, payload);
      setState((prev) => applyStructuredPdfImport(prev, payload).nextState);
      if (addedActivityIds.length > 0) {
        clearReminderKeysForActivityIds(reminderScopeKey, addedActivityIds);
      }
      return summary;
    },
    [applyStructuredPdfImport, reminderScopeKey]
  );

  const syncStructuredPdfPlan = useCallback(
    async (
      plan: StructuredPdfPlan
    ): Promise<{ commit: PdfAutoSyncCommitResult; reviewPlan: StructuredPdfPlan }> => {
      const currentState = stateRef.current;
      const evaluation = evaluatePdfAutoSync({
        plan,
        existingActivities: currentState.activities,
        existingTasks: currentState.tasks,
        existingNotes: currentState.notes,
        importedFingerprints: currentState.importedFingerprints,
        referenceDateISO: getTodayISO(),
      });

      const { nextState, summary, addedActivityIds } = applyStructuredPdfImport(
        currentState,
        evaluation.payload
      );

      const totalDuplicatesSkipped = evaluation.duplicatesSkipped + summary.skippedDuplicates;
      const totalConflictsCount = Math.max(evaluation.conflictsCount, summary.conflictsCount);
      const totalNewRecords =
        summary.activitiesAdded + summary.tasksAdded + summary.notesAdded;

      if (totalNewRecords === 0) {
        const status: PdfAutoSyncCommitResult['status'] =
          evaluation.reviewItems.length > 0
            ? 'needs_review'
            : totalDuplicatesSkipped > 0
            ? 'duplicates_only'
            : 'empty';

        return {
          commit: {
            status,
            persisted: true,
            activitiesAdded: 0,
            recurringRulesAdded: 0,
            tasksAdded: 0,
            notesAdded: 0,
            duplicatesSkipped: totalDuplicatesSkipped,
            conflictsCount: totalConflictsCount,
            reviewItems: evaluation.reviewItems,
            timetableDiff: evaluation.timetableDiff,
          },
          reviewPlan: evaluation.reviewPlan,
        };
      }

      try {
        if (authStatus === 'authenticated' && user) {
          if (!cloudSchemaReadyRef.current) {
            throw new Error(
              'Cloud database tables are not ready yet. Run the Supabase SQL migration or check your connection before syncing.'
            );
          }
          await supabaseDayFlowRepository.saveForUser(user.id, nextState);
        } else {
          await hybridLocalRepository.saveAsync(nextState);
          isApplyingRemoteSyncRef.current = true;
        }
      } catch (err) {
        return {
          commit: {
            status: 'error',
            persisted: false,
            error:
              err instanceof Error
                ? err.message
                : 'Could not save synced schedule entries to storage.',
            activitiesAdded: 0,
            recurringRulesAdded: 0,
            tasksAdded: 0,
            notesAdded: 0,
            duplicatesSkipped: totalDuplicatesSkipped,
            conflictsCount: totalConflictsCount,
            reviewItems: evaluation.reviewItems,
            timetableDiff: evaluation.timetableDiff,
          },
          reviewPlan: evaluation.reviewPlan,
        };
      }

      setState(nextState);
      if (addedActivityIds.length > 0) {
        clearReminderKeysForActivityIds(reminderScopeKey, addedActivityIds);
      }

      return {
        commit: {
          status: 'synced',
          persisted: true,
          activitiesAdded: summary.activitiesAdded,
          recurringRulesAdded: summary.recurringRulesAdded,
          tasksAdded: summary.tasksAdded,
          notesAdded: summary.notesAdded,
          duplicatesSkipped: totalDuplicatesSkipped,
          conflictsCount: totalConflictsCount,
          reviewItems: evaluation.reviewItems,
          timetableDiff: evaluation.timetableDiff,
        },
        reviewPlan: evaluation.reviewPlan,
      };
    },
    [applyStructuredPdfImport, authStatus, user, reminderScopeKey]
  );

  const confirmSchedulePdfSessions = useCallback(
    async (
      sourceFile: string,
      sessions: StrictScheduleSession[]
    ): Promise<ConfirmSchedulePdfResult> => {
      const currentState = stateRef.current;
      const now = new Date().toISOString();
      const tzName = getLocalTimeZoneName();
      const nextActivities = [...currentState.activities];
      const fingerprintSet = new Set(currentState.importedFingerprints);
      const addedActivityIds: string[] = [];

      let activitiesAdded = 0;
      let duplicatesSkipped = 0;
      let conflictsCount = 0;

      for (const session of sessions) {
        if (!session.included) continue;
        const cleanTitle = session.title.trim();
        const validDate = sanitizeIsoDate(session.date);
        const validStart = sanitizeTime24(session.startTime);
        const validEnd = sanitizeTime24(session.endTime);

        if (
          !cleanTitle ||
          !validDate ||
          !validStart ||
          !validEnd ||
          timeToMinutes(validEnd) <= timeToMinutes(validStart)
        ) {
          continue;
        }

        const fp = computeImportFingerprint(sourceFile, cleanTitle, validDate, validStart);
        const normalizedTitle = cleanTitle.toLowerCase();
        const exactMatch = nextActivities.some(
          (a) =>
            a.date === validDate &&
            a.startTime === validStart &&
            a.endTime === validEnd &&
            a.title.trim().toLowerCase() === normalizedTitle
        );

        if (fingerprintSet.has(fp) || exactMatch) {
          duplicatesSkipped += 1;
          continue;
        }

        const existingForDay = resolveActivitiesForDate(currentState.activities, validDate);
        const candidate: ScheduleActivity = {
          id: generateId(),
          title: cleanTitle,
          description: `Source: ${sourceFile} (p. ${session.sourcePage})${
            session.notes ? ` · ${session.notes}` : ''
          } · TZ: ${tzName}`,
          date: validDate,
          startTime: validStart,
          endTime: validEnd,
          category: session.category,
          color: CATEGORY_DEFAULT_COLORS[session.category] ?? 'sky',
          priority: session.priority,
          status: 'pending',
          linkedTaskId: null,
          recurrence: { frequency: 'none', endDate: null },
          excludedDates: [],
          occurrenceOverrides: {},
          createdAt: now,
          updatedAt: now,
        };

        const resolvedCandidate = resolveActivitiesForDate([candidate], validDate);
        if (
          resolvedCandidate.length > 0 &&
          detectConflicts([...existingForDay, ...resolvedCandidate]).length > 0
        ) {
          conflictsCount += 1;
        }

        nextActivities.push(candidate);
        addedActivityIds.push(candidate.id);
        fingerprintSet.add(fp);
        activitiesAdded += 1;
      }

      if (activitiesAdded === 0) {
        return {
          ok: true,
          persisted: true,
          activitiesAdded: 0,
          duplicatesSkipped,
          conflictsCount,
        };
      }

      const nextState: DayFlowState = {
        ...currentState,
        activities: nextActivities,
        importedFingerprints: Array.from(fingerprintSet),
      };

      try {
        if (authStatus === 'authenticated' && user) {
          if (!cloudSchemaReadyRef.current) {
            throw new Error(
              'Cloud database tables are not ready yet. Check your Supabase connection before importing.'
            );
          }
          await supabaseDayFlowRepository.saveForUser(user.id, nextState);
        } else {
          await hybridLocalRepository.saveAsync(nextState);
          isApplyingRemoteSyncRef.current = true;
        }
      } catch (err) {
        return {
          ok: false,
          persisted: false,
          activitiesAdded: 0,
          duplicatesSkipped,
          conflictsCount,
          error:
            err instanceof Error
              ? err.message
              : 'Could not save imported study schedule to storage.',
        };
      }

      setState(nextState);
      if (addedActivityIds.length > 0) {
        clearReminderKeysForActivityIds(reminderScopeKey, addedActivityIds);
      }

      return {
        ok: true,
        persisted: true,
        activitiesAdded,
        duplicatesSkipped,
        conflictsCount,
      };
    },
    [authStatus, user, reminderScopeKey]
  );

  // Settings & Persistence
  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setState((prev) => {
        const nextSettings = { ...prev.settings, ...patch };
        let nextTimer = prev.activeTimer;
        const durationSettingChanged =
          (patch.defaultFocusMinutes !== undefined &&
            patch.defaultFocusMinutes !== prev.settings.defaultFocusMinutes) ||
          (patch.shortBreakMinutes !== undefined &&
            patch.shortBreakMinutes !== prev.settings.shortBreakMinutes) ||
          (patch.longBreakMinutes !== undefined &&
            patch.longBreakMinutes !== prev.settings.longBreakMinutes);
        if (prev.activeTimer.status === 'idle' && durationSettingChanged) {
          const nextDur = getModeDurationSeconds(prev.activeTimer.mode, nextSettings);
          nextTimer = { ...prev.activeTimer, durationSeconds: nextDur };
        }
        return {
          ...prev,
          settings: nextSettings,
          activeTimer: nextTimer,
        };
      });
    },
    [getModeDurationSeconds]
  );

  const exportBackup = useCallback(() => {
    return hybridLocalRepository.exportJSON(state);
  }, [state]);

  const exportFullBackup = useCallback(async () => {
    return hybridLocalRepository.exportFullBackupJson(stateRef.current);
  }, []);

  const importBackup = useCallback((rawJson: string) => {
    const validated = hybridLocalRepository.parseAndValidateImport(rawJson);
    setState(validated);
    setRemainingSeconds(computeRemainingSeconds(validated));
  }, []);

  const importFullBackup = useCallback(
    async (rawJson: string) => {
      const validated = await hybridLocalRepository.importFullBackupAsync(rawJson);
      isApplyingRemoteSyncRef.current = true;
      setState(validated);
      setRemainingSeconds(computeRemainingSeconds(validated));
      await hydrateReminderStateFromIndexedDb(reminderScopeKey);
    },
    [reminderScopeKey]
  );

  const clearAllData = useCallback(async () => {
    clearAllReminderStateForScope(reminderScopeKey);
    setReminderQueue([]);
    if (authStatus === 'authenticated' && user) {
      const fallbackName = user.fullName?.trim() || user.email?.split('@')[0] || 'Alex';
      const cleared = createEmptyState({ userName: fallbackName });
      setState(cleared);
      setRemainingSeconds(cleared.activeTimer.durationSeconds);
      return;
    }
    await idbClearAllStoresExceptBlobs();
    const cleared = await hybridLocalRepository.clearAsync();
    preferencesStore.clearAll();
    publishSyncEvent('storage_reset');
    isApplyingRemoteSyncRef.current = true;
    setState(cleared);
    setRemainingSeconds(cleared.activeTimer.durationSeconds);
  }, [authStatus, user, reminderScopeKey]);

  const value: DayFlowContextValue = {
    state,
    activePage,
    setActivePage,
    calendarTab,
    setCalendarTab,
    insightsTab,
    setInsightsTab,
    resolvedTheme,
    remainingSeconds,
    toasts,
    pushToast,
    dismissToast,
    isQuickAddTaskOpen,
    setQuickAddTaskOpen,
    quickActivitySheet,
    openQuickActivitySheet,
    closeQuickActivitySheet,
    saveTask,
    toggleTask,
    deleteTask,
    scheduleTaskAsActivity,
    moveTaskToDate,
    saveActivity,
    updateActivityOccurrence,
    setActivityStatus,
    deleteActivity,
    rolloverActivityToDate,
    applyScheduleEnhancements,
    reminderQueue,
    calendarFocusTarget,
    consumeCalendarFocusTarget,
    viewReminderInSchedule,
    snoozeReminder,
    dismissReminder,
    isFocusFullscreen,
    setFocusFullscreen,
    isDeepFocusActive:
      isFocusFullscreen ||
      (activePage === 'focus' && state.activeTimer.status === 'running'),
    startTimer,
    startFocusSession,
    pauseTimer,
    resumeTimer,
    resetTimer,
    switchTimerMode,
    setTimerLinkedActivity,
    finishAndLogTimerNow,
    deleteFocusSession,
    lastCompletedSessionId,
    dismissCompletedSessionSummary,
    updateFocusSessionReflection,
    saveHabit,
    deleteHabit,
    toggleHabitLog,
    saveNote,
    deleteNote,
    saveQuotation,
    deleteQuotation,
    isFingerprintImported,
    importPdfActivities,
    importStructuredPdfPlan,
    confirmSchedulePdfSessions,
    syncStructuredPdfPlan,
    pendingPdfPickerOpen,
    consumePendingPdfPickerOpen,
    openCapturePdfImport,
    updateSettings,
    exportBackup,
    exportFullBackup,
    importBackup,
    importFullBackup,
    clearAllData,
  };

  return <DayFlowContext.Provider value={value}>{children}</DayFlowContext.Provider>;
};

export function useDayFlow(): DayFlowContextValue {
  const ctx = useContext(DayFlowContext);
  if (!ctx) {
    throw new Error('useDayFlow must be used inside DayFlowProvider');
  }
  return ctx;
}
