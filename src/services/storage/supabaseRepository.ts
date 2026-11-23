import { supabase } from '../../lib/supabase';
import type {
  ActivityCategory,
  ActivityColor,
  AppSettings,
  DayFlowState,
  FocusSession,
  HabitItem,
  PriorityLevel,
  QuickNote,
  ScheduleActivity,
  StudyQuotation,
  TaskItem,
} from '../../types/dayflow';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_ACTIVE_TIMER,
  DEFAULT_SETTINGS,
} from './repository';
import { normalizeThemeMode } from '../../utils/theme';

export interface CloudLoadResult {
  state: DayFlowState;
  schemaReady: boolean;
  warning?: string;
}

function isSchemaMissingError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const msg = (error.message ?? '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    msg.includes('does not exist') ||
    msg.includes('could not find the table')
  );
}

function isMissingColumnError(
  error: { code?: string; message?: string } | null,
  colName: string
): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const msg = (error.message ?? '').toLowerCase();
  return (
    code === 'PGRST204' ||
    code === '42703' ||
    msg.includes(colName.toLowerCase()) ||
    msg.includes('column')
  );
}

function readAutoSyncFallback(userId: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(`ekagra_auto_sync_pref_${userId}`);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // Ignore storage read errors
  }
  return fallback;
}

function writeAutoSyncFallback(userId: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`ekagra_auto_sync_pref_${userId}`, value ? 'true' : 'false');
  } catch {
    // Ignore storage write errors
  }
}

