import type { ActivityCategory, PdfExtractedQuotation, PriorityLevel } from '../types/dayflow';
import type {
  PdfBreakPeriodItem,
  PdfDailyPlanItem,
  PdfDeadlineItem,
  PdfDocumentType,
  PdfMonthlyGoalItem,
  PdfProvenance,
  PdfValidationWarning,
  PdfWeeklyPlanItem,
  StructuredPdfPlan,
} from '../types/pdfSchedule';

export const WEEKDAY_FULL_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const WEEKDAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const MON_TO_SUN_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const MONTH_FULL_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const WEEKDAY_LOOKUP: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MONTH_LOOKUP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function computeDocumentHash(
  fileName: string,
  pages: Array<{ pageNumber: number; text?: string; layoutText?: string }>,
  fileSize = 0
): string {
  const input = `${fileName}|${fileSize}|${pages
    .map((p) => `${p.pageNumber}:${p.layoutText || p.text || ''}`)
    .join('\n')}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `df-${(hash >>> 0).toString(16)}`;
}

function makeDeterministicId(prefix: string, index: number, seed: string): string {
  const clean = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${prefix}-${index}-${clean || 'item'}`;
}

export function sanitizeCategory(raw: unknown): ActivityCategory {
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    if (lower === 'work') return 'Work';
    if (lower === 'study') return 'Study';
    if (lower === 'health') return 'Health';
    if (lower === 'personal') return 'Personal';
    if (lower === 'deep focus') return 'Deep Focus';
    if (lower === 'admin') return 'Admin';
  }
  return 'Study';
}

export function sanitizePriority(raw: unknown): PriorityLevel {
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    if (lower === 'high' || lower === 'urgent') return 'high';
    if (lower === 'low') return 'low';
  }
  return 'medium';
}

export function sanitizeProvenance(raw: unknown, fallback: PdfProvenance = 'explicit'): PdfProvenance {
  if (raw === 'explicit' || raw === 'inferred' || raw === 'suggested') return raw;
  return fallback;
}

export function sanitizeIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    return null;
  }
  return trimmed;
}

export function timeToMinutes(hhmm: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToHHMM(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function sanitizeTime24(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const match24 = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (match24) {
    return `${match24[1].padStart(2, '0')}:${match24[2]}`;
  }
  const match12 = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/i.exec(trimmed);
  if (match12) {
    let h = Number(match12[1]);
    const m = match12[2] ? Number(match12[2]) : 0;
    const period = match12[3].toLowerCase();
    if (h < 1 || h > 12) return null;
    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Parses timetable time ranges like "9:00–10:30", "12:45-1:15", "1:15 - 2:45 PM", "15:00 to 16:00".
 * Supports daytime timetable wrap-around where 1:15 following 12:45 (without AM/PM) means 13:15.
 */
export function parseTimeRangeString(
  raw: string,
  previousEndMinutes?: number
): { startTime: string; endTime: string; inferredAfternoon: boolean } | null {
  const match =
    /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\b/i.exec(
      raw
    );
  if (!match) return null;

  let startH = Number(match[1]);
  const startM = match[2] ? Number(match[2]) : 0;
  const startMeridiem = match[3]?.toLowerCase();

  let endH = Number(match[4]);
  const endM = match[5] ? Number(match[5]) : 0;
  const endMeridiem = match[6]?.toLowerCase();

  if (startH > 23 || endH > 23) return null;

  let inferredAfternoon = false;

  if (startMeridiem) {
    if (startH < 1 || startH > 12) return null;
    if (startMeridiem === 'pm' && startH !== 12) startH += 12;
    if (startMeridiem === 'am' && startH === 12) startH = 0;
  }

  if (endMeridiem) {
    if (endH < 1 || endH > 12) return null;
    if (endMeridiem === 'pm' && endH !== 12) endH += 12;
    if (endMeridiem === 'am' && endH === 12) endH = 0;
    if (!startMeridiem && startH >= 1 && startH <= 12) {
      // If start wasn't tagged AM/PM, infer matching meridiem unless end < start (e.g., 11:30 - 1:00 PM)
      const candidateSame =
        endMeridiem === 'pm' && startH !== 12 ? startH + 12 : endMeridiem === 'am' && startH === 12 ? 0 : startH;
      if (candidateSame * 60 + startM < endH * 60 + endM) {
        startH = candidateSame;
      }
    }
  }

  // Handle timetables without AM/PM where noon transitions to 1:00..7:59
  if (!startMeridiem && !endMeridiem) {
    const startMinRaw = startH * 60 + startM;
    const endMinRaw = endH * 60 + endM;

    if (
      startH >= 1 &&
      startH <= 6 &&
      (previousEndMinutes === undefined || previousEndMinutes >= 12 * 60 || startMinRaw < previousEndMinutes)
    ) {
      startH += 12;
      inferredAfternoon = true;
    }

    if (endH >= 1 && endH <= 7 && (endH * 60 + endM <= startH * 60 + startM || startH >= 12)) {
      endH += 12;
      inferredAfternoon = true;
    }
  } else if (!endMeridiem && startH >= 12 && endH >= 1 && endH <= 11) {
    endH += 12;
    inferredAfternoon = true;
  }

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (endMinutes <= startMinutes || endMinutes - startMinutes > 12 * 60) {
    return null;
  }

  return {
    startTime: minutesToHHMM(startMinutes),
    endTime: minutesToHHMM(endMinutes),
    inferredAfternoon,
  };
}

export function normalizeWeekdayNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 6) {
    return raw;
  }
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase().replace(/\.$/, '');
    if (key in WEEKDAY_LOOKUP) return WEEKDAY_LOOKUP[key];
  }
  return null;
}

export function expandWeekdayRange(startDay: number, endDay: number): number[] {
  const result: number[] = [];
  let cursor = startDay;
  for (let i = 0; i < 7; i++) {
    result.push(cursor);
    if (cursor === endDay) break;
    cursor = (cursor + 1) % 7;
  }
  return result;
}

export function normalizeMonthNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 12) {
    return raw;
  }
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase().replace(/\.$/, '');
    if (key in MONTH_LOOKUP) return MONTH_LOOKUP[key];
    const num = Number(key);
    if (Number.isInteger(num) && num >= 1 && num <= 12) return num;
  }
  return null;
}

