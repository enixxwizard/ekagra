import { ResolvedActivity, TimeFormat } from '../types/dayflow';
import { formatTimeDisplay, getCurrentLocalMinutes, parseTimeToMinutes } from './dateTime';

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

const NOTIFIED_STORAGE_KEY = 'dayflow_sent_reminders_v1';

function getSentSet(): Set<string> {
  try {
    const raw = sessionStorage.getItem(NOTIFIED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function markSent(key: string): void {
  try {
    const set = getSentSet();
    set.add(key);
    sessionStorage.setItem(NOTIFIED_STORAGE_KEY, JSON.stringify([...set].slice(-200)));
  } catch {
    // Ignore sessionStorage errors
  }
}

export function checkAndFireActivityReminders(
  todayActivities: ResolvedActivity[],
  leadMinutes: 0 | 5 | 10 | 15,
  timeFormat: TimeFormat,
  notificationsEnabled: boolean,
  onInAppReminder?: (act: ResolvedActivity, leadMinutes: number) => void
): void {
  const nowMinutes = getCurrentLocalMinutes();
  const sent = getSentSet();

  for (const act of todayActivities) {
    if (act.status !== 'pending') continue;

    const startMin = parseTimeToMinutes(act.startTime);
    const triggerMin = startMin - leadMinutes;
    const key = `${act.instanceId}::lead=${leadMinutes}`;

    // Fire if within [triggerMin, triggerMin + 1] window and not yet fired
    if (nowMinutes >= triggerMin && nowMinutes <= triggerMin + 1 && !sent.has(key)) {
      markSent(key);
      onInAppReminder?.(act, leadMinutes);

      if (
        notificationsEnabled &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        const whenText =
          leadMinutes === 0
            ? 'Starting now'
            : `Starts in ${leadMinutes} min (${formatTimeDisplay(act.startTime, timeFormat)})`;
        try {
          new Notification(`DayFlow: ${act.title}`, {
            body: `${whenText} · ${act.category}`,
          });
        } catch {
          // Ignore browser-level notification failures
        }
      }
    }
  }
}
