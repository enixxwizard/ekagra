import { supabase } from '../lib/supabase';
import type { GuestMigrationSummary, MigrationResult } from '../types/auth';
import type { DayFlowState } from '../types/dayflow';
import { STORAGE_KEY } from './storage/repository';

export const GUEST_MODE_KEY = 'dayflow_guest_mode_v1';

export function isGuestModePersisted(): boolean {
  try {
    return localStorage.getItem(GUEST_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setGuestModePersisted(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(GUEST_MODE_KEY, 'true');
    } else {
      localStorage.removeItem(GUEST_MODE_KEY);
    }
  } catch {
    // Ignore storage error
  }
}

export function detectGuestData(): GuestMigrationSummary {
  const empty: GuestMigrationSummary = {
    hasData: false,
    tasksCount: 0,
    activitiesCount: 0,
    focusSessionsCount: 0,
    habitsCount: 0,
    notesCount: 0,
    quotationsCount: 0,
    rawState: null,
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<DayFlowState>;
    if (!parsed || typeof parsed !== 'object') return empty;

    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const activities = Array.isArray(parsed.activities) ? parsed.activities : [];
    const focusSessions = Array.isArray(parsed.focusSessions) ? parsed.focusSessions : [];
    const habits = Array.isArray(parsed.habits) ? parsed.habits : [];
    const notes = Array.isArray(parsed.notes) ? parsed.notes : [];
    const quotations = Array.isArray(parsed.quotations) ? parsed.quotations : [];

    const total =
      tasks.length +
      activities.length +
      focusSessions.length +
      habits.length +
      notes.length +
      quotations.length;

    if (total === 0) return empty;

    return {
      hasData: true,
      tasksCount: tasks.length,
      activitiesCount: activities.length,
      focusSessionsCount: focusSessions.length,
      habitsCount: habits.length,
      notesCount: notes.length,
      quotationsCount: quotations.length,
      rawState: parsed as DayFlowState,
    };
  } catch {
    return empty;
  }
}

export function clearMigratedGuestData(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(GUEST_MODE_KEY);
  } catch {
    // Ignore storage clear error
  }
}

/**
 * Imports local guest data into the authenticated user's Supabase records.
 * - Never overwrites existing cloud records (deduplicates by ID and natural keys).
 * - Throws on error so local guest data stays intact if migration fails.
 */
