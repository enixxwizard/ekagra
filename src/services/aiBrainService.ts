import type { DayFlowState } from '../types/dayflow';
import type { EkuWorkspaceSnapshot, ScheduleEnhancementSuggestion } from '../types/eku';
import {
  getCurrentLocalMinutes,
  getLocalTimeZoneName,
  getTodayISO,
} from '../utils/dateTime';
import { stripActivitiesAndTasksForEku } from '../utils/scheduleEngine';

export interface AiBrainAuthCreds {
  accessToken?: string | null;
  isGuest: boolean;
}

export type ScheduleEnhancementFallbackReason =
  | 'missing_key'
  | 'invalid_key'
  | 'quota_exhausted'
  | 'model_unavailable'
  | 'network_error'
  | 'upstream_error';

export interface ScheduleEnhancementApiResult {
  source: 'gemini' | 'algorithmic';
  cached: boolean;
  modelUsed: string | null;
  fallbackReason: ScheduleEnhancementFallbackReason | null;
  notice: string | null;
  summary: string;
  coachTips: string[];
  stats: {
    overlapsCount: number;
    overloadedDaysCount: number;
    deadlineRisksCount: number;
    unscheduledTasksCount: number;
    breakGapsCount: number;
  };
  suggestions: ScheduleEnhancementSuggestion[];
}

const CLIENT_CACHE_TTL_MS = 10 * 60 * 1000;
const clientCache = new Map<string, { expiresAt: number; data: ScheduleEnhancementApiResult }>();

export function buildWorkspaceSnapshotForAi(
  state: DayFlowState,
  remainingSeconds: number
): EkuWorkspaceSnapshot {
  const todayISO = getTodayISO();
  const { activities, tasks } = stripActivitiesAndTasksForEku(state.activities, state.tasks);
  const todayFocusMinutes = state.focusSessions
    .filter((s) => s.date === todayISO && s.mode === 'focus')
    .reduce((sum, s) => sum + s.actualMinutes, 0);
  const weeklyFocusMinutes = state.focusSessions
    .filter((s) => s.mode === 'focus')
    .slice(0, 35)
    .reduce((sum, s) => sum + s.actualMinutes, 0);
  const linkedTitle = state.activeTimer.linkedActivityId
    ? state.activities.find((a) => a.id === state.activeTimer.linkedActivityId)?.title ?? null
    : null;

  return {
    todayISO,
    nowMinutes: getCurrentLocalMinutes(),
    timeZone: getLocalTimeZoneName(),
    dailyCapacityHours: state.settings.dailyCapacityHours,
    preferredLanguage: state.settings.preferredResourceLanguage ?? null,
    activities,
    tasks,
    focusSummary: {
      timerStatus: state.activeTimer.status,
      timerMode: state.activeTimer.mode,
      remainingMinutes: Math.max(0, Math.ceil(remainingSeconds / 60)),
      linkedActivityTitle: linkedTitle,
      todayFocusMinutes,
      weeklyFocusMinutes,
      todayHabitsCompleted: (state.habitLogs[todayISO] ?? []).length,
      totalHabits: state.habits.length,
    },
  };
}

export function computeClientSnapshotKey(snapshot: EkuWorkspaceSnapshot): string {
  const bucket = Math.floor(snapshot.nowMinutes / 15);
  return JSON.stringify({
    d: snapshot.todayISO,
    b: bucket,
    c: snapshot.dailyCapacityHours,
    a: snapshot.activities.map((a) => [
      a.id,
      a.title,
      a.date,
      a.startTime,
      a.endTime,
      a.status,
      a.priority,
      a.recurrence?.frequency,
      a.excludedDates?.length ?? 0,
      Object.keys(a.occurrenceOverrides ?? {}).length,
    ]),
    t: snapshot.tasks.map((t) => [
      t.id,
      t.title,
      t.priority,
      t.dueDate,
      t.completed,
      t.estimatedMinutes,
      t.scheduledActivityId,
    ]),
  });
}

export function buildAuthHeaders(creds: AiBrainAuthCreds): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (creds.accessToken && !creds.isGuest) {
    headers.Authorization = `Bearer ${creds.accessToken}`;
  } else {
    headers['X-Ekagra-Mode'] = 'guest';
  }
  return headers;
}

export async function requestScheduleEnhancement(
  creds: AiBrainAuthCreds,
  snapshot: EkuWorkspaceSnapshot,
  forceRefresh = false
): Promise<ScheduleEnhancementApiResult> {
  const cacheKey = computeClientSnapshotKey(snapshot);
  if (!forceRefresh) {
    const cached = clientCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.data, cached: true };
    }
  }

  let response: Response;
  try {
    response = await fetch('/api/ai/enhance', {
      method: 'POST',
      headers: buildAuthHeaders(creds),
      body: JSON.stringify({ snapshot, forceRefresh }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Error(
      isTimeout
        ? 'Network timeout while waiting for schedule analysis. Please check your connection and retry.'
        : 'Network error: could not reach the Ekagra backend server. Check your internet connection and retry.'
    );
  }

  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text().catch(() => '');
  const trimmed = rawText.trim();
  const isHtml =
    contentType.includes('text/html') ||
    /^<!doctype\s+html/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed);

  let parsed: (Partial<ScheduleEnhancementApiResult> & { error?: string }) | null = null;
  if (trimmed && !isHtml) {
    try {
      parsed = JSON.parse(trimmed) as Partial<ScheduleEnhancementApiResult> & { error?: string };
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        parsed?.error || 'Authentication or API credential verification failed. Please retry.'
      );
    }
    if (response.status === 429) {
      throw new Error(parsed?.error || 'Quota or rate limit exceeded. Please wait briefly and retry.');
    }
    throw new Error(
      parsed?.error ||
        (response.status >= 500
          ? 'Ekagra server error while analyzing your schedule. Please retry.'
          : `Request failed (HTTP ${response.status}).`)
    );
  }

  if (!parsed || isHtml || typeof parsed.summary !== 'string' || !Array.isArray(parsed.suggestions)) {
    throw new Error('Received an unexpected response from the server. Please retry.');
  }

  const result: ScheduleEnhancementApiResult = {
    source: parsed.source === 'algorithmic' ? 'algorithmic' : 'gemini',
    cached: Boolean(parsed.cached),
    modelUsed: typeof parsed.modelUsed === 'string' ? parsed.modelUsed : null,
    fallbackReason:
      typeof parsed.fallbackReason === 'string' ? parsed.fallbackReason : null,
    notice: typeof parsed.notice === 'string' ? parsed.notice : null,
    summary: parsed.summary,
    coachTips: Array.isArray(parsed.coachTips) ? parsed.coachTips : [],
    stats: parsed.stats ?? {
      overlapsCount: 0,
      overloadedDaysCount: 0,
      deadlineRisksCount: 0,
      unscheduledTasksCount: 0,
      breakGapsCount: 0,
    },
    suggestions: parsed.suggestions,
  };

  if (result.source === 'gemini') {
    if (clientCache.size >= 15) {
      const oldest = clientCache.keys().next().value;
      if (oldest) clientCache.delete(oldest);
    }
    clientCache.set(cacheKey, {
      expiresAt: Date.now() + CLIENT_CACHE_TTL_MS,
      data: result,
    });
  }

  return result;
}
