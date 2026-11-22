import {
  addDays,
  endOfWeek,
  format,
  parseISO,
  startOfWeek,
  subDays,
} from 'date-fns';
import { TimeFormat, WeekStartDay } from '../types/dayflow';

export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getTodayISO(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

export function shiftDateISO(dateISO: string, days: number): string {
  const parsed = parseISO(dateISO);
  return format(days >= 0 ? addDays(parsed, days) : subDays(parsed, Math.abs(days)), 'yyyy-MM-dd');
}

export function formatDateHeading(dateISO: string): string {
  return format(parseISO(dateISO), 'EEEE, MMMM d, yyyy');
}

export function formatShortDate(dateISO: string): string {
  return format(parseISO(dateISO), 'MMM d');
}

export function formatMonthYear(date: Date): string {
  return format(date, 'MMMM yyyy');
}

export function getWeekDateStrings(referenceISO: string, weekStart: WeekStartDay): string[] {
  const ref = parseISO(referenceISO);
  const start = startOfWeek(ref, { weekStartsOn: weekStart === 'monday' ? 1 : 0 });
  return Array.from({ length: 7 }, (_, i) => format(addDays(start, i), 'yyyy-MM-dd'));
}

export function getWeekRange(referenceISO: string, weekStart: WeekStartDay): { start: string; end: string } {
  const ref = parseISO(referenceISO);
  const weekStartsOn = weekStart === 'monday' ? 1 : 0;
  return {
    start: format(startOfWeek(ref, { weekStartsOn }), 'yyyy-MM-dd'),
    end: format(endOfWeek(ref, { weekStartsOn }), 'yyyy-MM-dd'),
  };
}

export function parseTimeToMinutes(time24: string): number {
  const [hStr, mStr] = time24.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return Math.max(0, Math.min(24 * 60, h * 60 + m));
}

export function minutesToTime24(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatTimeDisplay(time24: string, timeFormat: TimeFormat): string {
  const total = parseTimeToMinutes(time24);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (timeFormat === '24h') {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

export function formatHourLabel(hour24: number, timeFormat: TimeFormat): string {
  if (timeFormat === '24h') {
    return `${String(hour24).padStart(2, '0')}:00`;
  }
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${h12} ${period}`;
}

export function getActivityDurationMinutes(startTime: string, endTime: string): number {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  return Math.max(0, end - start);
}

export function formatDurationCompact(minutes: number): string {
  if (minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatHoursDecimal(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

export function formatTimerClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function getCurrentLocalMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

export function getLocalTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local Time';
  } catch {
    return 'Local Time';
  }
}
