import { ResolvedActivity, TimeFormat } from '../types/dayflow';
import type { ActiveReminderItem, StoredReminderState } from '../types/reminder';
import { formatTimeDisplay, getCurrentLocalMinutes, parseTimeToMinutes } from './dateTime';

import { idbDelete, idbGet, idbPut, STORE_NAMES } from '../services/storage/indexedDb';
import { publishSyncEvent } from '../services/storage/syncChannel';
import type { ReminderStoreRecord } from '../services/storage/types';

export type NotificationSupportStatus =
  | 'unsupported'
  | 'granted'
  | 'denied'
  | 'default';

export function getNotificationPermissionStatus(): NotificationSupportStatus {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function requestNotificationPermissionFromUser(): Promise<NotificationSupportStatus> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  try {
    const permission = await Notification.requestPermission();
    return permission;
  } catch {
    return Notification.permission;
  }
}

const REMINDER_STORAGE_PREFIX = 'dayflow_reminder_state_v1:';
const RETENTION_MS = 48 * 60 * 60 * 1000;
const reminderMemoryCache = new Map<string, StoredReminderState>();

export function buildReminderKey(act: Pick<ResolvedActivity, 'instanceId' | 'startTime'>): string {
  return `${act.instanceId}::${act.startTime}`;
}

function getStorageKey(scopeKey: string): string {
  return `${REMINDER_STORAGE_PREFIX}${scopeKey || 'guest'}`;
}

function emptyStoredState(): StoredReminderState {
  return {
    dismissedKeys: {},
    triggeredKeys: {},
    snoozedUntilMs: {},
  };
}

function pruneOldEntries(state: StoredReminderState, nowMs = Date.now()): StoredReminderState {
  const cutoff = nowMs - RETENTION_MS;
  const dismissedKeys: Record<string, string> = {};
  for (const [k, iso] of Object.entries(state.dismissedKeys)) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && t >= cutoff) dismissedKeys[k] = iso;
  }
  const triggeredKeys: Record<string, string> = {};
  for (const [k, iso] of Object.entries(state.triggeredKeys)) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && t >= cutoff) triggeredKeys[k] = iso;
  }
  const snoozedUntilMs: StoredReminderState['snoozedUntilMs'] = {};
  for (const [k, entry] of Object.entries(state.snoozedUntilMs)) {
    if (entry && typeof entry.untilMs === 'number' && entry.untilMs >= cutoff) {
      snoozedUntilMs[k] = entry;
    }
  }
  return { dismissedKeys, triggeredKeys, snoozedUntilMs };
}

function normalizeParsedReminderState(parsed: Partial<StoredReminderState> | null | undefined): StoredReminderState {
  if (!parsed || typeof parsed !== 'object') return emptyStoredState();
  return pruneOldEntries({
    dismissedKeys:
      parsed.dismissedKeys && typeof parsed.dismissedKeys === 'object'
        ? parsed.dismissedKeys
        : {},
    triggeredKeys:
      parsed.triggeredKeys && typeof parsed.triggeredKeys === 'object'
        ? parsed.triggeredKeys
        : {},
    snoozedUntilMs:
      parsed.snoozedUntilMs && typeof parsed.snoozedUntilMs === 'object'
        ? parsed.snoozedUntilMs
        : {},
  });
}

export async function hydrateReminderStateFromIndexedDb(scopeKey: string): Promise<StoredReminderState> {
  const normalizedScope = scopeKey || 'guest';
  try {
    const rec = await idbGet<ReminderStoreRecord>(STORE_NAMES.REMINDERS, normalizedScope);
    if (rec?.state) {
      const pruned = normalizeParsedReminderState(rec.state);
      reminderMemoryCache.set(normalizedScope, pruned);
      return pruned;
    }
  } catch {
    // fallback below
  }

  // Migrate any legacy reminder localStorage entry cleanly into IndexedDB
  if (typeof window !== 'undefined') {
    try {
      const legacyKey = getStorageKey(normalizedScope);
      const raw = window.localStorage.getItem(legacyKey);
      if (raw) {
        const migrated = normalizeParsedReminderState(JSON.parse(raw) as Partial<StoredReminderState>);
        reminderMemoryCache.set(normalizedScope, migrated);
        await idbPut(STORE_NAMES.REMINDERS, {
          scopeKey: normalizedScope,
          state: migrated,
          updatedAt: new Date().toISOString(),
        });
        window.localStorage.removeItem(legacyKey);
        return migrated;
      }
    } catch {
      // ignore migration errors
    }
  }

  const fresh = emptyStoredState();
  reminderMemoryCache.set(normalizedScope, fresh);
  return fresh;
}

