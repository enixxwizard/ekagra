import type { ActivityCategory } from './dayflow';

export interface ActiveReminderItem {
  key: string; // `${instanceId}::${startTime}`
  instanceId: string;
  activityId: string;
  occurrenceDate: string; // YYYY-MM-DD
  title: string;
  category: ActivityCategory;
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  leadMinutes: number;
  isRecurring: boolean;
  snoozeCount: number;
  triggeredAtMs: number;
}

export interface SnoozedReminderEntry {
  untilMs: number;
  snoozeCount: number;
}

export interface StoredReminderState {
  dismissedKeys: Record<string, string>;
  triggeredKeys: Record<string, string>;
  snoozedUntilMs: Record<string, SnoozedReminderEntry>;
}

export interface CalendarFocusTarget {
  date: string; // YYYY-MM-DD
  activityId: string;
  nonce: number;
}