/**
 * Returns true if a timetable cell title represents a break/lunch/recess period
 * rather than an academic study or work task.
 */
export function isBreakLabel(title: string): boolean {
  const clean = title.trim().toLowerCase();
  if (!clean) return false;
  if (
    /^(short\s+)?(tea|coffee|snack|lunch|dinner|breakfast|mid-day)?\s*(break|lunch|recess|rest|interval|free\s*period|idle|buffer)\b/.test(
      clean
    )
  ) {
    return clean.length <= 36 && !/\b(review|study|practice|test|quiz|lecture|class|lab)\b/.test(clean);
  }
  return /^(break|lunch|recess|tea|rest)$/i.test(clean);
}

export function computeDocumentType(plan: {
  dailyPlans: unknown[];
  weeklyPlans: unknown[];
  monthlyGoals: unknown[];
  deadlines: unknown[];
}): PdfDocumentType {
  const activeBuckets = [
    plan.dailyPlans.length > 0 ? 'daily' : null,
    plan.weeklyPlans.length > 0 ? 'weekly' : null,
    plan.monthlyGoals.length > 0 ? 'monthly' : null,
    plan.deadlines.length > 0 ? 'deadlines' : null,
  ].filter(Boolean) as PdfDocumentType[];

  if (activeBuckets.length === 0) return 'daily';
  if (activeBuckets.length === 1) return activeBuckets[0];
  return 'mixed';
}

export function computeImportFingerprint(
  sourceFile: string,
  titleOrText: string,
  date?: string | null,
  startTime?: string | null
): string {
  const normFile = sourceFile.trim().toLowerCase();
  const normTitle = titleOrText
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 90);
  return `${normFile}::${normTitle}::${date ?? ''}::${startTime ?? ''}`;
}

/**
 * Validates, normalizes, and runs Phase 6 audit checks on raw AI or local structured output.
 */