export async function migrateGuestDataToAccount(
  userId: string,
  guestState: DayFlowState
): Promise<MigrationResult> {
  if (!supabase) {
    throw new Error('Supabase is not configured. Local guest data was kept intact.');
  }

  let skippedDuplicates = 0;

  // Fetch existing cloud identifiers + natural keys so we never overwrite or duplicate
  const [
    existingTasksRes,
    existingActsRes,
    existingSessionsRes,
    existingHabitsRes,
    existingNotesRes,
    existingQuotesRes,
  ] = await Promise.all([
    supabase.from('tasks').select('id,title,due_date').eq('user_id', userId),
    supabase.from('activities').select('id,title,date,start_time').eq('user_id', userId),
    supabase.from('focus_sessions').select('id,started_at').eq('user_id', userId),
    supabase.from('habits').select('id,title').eq('user_id', userId),
    supabase.from('quick_notes').select('id,title,content').eq('user_id', userId),
    supabase.from('study_quotations').select('id,text').eq('user_id', userId),
  ]);

  const probeError =
    existingTasksRes.error ||
    existingActsRes.error ||
    existingSessionsRes.error ||
    existingHabitsRes.error ||
    existingNotesRes.error ||
    existingQuotesRes.error;

  if (probeError) {
    throw new Error(
      `Could not verify cloud tables before migration (${probeError.message}). Your local guest data was not modified.`
    );
  }

  const existingTaskIds = new Set((existingTasksRes.data ?? []).map((r) => String(r.id)));
  const existingTaskKeys = new Set(
    (existingTasksRes.data ?? []).map(
      (r) => `${String(r.title).trim().toLowerCase()}::${String(r.due_date ?? '')}`
    )
  );
  const newTasks = (guestState.tasks ?? []).filter((t) => {
    const key = `${t.title.trim().toLowerCase()}::${t.dueDate ?? ''}`;
    if (existingTaskIds.has(t.id) || existingTaskKeys.has(key)) {
      skippedDuplicates += 1;
      return false;
    }
    return true;
  });

  if (newTasks.length > 0) {
    const { error } = await supabase.from('tasks').insert(
      newTasks.map((t) => ({
        id: t.id,
        user_id: userId,
        title: t.title,
        description: t.description ?? '',
        priority: t.priority,
        due_date: t.dueDate,
        category: t.category,
        completed: t.completed,
        completed_at: t.completedAt,
        estimated_minutes: t.estimatedMinutes,
        scheduled_activity_id: t.scheduledActivityId,
        created_at: t.createdAt,
        updated_at: t.updatedAt,
      }))
    );
    if (error) throw new Error(`Task migration failed: ${error.message}`);
  }

  const existingActIds = new Set((existingActsRes.data ?? []).map((r) => String(r.id)));
  const existingActKeys = new Set(
    (existingActsRes.data ?? []).map(
      (r) =>
        `${String(r.title).trim().toLowerCase()}::${String(r.date)}::${String(r.start_time)}`
    )
  );
  const newActivities = (guestState.activities ?? []).filter((a) => {
    const key = `${a.title.trim().toLowerCase()}::${a.date}::${a.startTime}`;
    if (existingActIds.has(a.id) || existingActKeys.has(key)) {
      skippedDuplicates += 1;
      return false;
    }
    return true;
  });

  if (newActivities.length > 0) {
    const { error } = await supabase.from('activities').insert(
      newActivities.map((a) => ({
        id: a.id,
        user_id: userId,
        title: a.title,
        description: a.description ?? '',
        date: a.date,
        start_time: a.startTime,
        end_time: a.endTime,
        category: a.category,
        color: a.color,
        priority: a.priority,
        status: a.status,
        linked_task_id: a.linkedTaskId,
        recurrence: a.recurrence ?? { frequency: 'none', endDate: null },
        excluded_dates: a.excludedDates ?? [],
        occurrence_overrides: a.occurrenceOverrides ?? {},
        created_at: a.createdAt,
        updated_at: a.updatedAt,
      }))
    );
    if (error) throw new Error(`Schedule migration failed: ${error.message}`);
  }

  const existingSessionIds = new Set((existingSessionsRes.data ?? []).map((r) => String(r.id)));
  const existingSessionStarts = new Set(
    (existingSessionsRes.data ?? []).map((r) => String(r.started_at))
  );
  const newSessions = (guestState.focusSessions ?? []).filter((s) => {
    if (existingSessionIds.has(s.id) || existingSessionStarts.has(s.startedAt)) {
      skippedDuplicates += 1;
      return false;
    }
    return true;
  });

  if (newSessions.length > 0) {
    const { error } = await supabase.from('focus_sessions').insert(
      newSessions.map((s) => ({
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
      }))
    );
    if (error) throw new Error(`Focus session migration failed: ${error.message}`);
  }

  const existingHabitIds = new Set((existingHabitsRes.data ?? []).map((r) => String(r.id)));
  const existingHabitTitles = new Set(
    (existingHabitsRes.data ?? []).map((r) => String(r.title).trim().toLowerCase())
  );
  const newHabits = (guestState.habits ?? []).filter((h) => {
    if (existingHabitIds.has(h.id) || existingHabitTitles.has(h.title.trim().toLowerCase())) {
      skippedDuplicates += 1;
      return false;
    }
    return true;
  });

  if (newHabits.length > 0) {
    const { error } = await supabase.from('habits').insert(
      newHabits.map((h) => ({
        id: h.id,
        user_id: userId,
        title: h.title,
        description: h.description ?? '',
        frequency: h.frequency,
        target_per_week: h.targetPerWeek,
        category: h.category,
        color: h.color,
        created_at: h.createdAt,
      }))
    );
    if (error) throw new Error(`Habits migration failed: ${error.message}`);
  }

  // Merge habit logs safely with ignoreDuplicates so existing cloud logs are preserved
  const habitLogRows: Array<{ user_id: string; habit_id: string; log_date: string }> = [];
  for (const [dateKey, ids] of Object.entries(guestState.habitLogs ?? {})) {
    for (const habitId of ids) {
      habitLogRows.push({ user_id: userId, habit_id: habitId, log_date: dateKey });
    }
  }
  if (habitLogRows.length > 0) {
    const { error } = await supabase
      .from('habit_logs')
      .upsert(habitLogRows, { onConflict: 'user_id,habit_id,log_date', ignoreDuplicates: true });
    if (error) throw new Error(`Habit logs migration failed: ${error.message}`);
  }

  const existingNoteIds = new Set((existingNotesRes.data ?? []).map((r) => String(r.id)));
  const existingNoteKeys = new Set(
    (existingNotesRes.data ?? []).map(
      (r) => `${String(r.title).trim().toLowerCase()}::${String(r.content).trim().toLowerCase()}`
    )
  );
  const newNotes = (guestState.notes ?? []).filter((n) => {
    const key = `${n.title.trim().toLowerCase()}::${n.content.trim().toLowerCase()}`;
    if (existingNoteIds.has(n.id) || existingNoteKeys.has(key)) {
      skippedDuplicates += 1;
      return false;
    }
    return true;
  });

  if (newNotes.length > 0) {
    const { error } = await supabase.from('quick_notes').insert(
      newNotes.map((n) => ({
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
      }))
    );
    if (error) throw new Error(`Quick notes migration failed: ${error.message}`);
  }

  const existingQuoteIds = new Set((existingQuotesRes.data ?? []).map((r) => String(r.id)));
  const existingQuoteTexts = new Set(
    (existingQuotesRes.data ?? []).map((r) => String(r.text).trim().toLowerCase())
  );
  const newQuotes = (guestState.quotations ?? []).filter((q) => {
    if (existingQuoteIds.has(q.id) || existingQuoteTexts.has(q.text.trim().toLowerCase())) {
      skippedDuplicates += 1;
      return false;
    }
    return true;
  });

  if (newQuotes.length > 0) {
    const { error } = await supabase.from('study_quotations').insert(
      newQuotes.map((q) => ({
        id: q.id,
        user_id: userId,
        text: q.text,
        source_file: q.sourceFile,
        page_number: q.pageNumber,
        category: q.category,
        date_captured: q.dateCaptured,
        created_at: q.createdAt,
      }))
    );
    if (error) throw new Error(`Quotations migration failed: ${error.message}`);
  }

  if ((guestState.importedFingerprints ?? []).length > 0) {
    const { error } = await supabase.from('imported_fingerprints').upsert(
      guestState.importedFingerprints.map((fp) => ({ user_id: userId, fingerprint: fp })),
      { onConflict: 'user_id,fingerprint', ignoreDuplicates: true }
    );
    if (error) throw new Error(`Import history migration failed: ${error.message}`);
  }

  return {
    importedTasks: newTasks.length,
    importedActivities: newActivities.length,
    importedFocusSessions: newSessions.length,
    importedHabits: newHabits.length,
    importedHabitLogs: habitLogRows.length,
    importedNotes: newNotes.length,
    importedQuotations: newQuotes.length,
    skippedDuplicates,
  };
}