export function loadStoredReminderState(scopeKey: string): StoredReminderState {
  const normalizedScope = scopeKey || 'guest';
  const cached = reminderMemoryCache.get(normalizedScope);
  if (cached) {
    return pruneOldEntries(cached);
  }
  if (typeof window === 'undefined') return emptyStoredState();
  try {
    const raw = window.localStorage.getItem(getStorageKey(normalizedScope));
    if (!raw) return emptyStoredState();
    const parsed = JSON.parse(raw) as Partial<StoredReminderState>;
    const normalized = normalizeParsedReminderState(parsed);
    reminderMemoryCache.set(normalizedScope, normalized);
    return normalized;
  } catch {
    return emptyStoredState();
  }
}

export function saveStoredReminderState(scopeKey: string, state: StoredReminderState): void {
  const normalizedScope = scopeKey || 'guest';
  const pruned = pruneOldEntries(state);
  reminderMemoryCache.set(normalizedScope, pruned);
  void idbPut(STORE_NAMES.REMINDERS, {
    scopeKey: normalizedScope,
    state: pruned,
    updatedAt: new Date().toISOString(),
  })
    .then(() => {
      publishSyncEvent('reminders', { detail: normalizedScope });
    })
    .catch(() => {
      // ignore IndexedDB transient write errors
    });
}

export function markReminderDismissed(scopeKey: string, key: string): void {
  const current = loadStoredReminderState(scopeKey);
  current.dismissedKeys[key] = new Date().toISOString();
  delete current.snoozedUntilMs[key];
  saveStoredReminderState(scopeKey, current);
}

export function markReminderSnoozed(
  scopeKey: string,
  key: string,
  snoozeMinutes = 5
): { untilMs: number; snoozeCount: number } {
  const current = loadStoredReminderState(scopeKey);
  const prevCount = current.snoozedUntilMs[key]?.snoozeCount ?? 0;
  const next = {
    untilMs: Date.now() + snoozeMinutes * 60 * 1000,
    snoozeCount: prevCount + 1,
  };
  current.snoozedUntilMs[key] = next;
  saveStoredReminderState(scopeKey, current);
  return next;
}

export function clearReminderKeysForActivityIds(scopeKey: string, activityIds: string[]): void {
  if (activityIds.length === 0) return;
  const current = loadStoredReminderState(scopeKey);
  const prefixes = activityIds.map((id) => `${id}::`);
  const shouldRemove = (key: string) => prefixes.some((p) => key.startsWith(p));

  for (const key of Object.keys(current.dismissedKeys)) {
    if (shouldRemove(key)) delete current.dismissedKeys[key];
  }
  for (const key of Object.keys(current.triggeredKeys)) {
    if (shouldRemove(key)) delete current.triggeredKeys[key];
  }
  for (const key of Object.keys(current.snoozedUntilMs)) {
    if (shouldRemove(key)) delete current.snoozedUntilMs[key];
  }
  saveStoredReminderState(scopeKey, current);
}

export function clearAllReminderStateForScope(scopeKey: string): void {
  const normalizedScope = scopeKey || 'guest';
  reminderMemoryCache.delete(normalizedScope);
  void idbDelete(STORE_NAMES.REMINDERS, normalizedScope).catch(() => undefined);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(getStorageKey(normalizedScope));
    } catch {
      // Ignore storage errors
    }
  }
}

function dispatchNativeNotification(
  act: ResolvedActivity,
  leadMinutes: number,
  timeFormat: TimeFormat,
  isSnoozedWakeup: boolean
): void {
  if (
    typeof window === 'undefined' ||
    !('Notification' in window) ||
    Notification.permission !== 'granted'
  ) {
    return;
  }

  const nowMin = getCurrentLocalMinutes();
  const startMin = parseTimeToMinutes(act.startTime);
  const diffMin = startMin - nowMin;

  let whenText: string;
  if (diffMin > 1) {
    whenText = `Starts in ${diffMin} min (${formatTimeDisplay(act.startTime, timeFormat)})`;
  } else if (diffMin >= -1) {
    whenText = `Starting now (${formatTimeDisplay(act.startTime, timeFormat)})`;
  } else {
    whenText = isSnoozedWakeup
      ? `Snoozed reminder (${formatTimeDisplay(act.startTime, timeFormat)})`
      : `Starts at ${formatTimeDisplay(act.startTime, timeFormat)}`;
  }

  if (leadMinutes === 0 && diffMin === 0) {
    whenText = `Starting now (${formatTimeDisplay(act.startTime, timeFormat)})`;
  }

  try {
    new Notification(`Ekagra: ${act.title}`, {
      body: `${whenText} · ${act.category}`,
      tag: `${act.instanceId}::${act.startTime}`,
    });
  } catch {
    // Ignore browser-level notification failures
  }
}