function readEkuPrefFallback(userId: string): {
  preferredResourceLanguage: string | null;
  ekuMuted: boolean;
} {
  if (typeof window === 'undefined') {
    return { preferredResourceLanguage: null, ekuMuted: false };
  }
  try {
    const raw = window.localStorage.getItem(`ekagra_eku_prefs_${userId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        preferredResourceLanguage:
          typeof parsed.preferredResourceLanguage === 'string' &&
          parsed.preferredResourceLanguage.trim()
            ? parsed.preferredResourceLanguage.trim().slice(0, 40)
            : null,
        ekuMuted: Boolean(parsed.ekuMuted),
      };
    }
  } catch {
    // Ignore storage read errors
  }
  return { preferredResourceLanguage: null, ekuMuted: false };
}

function writeEkuPrefFallback(
  userId: string,
  preferredResourceLanguage: string | null | undefined,
  ekuMuted: boolean | undefined
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      `ekagra_eku_prefs_${userId}`,
      JSON.stringify({
        preferredResourceLanguage: preferredResourceLanguage ?? null,
        ekuMuted: Boolean(ekuMuted),
      })
    );
  } catch {
    // Ignore storage write errors
  }
}

function sanitizeCategory(raw: unknown): ActivityCategory {
  if (
    raw === 'Work' ||
    raw === 'Study' ||
    raw === 'Health' ||
    raw === 'Personal' ||
    raw === 'Deep Focus' ||
    raw === 'Admin'
  ) {
    return raw;
  }
  return 'Study';
}

function sanitizeColor(raw: unknown): ActivityColor {
  if (
    raw === 'indigo' ||
    raw === 'emerald' ||
    raw === 'amber' ||
    raw === 'sky' ||
    raw === 'rose' ||
    raw === 'violet' ||
    raw === 'slate'
  ) {
    return raw;
  }
  return 'indigo';
}

function sanitizePriority(raw: unknown): PriorityLevel {
  return raw === 'low' || raw === 'high' ? raw : 'medium';
}

export class SupabaseDayFlowRepository {
  async loadForUser(userId: string, displayNameFallback?: string | null): Promise<CloudLoadResult> {
    const emptySettings: AppSettings = {
      ...DEFAULT_SETTINGS,
      userName: displayNameFallback?.trim() || DEFAULT_SETTINGS.userName,
    };

    const emptyState: DayFlowState = {
      version: CURRENT_SCHEMA_VERSION,
      tasks: [],
      activities: [],
      focusSessions: [],
      activeTimer: { ...DEFAULT_ACTIVE_TIMER },
      habits: [],
      habitLogs: {},
      notes: [],
      quotations: [],
      importedFingerprints: [],
      settings: emptySettings,
    };

    if (!supabase) {
      return {
        state: emptyState,
        schemaReady: false,
        warning: 'Supabase client is not configured.',
      };
    }

    const [
      prefsRes,
      tasksRes,
      activitiesRes,
      sessionsRes,
      habitsRes,
      habitLogsRes,
      notesRes,
      quotesRes,
      fingerprintsRes,
    ] = await Promise.all([
      supabase.from('user_preferences').select('*').eq('user_id', userId).maybeSingle(),
      supabase.from('tasks').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      supabase.from('activities').select('*').eq('user_id', userId).order('date', { ascending: true }),
      supabase.from('focus_sessions').select('*').eq('user_id', userId).order('started_at', { ascending: false }),
      supabase.from('habits').select('*').eq('user_id', userId).order('created_at', { ascending: true }),
      supabase.from('habit_logs').select('*').eq('user_id', userId),
      supabase.from('quick_notes').select('*').eq('user_id', userId).order('updated_at', { ascending: false }),
      supabase.from('study_quotations').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
      supabase.from('imported_fingerprints').select('fingerprint').eq('user_id', userId),
    ]);

    const firstError =
      prefsRes.error ||
      tasksRes.error ||
      activitiesRes.error ||
      sessionsRes.error ||
      habitsRes.error ||
      habitLogsRes.error ||
      notesRes.error ||
      quotesRes.error ||
      fingerprintsRes.error;

    if (firstError) {
      if (isSchemaMissingError(firstError)) {
        return {
          state: emptyState,
          schemaReady: false,
          warning:
            'Supabase database tables have not been created yet. Run the SQL migration in Supabase SQL Editor to enable cloud sync.',
        };
      }
      throw new Error(firstError.message);
    }

    const prefs = prefsRes.data as Record<string, unknown> | null;
    const settings: AppSettings = {
      userName:
        typeof prefs?.user_name === 'string' && prefs.user_name.trim()
          ? prefs.user_name
          : emptySettings.userName,
      theme:
        prefs?.theme !== undefined && prefs?.theme !== null
          ? normalizeThemeMode(prefs.theme)
          : DEFAULT_SETTINGS.theme,
      timeFormat:
        prefs?.time_format === '12h' || prefs?.time_format === '24h'
          ? prefs.time_format
          : DEFAULT_SETTINGS.timeFormat,
      weekStart:
        prefs?.week_start === 'monday' || prefs?.week_start === 'sunday'
          ? prefs.week_start
          : DEFAULT_SETTINGS.weekStart,
      defaultFocusMinutes:
        typeof prefs?.default_focus_minutes === 'number'
          ? prefs.default_focus_minutes
          : DEFAULT_SETTINGS.defaultFocusMinutes,
      shortBreakMinutes:
        typeof prefs?.short_break_minutes === 'number'
          ? prefs.short_break_minutes
          : DEFAULT_SETTINGS.shortBreakMinutes,
      longBreakMinutes:
        typeof prefs?.long_break_minutes === 'number'
          ? prefs.long_break_minutes
          : DEFAULT_SETTINGS.longBreakMinutes,
      soundAlerts:
        typeof prefs?.sound_alerts === 'boolean' ? prefs.sound_alerts : DEFAULT_SETTINGS.soundAlerts,
      notificationsEnabled:
        typeof prefs?.notifications_enabled === 'boolean'
          ? prefs.notifications_enabled
          : DEFAULT_SETTINGS.notificationsEnabled,
      reminderLeadMinutes:
        prefs?.reminder_lead_minutes === 0 ||
        prefs?.reminder_lead_minutes === 5 ||
        prefs?.reminder_lead_minutes === 10 ||
        prefs?.reminder_lead_minutes === 15
          ? prefs.reminder_lead_minutes
          : DEFAULT_SETTINGS.reminderLeadMinutes,
      dailyCapacityHours:
        typeof prefs?.daily_capacity_hours === 'number'
          ? prefs.daily_capacity_hours
          : DEFAULT_SETTINGS.dailyCapacityHours,
      preferredMusicUrl:
        typeof prefs?.preferred_music_url === 'string' && prefs.preferred_music_url.trim()
          ? prefs.preferred_music_url
          : null,
      autoSyncPdfSchedule:
        typeof prefs?.auto_sync_pdf_schedule === 'boolean'
          ? prefs.auto_sync_pdf_schedule
          : readAutoSyncFallback(userId, DEFAULT_SETTINGS.autoSyncPdfSchedule),
      preferredResourceLanguage: readEkuPrefFallback(userId).preferredResourceLanguage,
      ekuMuted: readEkuPrefFallback(userId).ekuMuted,
    };

    const tasks: TaskItem[] = (tasksRes.data ?? []).map((t: Record<string, unknown>) => ({
      id: String(t.id),
      title: String(t.title),
      description: typeof t.description === 'string' ? t.description : '',
      priority: sanitizePriority(t.priority),
      dueDate: typeof t.due_date === 'string' ? t.due_date : null,
      category: sanitizeCategory(t.category),
      completed: Boolean(t.completed),
      completedAt: typeof t.completed_at === 'string' ? t.completed_at : null,
      estimatedMinutes: typeof t.estimated_minutes === 'number' ? t.estimated_minutes : 30,
      scheduledActivityId:
        typeof t.scheduled_activity_id === 'string' ? t.scheduled_activity_id : null,
      createdAt: String(t.created_at ?? new Date().toISOString()),
      updatedAt: String(t.updated_at ?? new Date().toISOString()),
    }));

    const activities: ScheduleActivity[] = (activitiesRes.data ?? []).map(
      (a: Record<string, unknown>) => ({
        id: String(a.id),
        title: String(a.title),
        description: typeof a.description === 'string' ? a.description : '',
        date: String(a.date),
        startTime: String(a.start_time),
        endTime: String(a.end_time),
        category: sanitizeCategory(a.category),
        color: sanitizeColor(a.color),
        priority: sanitizePriority(a.priority),
        status:
          a.status === 'completed' || a.status === 'skipped' || a.status === 'pending'
            ? a.status
            : 'pending',
        linkedTaskId: typeof a.linked_task_id === 'string' ? a.linked_task_id : null,
        recurrence: (a.recurrence as ScheduleActivity['recurrence']) ?? {
          frequency: 'none',
          endDate: null,
        },
        excludedDates: Array.isArray(a.excluded_dates) ? (a.excluded_dates as string[]) : [],
        occurrenceOverrides:
          (a.occurrence_overrides as ScheduleActivity['occurrenceOverrides']) ?? {},
        createdAt: String(a.created_at ?? new Date().toISOString()),
        updatedAt: String(a.updated_at ?? new Date().toISOString()),
      })
    );

    const focusSessions: FocusSession[] = (sessionsRes.data ?? []).map(
      (s: Record<string, unknown>) => ({
        id: String(s.id),
        activityId: typeof s.activity_id === 'string' ? s.activity_id : null,
        activityTitle: typeof s.activity_title === 'string' ? s.activity_title : null,
        category: sanitizeCategory(s.category),
        mode:
          s.mode === 'short_break' || s.mode === 'long_break' ? s.mode : 'focus',
        plannedMinutes: typeof s.planned_minutes === 'number' ? s.planned_minutes : 25,
        actualMinutes: typeof s.actual_minutes === 'number' ? s.actual_minutes : 25,
        startedAt: String(s.started_at),
        endedAt: String(s.ended_at),
        date: String(s.date),
        completed: Boolean(s.completed),
        reflection: typeof s.reflection === 'string' ? s.reflection : null,
      })
    );

    const habits: HabitItem[] = (habitsRes.data ?? []).map((h: Record<string, unknown>) => ({
      id: String(h.id),
      title: String(h.title),
      description: typeof h.description === 'string' ? h.description : '',
      frequency: h.frequency === 'weekly' ? 'weekly' : 'daily',
      targetPerWeek: typeof h.target_per_week === 'number' ? h.target_per_week : 7,
      category: sanitizeCategory(h.category),
      color: sanitizeColor(h.color),
      createdAt: String(h.created_at ?? new Date().toISOString().slice(0, 10)),
    }));

    const habitLogs: Record<string, string[]> = {};
    for (const row of habitLogsRes.data ?? []) {
      const logDate = String((row as Record<string, unknown>).log_date);
      const habitId = String((row as Record<string, unknown>).habit_id);
      if (!habitLogs[logDate]) habitLogs[logDate] = [];
      if (!habitLogs[logDate].includes(habitId)) {
        habitLogs[logDate].push(habitId);
      }
    }

    const notes: QuickNote[] = (notesRes.data ?? []).map((n: Record<string, unknown>) => ({
      id: String(n.id),
      title: typeof n.title === 'string' ? n.title : '',
      content: typeof n.content === 'string' ? n.content : '',
      category: sanitizeCategory(n.category),
      linkedTaskId: typeof n.linked_task_id === 'string' ? n.linked_task_id : null,
      linkedActivityId:
        typeof n.linked_activity_id === 'string' ? n.linked_activity_id : null,
      linkedFocusSessionId:
        typeof n.linked_focus_session_id === 'string' ? n.linked_focus_session_id : null,
      sourceQuotationId:
        typeof n.source_quotation_id === 'string' ? n.source_quotation_id : null,
      createdAt: String(n.created_at ?? new Date().toISOString()),
      updatedAt: String(n.updated_at ?? new Date().toISOString()),
    }));

    const quotations: StudyQuotation[] = (quotesRes.data ?? []).map(
      (q: Record<string, unknown>) => ({
        id: String(q.id),
        text: String(q.text),
        sourceFile: typeof q.source_file === 'string' ? q.source_file : 'Imported PDF',
        pageNumber: typeof q.page_number === 'number' ? q.page_number : null,
        category: sanitizeCategory(q.category),
        dateCaptured: String(q.date_captured ?? new Date().toISOString().slice(0, 10)),
        createdAt: String(q.created_at ?? new Date().toISOString()),
      })
    );

    const importedFingerprints: string[] = (fingerprintsRes.data ?? []).map(
      (f: Record<string, unknown>) => String(f.fingerprint)
    );

    return {
      state: {
        version: CURRENT_SCHEMA_VERSION,
        tasks,
        activities,
        focusSessions,
        activeTimer: {
          ...DEFAULT_ACTIVE_TIMER,
          durationSeconds: settings.defaultFocusMinutes * 60,
        },
        habits,
        habitLogs,
        notes,
        quotations,
        importedFingerprints,
        settings,
      },
      schemaReady: true,
    };
  }

  private assertNoDbError(context: string, error: { message?: string } | null): void {
    if (error) {
      throw new Error(`${context}: ${error.message || 'Database write failed'}`);
    }
  }

  async saveForUser(userId: string, state: DayFlowState): Promise<void> {
    if (!supabase) return;

    const prefsPayload: Record<string, unknown> = {
      user_id: userId,
      user_name: state.settings.userName,
      theme: state.settings.theme,
      time_format: state.settings.timeFormat,
      week_start: state.settings.weekStart,
      default_focus_minutes: state.settings.defaultFocusMinutes,
      short_break_minutes: state.settings.shortBreakMinutes,
      long_break_minutes: state.settings.longBreakMinutes,
      sound_alerts: state.settings.soundAlerts,
      notifications_enabled: state.settings.notificationsEnabled,
      reminder_lead_minutes: state.settings.reminderLeadMinutes,
      daily_capacity_hours: state.settings.dailyCapacityHours,
      preferred_music_url: state.settings.preferredMusicUrl,
      auto_sync_pdf_schedule: state.settings.autoSyncPdfSchedule,
      updated_at: new Date().toISOString(),
    };

    writeAutoSyncFallback(userId, state.settings.autoSyncPdfSchedule);
    writeEkuPrefFallback(
      userId,
      state.settings.preferredResourceLanguage,
      state.settings.ekuMuted
    );

    let activePrefsPayload: Record<string, unknown> = { ...prefsPayload };
    let { error: prefsError } = await supabase
      .from('user_preferences')
      .upsert(activePrefsPayload, { onConflict: 'user_id' });

    if (prefsError && isMissingColumnError(prefsError, 'auto_sync_pdf_schedule')) {
      const { auto_sync_pdf_schedule: _omit, ...withoutAutoSync } = activePrefsPayload;
      activePrefsPayload = withoutAutoSync;
      const retryCol = await supabase
        .from('user_preferences')
        .upsert(activePrefsPayload, { onConflict: 'user_id' });
      prefsError = retryCol.error;
    }

    if (
      prefsError &&
      (prefsError.code === '23514' || (prefsError.message ?? '').toLowerCase().includes('theme'))
    ) {
      const legacyTheme =
        state.settings.theme === 'midnight' || state.settings.theme === 'slate'
          ? 'dark'
          : state.settings.theme === 'system'
            ? 'system'
            : 'light';
      const retry = await supabase
        .from('user_preferences')
        .upsert({ ...activePrefsPayload, theme: legacyTheme }, { onConflict: 'user_id' });
      prefsError = retry.error;
    }
    this.assertNoDbError('Failed saving preferences', prefsError);

    if (state.tasks.length > 0) {
      const { error } = await supabase.from('tasks').upsert(
        state.tasks.map((t) => ({
          id: t.id,
          user_id: userId,
          title: t.title,
          description: t.description,
          priority: t.priority,
          due_date: t.dueDate,
          category: t.category,
          completed: t.completed,
          completed_at: t.completedAt,
          estimated_minutes: t.estimatedMinutes,
          scheduled_activity_id: t.scheduledActivityId,
          created_at: t.createdAt,
          updated_at: t.updatedAt,
        })),
        { onConflict: 'user_id,id' }
      );
      this.assertNoDbError('Failed saving tasks', error);
    }
    await this.reconcileDeletions('tasks', userId, state.tasks.map((t) => t.id));

    if (state.activities.length > 0) {
      const { error } = await supabase.from('activities').upsert(
        state.activities.map((a) => ({
          id: a.id,
          user_id: userId,
          title: a.title,
          description: a.description,
          date: a.date,
          start_time: a.startTime,
          end_time: a.endTime,
          category: a.category,
          color: a.color,
          priority: a.priority,
          status: a.status,
          linked_task_id: a.linkedTaskId,
          recurrence: a.recurrence,
          excluded_dates: a.excludedDates ?? [],
          occurrence_overrides: a.occurrenceOverrides ?? {},
          created_at: a.createdAt,
          updated_at: a.updatedAt,
        })),
        { onConflict: 'user_id,id' }
      );
      this.assertNoDbError('Failed saving activities', error);
    }
    await this.reconcileDeletions('activities', userId, state.activities.map((a) => a.id));

    if (state.focusSessions.length > 0) {
      const baseSessions = state.focusSessions.map((s) => ({
        id: s.id,
        user_id: userId,
        activity_id: s.activityId,
        activity_title: s.activityTitle,
        category: s.category,
        mode: s.mode,
        planned_minutes: s.plannedMinutes,
        actual_minutes: s.actualMinutes,
        started_at: s.startedAt,
        ended_at: s.endedAt,
        date: s.date,
        completed: s.completed,
      }));
      let { error } = await supabase.from('focus_sessions').upsert(
        baseSessions.map((row, idx) => ({
          ...row,
          reflection: state.focusSessions[idx].reflection ?? null,
        })),
        { onConflict: 'user_id,id' }
      );
      if (
        error &&
        (error.code === 'PGRST204' ||
          error.code === '42703' ||
          (error.message ?? '').toLowerCase().includes('reflection'))
      ) {
        const retry = await supabase
          .from('focus_sessions')
          .upsert(baseSessions, { onConflict: 'user_id,id' });
        error = retry.error;
      }
      this.assertNoDbError('Failed saving focus sessions', error);
    }
    await this.reconcileDeletions(
      'focus_sessions',
      userId,
      state.focusSessions.map((s) => s.id)
    );

    if (state.habits.length > 0) {
      const { error } = await supabase.from('habits').upsert(
        state.habits.map((h) => ({
          id: h.id,
          user_id: userId,
          title: h.title,
          description: h.description,
          frequency: h.frequency,
          target_per_week: h.targetPerWeek,
          category: h.category,
          color: h.color,
          created_at: h.createdAt,
        })),
        { onConflict: 'user_id,id' }
      );
      this.assertNoDbError('Failed saving habits', error);
    }
    await this.reconcileDeletions('habits', userId, state.habits.map((h) => h.id));

    // Sync habit logs
    const desiredLogRows: Array<{ user_id: string; habit_id: string; log_date: string }> = [];
    for (const [dateKey, habitIds] of Object.entries(state.habitLogs)) {
      for (const habitId of habitIds) {
        desiredLogRows.push({ user_id: userId, habit_id: habitId, log_date: dateKey });
      }
    }
    if (desiredLogRows.length > 0) {
      const { error } = await supabase
        .from('habit_logs')
        .upsert(desiredLogRows, { onConflict: 'user_id,habit_id,log_date', ignoreDuplicates: true });
      this.assertNoDbError('Failed saving habit logs', error);
    }
    const { data: existingLogRows, error: fetchLogsError } = await supabase
      .from('habit_logs')
      .select('habit_id,log_date')
      .eq('user_id', userId);
    this.assertNoDbError('Failed reading habit logs', fetchLogsError);
    if (existingLogRows) {
      const desiredSet = new Set(desiredLogRows.map((r) => `${r.habit_id}::${r.log_date}`));
      for (const row of existingLogRows as Array<{ habit_id: string; log_date: string }>) {
        if (!desiredSet.has(`${row.habit_id}::${row.log_date}`)) {
          const { error: deleteLogError } = await supabase
            .from('habit_logs')
            .delete()
            .eq('user_id', userId)
            .eq('habit_id', row.habit_id)
            .eq('log_date', row.log_date);
          this.assertNoDbError('Failed reconciling habit logs', deleteLogError);
        }
      }
    }

    if (state.notes.length > 0) {
      const { error } = await supabase.from('quick_notes').upsert(
        state.notes.map((n) => ({
          id: n.id,
          user_id: userId,
          title: n.title,
          content: n.content,
          category: n.category,
          linked_task_id: n.linkedTaskId,
          linked_activity_id: n.linkedActivityId,
          linked_focus_session_id: n.linkedFocusSessionId,
          source_quotation_id: n.sourceQuotationId ?? null,
          created_at: n.createdAt,
          updated_at: n.updatedAt,
        })),
        { onConflict: 'user_id,id' }
      );
      this.assertNoDbError('Failed saving notes', error);
    }
    await this.reconcileDeletions('quick_notes', userId, state.notes.map((n) => n.id));

    if (state.quotations.length > 0) {
      const { error } = await supabase.from('study_quotations').upsert(
        state.quotations.map((q) => ({
          id: q.id,
          user_id: userId,
          text: q.text,
          source_file: q.sourceFile,
          page_number: q.pageNumber,
          category: q.category,
          date_captured: q.dateCaptured,
          created_at: q.createdAt,
        })),
        { onConflict: 'user_id,id' }
      );
      this.assertNoDbError('Failed saving study quotations', error);
    }
    await this.reconcileDeletions(
      'study_quotations',
      userId,
      state.quotations.map((q) => q.id)
    );

    if (state.importedFingerprints.length > 0) {
      const { error } = await supabase.from('imported_fingerprints').upsert(
        state.importedFingerprints.map((fp) => ({
          user_id: userId,
          fingerprint: fp,
        })),
        { onConflict: 'user_id,fingerprint', ignoreDuplicates: true }
      );
      this.assertNoDbError('Failed saving import fingerprints', error);
    }
  }

  private async reconcileDeletions(
    table: string,
    userId: string,
    keepIds: string[]
  ): Promise<void> {
    if (!supabase) return;
    const { data, error } = await supabase.from(table).select('id').eq('user_id', userId);
    this.assertNoDbError(`Failed reading ${table} for sync`, error);
    if (!data) return;
    const keepSet = new Set(keepIds);
    const toDelete = (data as Array<{ id: string }>)
      .map((r) => r.id)
      .filter((id) => !keepSet.has(id));
    if (toDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from(table)
        .delete()
        .eq('user_id', userId)
        .in('id', toDelete);
      this.assertNoDbError(`Failed removing deleted rows in ${table}`, deleteError);
    }
  }
}

export const supabaseDayFlowRepository = new SupabaseDayFlowRepository();