export function validateAndAuditStructuredPlan(
  raw: Record<string, unknown>,
  options: {
    fileName: string;
    documentHash: string;
    analysisSource: StructuredPdfPlan['analysisSource'];
    cached?: boolean;
  }
): StructuredPdfPlan {
  const warnings: PdfValidationWarning[] = [];
  const rawWarnings = Array.isArray(raw.warnings) ? raw.warnings : [];
  rawWarnings.forEach((w, idx) => {
    if (typeof w === 'string' && w.trim()) {
      warnings.push({
        id: `warn-model-${idx}`,
        severity: 'warning',
        section: 'general',
        message: w.trim(),
      });
    } else if (w && typeof w === 'object' && typeof (w as Record<string, unknown>).message === 'string') {
      const obj = w as Record<string, unknown>;
      warnings.push({
        id: `warn-model-${idx}`,
        severity: obj.severity === 'info' ? 'info' : 'warning',
        section:
          obj.section === 'weekly' ||
          obj.section === 'daily' ||
          obj.section === 'monthly' ||
          obj.section === 'deadlines' ||
          obj.section === 'breaks'
            ? obj.section
            : 'general',
        message: String(obj.message).trim(),
        sourcePage: typeof obj.sourcePage === 'number' ? obj.sourcePage : undefined,
      });
    }
  });

  const breakPeriods: PdfBreakPeriodItem[] = [];
  const rawBreaks = Array.isArray(raw.breakPeriods) ? raw.breakPeriods : [];
  rawBreaks.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'Break';
    const startTime = sanitizeTime24(obj.startTime);
    const endTime = sanitizeTime24(obj.endTime);
    if (!startTime || !endTime || timeToMinutes(endTime) <= timeToMinutes(startTime)) return;

    const weekdaysRaw = Array.isArray(obj.weekdays)
      ? obj.weekdays
      : obj.weekday !== undefined
      ? [obj.weekday]
      : [];
    const weekdays = Array.from(
      new Set(
        weekdaysRaw
          .map((d) => normalizeWeekdayNumber(d))
          .filter((d): d is number => d !== null)
      )
    );

    breakPeriods.push({
      id: makeDeterministicId('brk', idx, `${title}-${startTime}`),
      title,
      weekdays,
      date: sanitizeIsoDate(obj.date),
      startTime,
      endTime,
      isOptionalUnavailable: true,
      sourcePage: typeof obj.sourcePage === 'number' && obj.sourcePage >= 1 ? Math.floor(obj.sourcePage) : 1,
      provenance: sanitizeProvenance(obj.provenance, 'explicit'),
      included: false,
    });
  });

  const weeklyPlans: PdfWeeklyPlanItem[] = [];
  const rawWeekly = Array.isArray(raw.weeklyPlans) ? raw.weeklyPlans : [];
  rawWeekly.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (!title) return;

    // Support either single weekday or weekdays array inside raw object
    const rawDays: number[] = [];
    const singleDay = normalizeWeekdayNumber(obj.weekday);
    if (singleDay !== null) rawDays.push(singleDay);
    if (Array.isArray((obj.recurrenceRule as Record<string, unknown> | undefined)?.daysOfWeek)) {
      for (const d of (obj.recurrenceRule as Record<string, unknown>).daysOfWeek as unknown[]) {
        const parsed = normalizeWeekdayNumber(d);
        if (parsed !== null && !rawDays.includes(parsed)) rawDays.push(parsed);
      }
    }

    if (rawDays.length === 0) {
      warnings.push({
        id: `warn-missing-day-${idx}`,
        severity: 'warning',
        section: 'weekly',
        message: `"${title}" was missing a valid weekday and was skipped—please review against your PDF.`,
        sourcePage: typeof obj.sourcePage === 'number' ? obj.sourcePage : undefined,
      });
      return;
    }

    let startTime = sanitizeTime24(obj.startTime);
    let endTime = sanitizeTime24(obj.endTime);

    // Fix accidental 12h AM parsing of afternoon study blocks (e.g., 01:15 - 02:45 inside a daytime timetable)
    if (startTime && endTime) {
      const sMin = timeToMinutes(startTime);
      const eMin = timeToMinutes(endTime);
      if (sMin >= 60 && sMin < 7 * 60 && eMin > sMin && eMin < 9 * 60) {
        startTime = minutesToHHMM(sMin + 12 * 60);
        endTime = minutesToHHMM(eMin + 12 * 60);
      } else if (sMin >= 11 * 60 && eMin >= 60 && eMin < 7 * 60) {
        endTime = minutesToHHMM(eMin + 12 * 60);
      }
    }

    if (!startTime || !endTime || timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      warnings.push({
        id: `warn-invalid-time-${idx}`,
        severity: 'warning',
        section: 'weekly',
        message: `"${title}" had an invalid time range (${String(obj.startTime ?? '')}–${String(obj.endTime ?? '')}) and needs review.`,
        sourcePage: typeof obj.sourcePage === 'number' ? obj.sourcePage : undefined,
      });
      return;
    }

    const sourcePage =
      typeof obj.sourcePage === 'number' && obj.sourcePage >= 1 ? Math.floor(obj.sourcePage) : 1;
    const provenance = sanitizeProvenance(obj.provenance, 'explicit');

    // Phase 6 safeguard: Breaks must never remain in weeklyPlans study tasks
    if (isBreakLabel(title)) {
      const existingBreak = breakPeriods.find(
        (b) => b.startTime === startTime && b.endTime === endTime && b.title.toLowerCase() === title.toLowerCase()
      );
      if (existingBreak) {
        for (const d of rawDays) {
          if (!existingBreak.weekdays.includes(d)) existingBreak.weekdays.push(d);
        }
      } else {
        breakPeriods.push({
          id: makeDeterministicId('brk-moved', idx, `${title}-${startTime}`),
          title,
          weekdays: rawDays,
          date: null,
          startTime,
          endTime,
          isOptionalUnavailable: true,
          sourcePage,
          provenance,
          included: false,
        });
      }
      return;
    }

    const startDate = sanitizeIsoDate(obj.startDate);
    let endDate = sanitizeIsoDate(obj.endDate);
    if (startDate && endDate && endDate < startDate) {
      warnings.push({
        id: `warn-date-order-${idx}`,
        severity: 'warning',
        section: 'weekly',
        message: `"${title}" had an end date before its start date; cleared end date for review.`,
        sourcePage,
      });
      endDate = null;
    }

    for (const weekday of rawDays) {
      weeklyPlans.push({
        id: makeDeterministicId('wk', weeklyPlans.length, `${weekday}-${startTime}-${title}`),
        title,
        weekday,
        startTime,
        endTime,
        recurrenceRule: {
          frequency: 'weekly',
          daysOfWeek: [weekday],
          endDate,
        },
        startDate,
        endDate,
        category: sanitizeCategory(obj.category),
        priority: sanitizePriority(obj.priority),
        sourcePage,
        provenance,
        notes: typeof obj.notes === 'string' ? obj.notes.trim() : '',
        included: true,
      });
    }
  });

  // Check for overlapping weekly slots on the same weekday (possible column-shift signal)
  const weekdaySlotsMap = new Map<number, PdfWeeklyPlanItem[]>();
  for (const item of weeklyPlans) {
    const list = weekdaySlotsMap.get(item.weekday) ?? [];
    list.push(item);
    weekdaySlotsMap.set(item.weekday, list);
  }
  for (const [weekday, items] of weekdaySlotsMap.entries()) {
    const sorted = [...items].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (timeToMinutes(a.endTime) > timeToMinutes(b.startTime)) {
        warnings.push({
          id: `warn-wk-overlap-${weekday}-${i}`,
          severity: 'warning',
          section: 'weekly',
          message: `On ${WEEKDAY_FULL_NAMES[weekday]}, "${a.title}" (${a.startTime}–${a.endTime}) overlaps "${b.title}" (${b.startTime}–${b.endTime}). Check if a table cell shifted columns.`,
          sourcePage: a.sourcePage,
        });
      }
    }
  }

  const dailyPlans: PdfDailyPlanItem[] = [];
  const rawDaily = Array.isArray(raw.dailyPlans) ? raw.dailyPlans : [];
  rawDaily.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (!title) return;

    const startTime = sanitizeTime24(obj.startTime);
    const endTime = sanitizeTime24(obj.endTime);
    const sourcePage =
      typeof obj.sourcePage === 'number' && obj.sourcePage >= 1 ? Math.floor(obj.sourcePage) : 1;

    if (!startTime || !endTime || timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      warnings.push({
        id: `warn-daily-missing-time-${idx}`,
        severity: 'warning',
        section: 'daily',
        message: `"${title}" does not have a valid explicit start and end time and was excluded.`,
        sourcePage,
      });
      return;
    }

    if (isBreakLabel(title)) {
      breakPeriods.push({
        id: makeDeterministicId('brk-daily', idx, `${title}-${startTime}`),
        title,
        weekdays: [],
        date: sanitizeIsoDate(obj.date),
        startTime,
        endTime,
        isOptionalUnavailable: true,
        sourcePage,
        provenance: sanitizeProvenance(obj.timeProvenance, 'explicit'),
        included: false,
      });
      return;
    }

    const explicitDate = sanitizeIsoDate(obj.date);
    if (!explicitDate) {
      warnings.push({
        id: `warn-daily-missing-date-${idx}`,
        severity: 'warning',
        section: 'daily',
        message: `"${title}" has no explicit calendar date and was not assigned an invented date.`,
        sourcePage,
      });
      return;
    }

    dailyPlans.push({
      id: makeDeterministicId('day', idx, `${explicitDate}-${title}`),
      title,
      date: explicitDate,
      dateProvenance: sanitizeProvenance(obj.dateProvenance, 'explicit'),
      startTime,
      endTime,
      timeProvenance: sanitizeProvenance(obj.timeProvenance, 'explicit'),
      category: sanitizeCategory(obj.category),
      priority: sanitizePriority(obj.priority),
      sourcePage,
      notes: typeof obj.notes === 'string' ? obj.notes.trim() : '',
      included: true,
    });
  });

  const monthlyGoals: PdfMonthlyGoalItem[] = [];
  const rawMonthly = Array.isArray(raw.monthlyGoals) ? raw.monthlyGoals : [];
  rawMonthly.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    const monthNum = normalizeMonthNumber(obj.month ?? obj.monthLabel);
    if (!monthNum) return;
    const goals = Array.isArray(obj.goals)
      ? obj.goals
          .map((g) => (typeof g === 'string' ? g.trim() : ''))
          .filter((g) => g.length > 0)
      : typeof obj.goal === 'string' && obj.goal.trim()
      ? [obj.goal.trim()]
      : [];

    if (goals.length === 0) return;

    const rawYear = typeof obj.year === 'number' && obj.year >= 2020 && obj.year <= 2099 ? Math.floor(obj.year) : null;
    monthlyGoals.push({
      id: makeDeterministicId('mo', idx, `${monthNum}-${rawYear ?? ''}`),
      month: monthNum,
      monthLabel: MONTH_FULL_NAMES[monthNum],
      year: rawYear,
      goals: Array.from(new Set(goals)),
      category: sanitizeCategory(obj.category),
      sourcePage:
        typeof obj.sourcePage === 'number' && obj.sourcePage >= 1 ? Math.floor(obj.sourcePage) : 1,
      provenance: sanitizeProvenance(obj.provenance, 'explicit'),
      included: true,
    });
  });

  const deadlines: PdfDeadlineItem[] = [];
  const rawDeadlines = Array.isArray(raw.deadlines) ? raw.deadlines : [];
  rawDeadlines.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    if (!title) return;
    const dueDate = sanitizeIsoDate(obj.dueDate);
    const dueTime = sanitizeTime24(obj.dueTime);
    const sourcePage =
      typeof obj.sourcePage === 'number' && obj.sourcePage >= 1 ? Math.floor(obj.sourcePage) : 1;

    if (!dueDate) {
      warnings.push({
        id: `warn-deadline-nodate-${idx}`,
        severity: 'info',
        section: 'deadlines',
        message: `Deadline "${title}" has no explicit calendar date in the PDF—no date was invented.`,
        sourcePage,
      });
    }

    deadlines.push({
      id: makeDeterministicId('dl', idx, `${dueDate ?? 'nodate'}-${title}`),
      title,
      dueDate,
      dueTime,
      estimatedMinutes:
        typeof obj.estimatedMinutes === 'number' && obj.estimatedMinutes >= 15
          ? Math.min(240, Math.round(obj.estimatedMinutes))
          : 60,
      category: sanitizeCategory(obj.category),
      priority: sanitizePriority(obj.priority ?? 'high'),
      kind: obj.kind === 'exam' || obj.kind === 'assignment' ? obj.kind : 'deadline',
      sourcePage,
      provenance: sanitizeProvenance(obj.provenance, dueDate ? 'explicit' : 'inferred'),
      notes: typeof obj.notes === 'string' ? obj.notes.trim() : '',
      included: true,
    });
  });

  const quotations: PdfExtractedQuotation[] = [];
  const rawQuotes = Array.isArray(raw.quotations) ? raw.quotations : [];
  const seenQuoteTexts = new Set<string>();
  rawQuotes.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    const obj = item as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (text.length < 10) return;
    const key = text.toLowerCase();
    if (seenQuoteTexts.has(key)) return;
    seenQuoteTexts.add(key);
    const pageNumber =
      typeof obj.pageNumber === 'number' && obj.pageNumber >= 1
        ? Math.floor(obj.pageNumber)
        : typeof obj.sourcePage === 'number' && obj.sourcePage >= 1
        ? Math.floor(obj.sourcePage)
        : 1;
    quotations.push({
      id: makeDeterministicId('qt', idx, text),
      text,
      category: sanitizeCategory(obj.category),
      sourceFile: options.fileName,
      pageNumber,
      fingerprint: computeImportFingerprint(options.fileName, text),
      saved: false,
    });
  });

  const computedType = computeDocumentType({
    dailyPlans,
    weeklyPlans,
    monthlyGoals,
    deadlines,
  });

  // Deduplicate warnings by message
  const seenWarnings = new Set<string>();
  const uniqueWarnings = warnings.filter((w) => {
    const k = `${w.section}::${w.message}`;
    if (seenWarnings.has(k)) return false;
    seenWarnings.add(k);
    return true;
  });

  return {
    fileName: options.fileName,
    documentHash: options.documentHash,
    documentType: computedType,
    analysisSource: options.analysisSource,
    dailyPlans,
    weeklyPlans,
    monthlyGoals,
    deadlines,
    breakPeriods,
    quotations,
    warnings: uniqueWarnings,
    cached: options.cached,
  };
}