export function evaluateActivityReminders(params: {
  scopeKey: string;
  todayActivities: ResolvedActivity[];
  leadMinutes: 0 | 5 | 10 | 15;
  timeFormat: TimeFormat;
  notificationsEnabled: boolean;
  nowMs?: number;
  nowMinutes?: number;
}): ActiveReminderItem[] {
  const {
    scopeKey,
    todayActivities,
    leadMinutes,
    timeFormat,
    notificationsEnabled,
    nowMs = Date.now(),
    nowMinutes = getCurrentLocalMinutes(),
  } = params;

  const stored = loadStoredReminderState(scopeKey);
  let stateChanged = false;
  const newlyTriggered: ActiveReminderItem[] = [];

  const sorted = [...todayActivities]
    .filter((act) => act.status === 'pending')
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.title.localeCompare(b.title));

  for (const act of sorted) {
    const key = buildReminderKey(act);
    if (stored.dismissedKeys[key]) continue;

    const startMin = parseTimeToMinutes(act.startTime);
    const endMin = parseTimeToMinutes(act.endTime);
    const triggerMin = Math.max(0, startMin - leadMinutes);
    const snoozeEntry = stored.snoozedUntilMs[key];

    // 1. Check snoozed wakeup first (survives page refresh while awaiting 5m expiry)
    if (snoozeEntry) {
      if (nowMs >= snoozeEntry.untilMs && nowMinutes < endMin + 30) {
        delete stored.snoozedUntilMs[key];
        stored.triggeredKeys[key] = new Date(nowMs).toISOString();
        stateChanged = true;

        newlyTriggered.push({
          key,
          instanceId: act.instanceId,
          activityId: act.activityId,
          occurrenceDate: act.occurrenceDate,
          title: act.title,
          category: act.category,
          startTime: act.startTime,
          endTime: act.endTime,
          leadMinutes,
          isRecurring: act.isRecurring,
          snoozeCount: snoozeEntry.snoozeCount,
          triggeredAtMs: nowMs,
        });

        if (notificationsEnabled) {
          dispatchNativeNotification(act, leadMinutes, timeFormat, true);
        }
      }
      continue;
    }

    // 2. Initial scheduled trigger window: [triggerMin, endMin - 1] (inclusive of startTime)
    // Using persistent triggeredKeys ensures refreshing the browser NEVER fires duplicate alerts.
    const withinWindow =
      nowMinutes >= triggerMin &&
      nowMinutes <= Math.max(triggerMin + 1, Math.min(startMin + 2, endMin));

    if (withinWindow && !stored.triggeredKeys[key]) {
      stored.triggeredKeys[key] = new Date(nowMs).toISOString();
      stateChanged = true;

      newlyTriggered.push({
        key,
        instanceId: act.instanceId,
        activityId: act.activityId,
        occurrenceDate: act.occurrenceDate,
        title: act.title,
        category: act.category,
        startTime: act.startTime,
        endTime: act.endTime,
        leadMinutes,
        isRecurring: act.isRecurring,
        snoozeCount: 0,
        triggeredAtMs: nowMs,
      });

      if (notificationsEnabled) {
        dispatchNativeNotification(act, leadMinutes, timeFormat, false);
      }
    }
  }

  if (stateChanged) {
    saveStoredReminderState(scopeKey, stored);
  }

  return newlyTriggered;
}

// Keep legacy wrapper signature available for any direct callers
export function checkAndFireActivityReminders(
  todayActivities: ResolvedActivity[],
  leadMinutes: 0 | 5 | 10 | 15,
  timeFormat: TimeFormat,
  notificationsEnabled: boolean,
  onInAppReminder?: (act: ResolvedActivity, leadMinutes: number) => void
): void {
  const fired = evaluateActivityReminders({
    scopeKey: 'guest',
    todayActivities,
    leadMinutes,
    timeFormat,
    notificationsEnabled,
  });
  if (onInAppReminder) {
    for (const item of fired) {
      const matched = todayActivities.find((a) => a.instanceId === item.instanceId);
      if (matched) onInAppReminder(matched, leadMinutes);
    }
  }
}
