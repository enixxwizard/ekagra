import type { ActivityCategory, PriorityLevel, ScheduleActivity } from '../types/dayflow';
import type { ExtractedPdfPage, StructuredPdfPlan } from '../types/pdfSchedule';
import type { PdfTextExtractionResult } from './pdfExtractor';
import {
  computeImportFingerprint,
  isBreakLabel,
  minutesToHHMM,
  normalizeWeekdayNumber,
  parseTimeRangeString,
  sanitizeCategory,
  sanitizeIsoDate,
  sanitizePriority,
  sanitizeTime24,
  timeToMinutes,
} from './pdfSchemaValidator';

export const STRICT_SCHEDULE_REJECTION_MESSAGE =
  "This PDF doesn't contain a valid study schedule. Please upload a roadmap or timetable with clear dates, study times, and topics. You can save this document in your EKAGRA Library instead.";

export type StrictScheduleClassification =
  | 'valid_schedule'
  | 'mixed_with_valid_schedule'
  | 'rejected_scanned_unreadable'
  | 'rejected_notes_or_textbook'
  | 'rejected_topics_only'
  | 'rejected_dates_no_times'
  | 'rejected_times_no_dates'
  | 'rejected_dates_no_activities';

export interface StrictScheduleSession {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD (always explicit)
  startTime: string; // HH:mm 24h (always explicit)
  endTime: string; // HH:mm 24h (always explicit & > startTime)
  category: ActivityCategory;
  priority: PriorityLevel;
  sourcePage: number;
  notes: string;
  included: boolean;
}

export interface StrictScheduleValidationResult {
  accepted: boolean;
  classification: StrictScheduleClassification;
  errorMessage: string | null;
  reasonDetail: string;
  sessions: StrictScheduleSession[];
  discardedLinesCount: number;
  signals: {
    hasExplicitDates: boolean;
    hasExplicitTimes: boolean;
    hasTopicOnlyMarkers: boolean;
    hasProseOrCodeNoise: boolean;
    hasWeekdaysWithoutDates: boolean;
  };
}

const MONTH_NAME_TO_NUM: Record<string, number> = {
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

const MONTH_PATTERN =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function toValidIsoDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isStrictValidISODate(raw: string | null | undefined): raw is string {
  return Boolean(raw && sanitizeIsoDate(raw));
}

/**
 * Extracts explicit calendar dates from a line along with matched substrings so they can be cleanly stripped
 * before extracting the study topic. Never matches ISO timestamps with `T09:15:00Z` log format.
 */
export function extractExplicitDatesFromText(
  line: string,
  documentYearHint: number | null = null
): Array<{ iso: string; raw: string; index: number }> {
  const results: Array<{ iso: string; raw: string; index: number }> = [];
  const occupied: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    occupied.some(([s, e]) => Math.max(s, start) < Math.min(e, end));

  // Ignore ISO log timestamps like 2026-11-20T09:15:00Z or [2026-11-20 09:15:00]
  const isoTimestampLogRegex = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g;
  let logMatch: RegExpExecArray | null;
  while ((logMatch = isoTimestampLogRegex.exec(line)) !== null) {
    occupied.push([logMatch.index, logMatch.index + logMatch[0].length]);
  }

  // 1. YYYY-MM-DD or YYYY/MM/DD
  const isoRegex = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = isoRegex.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const iso = toValidIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) {
      occupied.push([start, end]);
      results.push({ iso, raw: m[0], index: start });
    }
  }

  // 2. DD Month YYYY (e.g. "25 November 2026", "25th Nov, 2026", "25-Nov-2026")
  const dmyNameRegex = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(${MONTH_PATTERN})[\\s,-]+(20\\d{2})\\b`,
    'gi'
  );
  while ((m = dmyNameRegex.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const month = MONTH_NAME_TO_NUM[m[2].toLowerCase()];
    const iso = month ? toValidIsoDate(Number(m[3]), month, Number(m[1])) : null;
    if (iso) {
      occupied.push([start, end]);
      results.push({ iso, raw: m[0], index: start });
    }
  }

  // 3. Month DD, YYYY (e.g. "November 25, 2026", "Nov 25th 2026")
  const mdyNameRegex = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,|\\s)+\\s*(20\\d{2})\\b`,
    'gi'
  );
  while ((m = mdyNameRegex.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const month = MONTH_NAME_TO_NUM[m[1].toLowerCase()];
    const iso = month ? toValidIsoDate(Number(m[3]), month, Number(m[2])) : null;
    if (iso) {
      occupied.push([start, end]);
      results.push({ iso, raw: m[0], index: start });
    }
  }

  // 4. Numeric DD/MM/YYYY or DD-MM-YYYY (also handles MM/DD/YYYY when second part > 12)
  const numericDmyRegex = /\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/g;
  while ((m = numericDmyRegex.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    let iso: string | null = null;
    if (a > 12 && b <= 12) {
      iso = toValidIsoDate(y, b, a);
    } else if (b > 12 && a <= 12) {
      iso = toValidIsoDate(y, a, b);
    } else {
      iso = toValidIsoDate(y, b, a);
    }
    if (iso) {
      occupied.push([start, end]);
      results.push({ iso, raw: m[0], index: start });
    }
  }

  // 5. Optional: Day + MonthName (or MonthName + Day) ONLY if the document explicitly specifies a non-copyright year
  if (documentYearHint && documentYearHint >= 2020 && documentYearHint <= 2099) {
    const dmNoYearRegex = new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\b`,
      'gi'
    );
    while ((m = dmNoYearRegex.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const month = MONTH_NAME_TO_NUM[m[2].toLowerCase()];
      const iso = month ? toValidIsoDate(documentYearHint, month, Number(m[1])) : null;
      if (iso) {
        occupied.push([start, end]);
        results.push({ iso, raw: m[0], index: start });
      }
    }

    const mdNoYearRegex = new RegExp(
      `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
      'gi'
    );
    while ((m = mdNoYearRegex.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const month = MONTH_NAME_TO_NUM[m[1].toLowerCase()];
      const iso = month ? toValidIsoDate(documentYearHint, month, Number(m[2])) : null;
      if (iso) {
        occupied.push([start, end]);
        results.push({ iso, raw: m[0], index: start });
      }
    }
  }

  return results.sort((a, b) => a.index - b.index);
}

/**
 * Extracts explicit study time range from a line.
 * Supports:
 *   - "9:00 AM–11:00 AM", "7:00 PM - 8:30 PM", "19:00-20:30", "9 AM to 11 AM"
 *   - Explicit start time + explicit duration: "9:00 AM (90 min)", "19:00 · 1.5 hrs", "7:00 PM for 2 hours"
 * Never matches HH:MM:SS timestamps and never invents default durations!
 */
export function extractExplicitStudyTimeRange(
  line: string,
  previousEndMinutes?: number
): { startTime: string; endTime: string; matchedRaw: string } | null {
  // Reject code/log second-precision timestamps like 12:30:45
  if (/\b\d{1,2}:\d{2}:\d{2}\b/.test(line)) {
    const strippedOfSeconds = line.replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, '').trim();
    if (!/\b\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?\s*(?:-|–|—|to)\s*\d{1,2}/i.test(strippedOfSeconds)) {
      return null;
    }
  }

  // 1. Explicit range (e.g., 9:00 AM–11:00 AM, 19:00-20:30)
  // Strip ISO/numeric dates first and scan globally so "2026-11-28" or "1-2"
  // never causes an early return before matching the actual time range on the line.
  const lineWithoutNumericDates = line
    .replace(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/]20\d{2}\b/g, ' ');
  const rangeRegex =
    /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\b/gi;
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = rangeRegex.exec(lineWithoutNumericDates)) !== null) {
    // Reject bare integer ratios/chapter ranges like "1-3", "10-12" when neither has :mm nor am/pm
    const hasMinutesOrMeridiem = Boolean(
      rangeMatch[2] || rangeMatch[3] || rangeMatch[5] || rangeMatch[6]
    );
    if (!hasMinutesOrMeridiem) continue;
    const parsed = parseTimeRangeString(rangeMatch[0], previousEndMinutes);
    if (parsed && timeToMinutes(parsed.endTime) > timeToMinutes(parsed.startTime)) {
      return {
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        matchedRaw: rangeMatch[0],
      };
    }
  }

  // 2. Explicit start time + explicit duration (e.g., "9:00 AM (90 min)", "19:00 · 1.5 hours")
  const durationRegex =
    /\b(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)|\d{2}:[0-5]\d)\b[^0-9a-zA-Z]{0,12}(?:for\s+)?(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|hrs?|hours?)\b/i;
  const durMatch = durationRegex.exec(line);
  if (durMatch) {
    const startTime = sanitizeTime24(durMatch[1]);
    const amount = Number(durMatch[2]);
    const unit = durMatch[3].toLowerCase();
    if (startTime && Number.isFinite(amount) && amount > 0) {
      const durMinutes = unit.startsWith('h') ? Math.round(amount * 60) : Math.round(amount);
      if (durMinutes >= 10 && durMinutes <= 12 * 60) {
        const startMin = timeToMinutes(startTime);
        const endMin = startMin + durMinutes;
        if (endMin <= 23 * 60 + 59) {
          return {
            startTime,
            endTime: minutesToHHMM(endMin),
            matchedRaw: durMatch[0],
          };
        }
      }
    }
  }

  return null;
}

/**
 * Identifies code snippets, server logs, textbook prose, copyright headers, and exam questions
 * that must NEVER be mistaken for a study schedule.
 */
export function isNonScheduleCodeOrProseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;

  // Code / syntax lines
  if (
    /^(?:public|private|protected)\s+(?:class|interface|enum|static|void|int|String|boolean|double)\b/.test(
      trimmed
    ) ||
    /^(?:import|package)\s+[a-zA-Z0-9_.*]+;?$/.test(trimmed) ||
    /^(?:const|let|var|function|async\s+function|export|return|class|def|from)\s+/.test(trimmed) ||
    /(?:System\.out\.print|console\.log|printf\(|=>|\{\s*$|\}\s*$|;\s*$)/.test(trimmed) ||
    /^\/\/|^\/\*|\*\/$/.test(trimmed)
  ) {
    return true;
  }

  // Server / application log timestamps
  if (
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/.test(trimmed) ||
    /\b(?:INFO|WARN|ERROR|DEBUG|TRACE|HTTP\/\d\.\d|GET\s+\/|POST\s+\/)\b/.test(trimmed)
  ) {
    return true;
  }

  // Copyright / ISBN / publication metadata
  if (/\b(?:copyright|©|all rights reserved|isbn(?:-1[03])?|published\s+by|edition)\b/i.test(trimmed)) {
    return true;
  }

  // Question papers / exam prompts
  if (
    /^(?:Q\.?\s*\d+[.)]|Question\s+\d+|Answer\s+all\s+questions)/i.test(trimmed) ||
    /\(\s*\d+\s*marks?\s*\)$/i.test(trimmed)
  ) {
    return true;
  }

  // Long textbook prose paragraphs (> 160 chars with sentence punctuation and no pipe separator)
  if (trimmed.length > 160 && !trimmed.includes('|') && /[.;?!]\s+[A-Z]/.test(trimmed)) {
    return true;
  }

  return false;
}

function inferCategoryFromTopic(title: string): ActivityCategory {
  const lower = title.toLowerCase();
  if (/\b(deep\s*work|deep\s*focus|mock\s*test|exam\s*sim|pomodoro)\b/.test(lower)) {
    return 'Deep Focus';
  }
  if (/\b(workout|gym|yoga|run|walk|exercise|meditation|sleep)\b/.test(lower)) {
    return 'Health';
  }
  if (/\b(meeting|standup|client|sprint|office|work|shift)\b/.test(lower)) {
    return 'Work';
  }
  if (/\b(errand|laundry|groceries|admin|chores|clean)\b/.test(lower)) {
    return 'Admin';
  }
  return 'Study';
}

function inferPriorityFromTopic(title: string): PriorityLevel {
  const lower = title.toLowerCase();
  if (/\b(exam|final|urgent|deadline|mock\s*test|revision|interview)\b/.test(lower)) {
    return 'high';
  }
  return 'medium';
}

function cleanExtractedTopic(rawLine: string, tokensToStrip: string[]): string {
  let cleaned = rawLine;
  for (const tok of tokensToStrip) {
    if (!tok) continue;
    cleaned = cleaned.replace(tok, ' ');
  }

  // Strip surrounding weekday names if they are only leading date qualifiers like "Monday," or "(Mon)"
  cleaned = cleaned
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b[:,]?\s*/gi, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+(?:—|–|-)\s+/g, ' — ')
    .replace(/^[\s\-–—:|•*.,()[\]]+/, '')
    .replace(/[\s\-–—:|•*.,()[\]]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Remove empty parentheses left behind
  cleaned = cleaned.replace(/\(\s*\)/g, '').trim();

  if (cleaned.length < 2 || cleaned.length > 120) return '';
  // Reject bare numbers or punctuation
  if (/^[\d\s\-–—:.,/]+$/.test(cleaned)) return '';
  // Reject generic bullet-only markers or time-only leftovers
  if (/^(?:am|pm|to|at|on|date|time|topic|subject|activity|session|day)$/i.test(cleaned)) {
    return '';
  }
  return cleaned;
}

function extractDocumentYearHint(pages: ExtractedPdfPage[]): number | null {
  const joined = pages
    .slice(0, 3)
    .map((p) => p.text)
    .join('\n')
    .slice(0, 1500);
  const lines = joined.split(/\r?\n/);
  for (const line of lines.slice(0, 12)) {
    if (/\b(?:copyright|©|isbn|edition)\b/i.test(line)) continue;
    const match = /\b(202[0-9]|203[0-9])\b/.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Resolves a weekday (0=Sun..6=Sat) inside an explicit <= 14-day calendar range (e.g., 2026-11-23 to 2026-11-29).
 */
function resolveWeekdayWithinExplicitRange(
  weekday: number,
  rangeStartISO: string,
  rangeEndISO: string
): string | null {
  const start = new Date(`${rangeStartISO}T00:00:00Z`);
  const end = new Date(`${rangeEndISO}T00:00:00Z`);
  const diffDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0 || diffDays > 13) return null;

  for (let offset = 0; offset <= diffDays; offset++) {
    const candidate = new Date(start.getTime() + offset * 24 * 60 * 60 * 1000);
    if (candidate.getUTCDay() === weekday) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  return null;
}

function sortAndDedupeSessions(sessions: StrictScheduleSession[]): StrictScheduleSession[] {
  const seen = new Set<string>();
  const unique: StrictScheduleSession[] = [];

  const sorted = [...sessions].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.startTime !== b.startTime) return a.startTime.localeCompare(b.startTime);
    return a.title.localeCompare(b.title);
  });

  for (const s of sorted) {
    const key = `${s.date}::${s.startTime}::${s.endTime}::${s.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }
  return unique;
}

function buildRejectionReason(signals: StrictScheduleValidationResult['signals']): {
  classification: StrictScheduleClassification;
  reasonDetail: string;
} {
  if (signals.hasExplicitDates && !signals.hasExplicitTimes) {
    return {
      classification: signals.hasTopicOnlyMarkers ? 'rejected_dates_no_times' : 'rejected_dates_no_times',
      reasonDetail:
        'Calendar dates were found, but the document has no explicit study start and end times.',
    };
  }
  if (!signals.hasExplicitDates && (signals.hasExplicitTimes || signals.hasWeekdaysWithoutDates)) {
    return {
      classification: 'rejected_times_no_dates',
      reasonDetail:
        'Study times or weekdays were detected, but explicit calendar dates (e.g., 25 November 2026) are missing.',
    };
  }
  if (signals.hasTopicOnlyMarkers && !signals.hasExplicitDates && !signals.hasExplicitTimes) {
    return {
      classification: 'rejected_topics_only',
      reasonDetail:
        'This looks like a topic or syllabus outline (for example, "Week 1" or module headings) without dates and study times.',
    };
  }
  if (signals.hasExplicitDates && signals.hasExplicitTimes) {
    return {
      classification: 'rejected_dates_no_activities',
      reasonDetail:
        'Dates or timestamps were found, but no clear study topics were paired with explicit date and time slots.',
    };
  }
  return {
    classification: 'rejected_notes_or_textbook',
    reasonDetail:
      'Detected lecture notes, code snippets, textbook prose, or general study material rather than a dated study schedule.',
  };
}

/**
 * Strictly parses and validates an extracted PDF to accept ONLY genuine dated & timed study schedules.
 * Never invents missing dates, start times, end times, or topics, and never inspects the filename.
 */
export function extractAndValidateStrictSchedule(
  extraction: PdfTextExtractionResult
): StrictScheduleValidationResult {
  if (extraction.isScannedOrEmpty || extraction.pages.length === 0) {
    return {
      accepted: false,
      classification: 'rejected_scanned_unreadable',
      errorMessage: STRICT_SCHEDULE_REJECTION_MESSAGE,
      reasonDetail:
        extraction.scannedReason ||
        'This PDF appears to be scanned or image-only with no readable schedule text. No dates or times were guessed.',
      sessions: [],
      discardedLinesCount: 0,
      signals: {
        hasExplicitDates: false,
        hasExplicitTimes: false,
        hasTopicOnlyMarkers: false,
        hasProseOrCodeNoise: false,
        hasWeekdaysWithoutDates: false,
      },
    };
  }

  const documentYearHint = extractDocumentYearHint(extraction.pages);
  const sessions: StrictScheduleSession[] = [];
  let discardedLinesCount = 0;

  let hasExplicitDates = false;
  let hasExplicitTimes = false;
  let hasTopicOnlyMarkers = false;
  let hasProseOrCodeNoise = false;
  let hasWeekdaysWithoutDates = false;

  for (const page of extraction.pages) {
    const rawLines = (page.layoutText || page.text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    // Detect explicit weekly date range on this page (e.g., "23 November 2026 – 29 November 2026")
    let pageWeekRange: { start: string; end: string } | null = null;
    for (const headerLine of rawLines.slice(0, 8)) {
      const headerDates = extractExplicitDatesFromText(headerLine, documentYearHint);
      if (headerDates.length >= 2) {
        const d1 = headerDates[0].iso;
        const d2 = headerDates[1].iso;
        const start = d1 <= d2 ? d1 : d2;
        const end = d1 <= d2 ? d2 : d1;
        const diff =
          (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) /
          (24 * 60 * 60 * 1000);
        if (diff >= 1 && diff <= 13) {
          pageWeekRange = { start, end };
          hasExplicitDates = true;
          break;
        }
      }
    }

    // Track explicit spatial tables (ONLY valid if columns have explicit dates OR page has explicit <=14d week range)
    for (const table of page.tables ?? []) {
      const columnDates = new Map<number, string>();
      for (let colIdx = 1; colIdx < table.headers.length; colIdx++) {
        const hdr = table.headers[colIdx] ?? '';
        const hdrDates = extractExplicitDatesFromText(hdr, documentYearHint);
        if (hdrDates.length > 0) {
          columnDates.set(colIdx, hdrDates[0].iso);
          hasExplicitDates = true;
        } else if (pageWeekRange) {
          const wd = normalizeWeekdayNumber(hdr);
          if (wd !== null) {
            const resolved = resolveWeekdayWithinExplicitRange(
              wd,
              pageWeekRange.start,
              pageWeekRange.end
            );
            if (resolved) {
              columnDates.set(colIdx, resolved);
            }
          }
        } else if (normalizeWeekdayNumber(hdr) !== null) {
          hasWeekdaysWithoutDates = true;
        }
      }

      if (columnDates.size > 0) {
        let prevTableEnd: number | undefined;
        for (const row of table.rows) {
          const timeCell = row[0] ?? '';
          const parsedRange = extractExplicitStudyTimeRange(timeCell, prevTableEnd);
          if (!parsedRange) continue;
          hasExplicitTimes = true;
          prevTableEnd = timeToMinutes(parsedRange.endTime);

          for (let colIdx = 1; colIdx < row.length; colIdx++) {
            const cellDate = columnDates.get(colIdx);
            const cellTitle = (row[colIdx] ?? '').trim();
            if (!cellDate || !cellTitle) continue;
            if (isBreakLabel(cellTitle) || isNonScheduleCodeOrProseLine(cellTitle)) continue;

            sessions.push({
              id: `strict-tbl-${page.pageNumber}-${sessions.length + 1}`,
              title: cellTitle.slice(0, 120),
              date: cellDate,
              startTime: parsedRange.startTime,
              endTime: parsedRange.endTime,
              category: inferCategoryFromTopic(cellTitle),
              priority: inferPriorityFromTopic(cellTitle),
              sourcePage: page.pageNumber,
              notes: '',
              included: true,
            });
          }
        }
      }
    }

    // Line-by-line strict scan (supports inline dated+timed entries and explicit date headers with timed lines)
    let activeSectionDate: string | null = null;
    let prevLineEndMinutes: number | undefined;

    for (const line of rawLines) {
      // Check topic-only roadmap markers ("Week 1: Java Basics", "Module 2:", "Phase 1:")
      if (/^(?:week|module|unit|phase|stage|milestone)\s*\d+\b/i.test(line)) {
        hasTopicOnlyMarkers = true;
      }

      if (isNonScheduleCodeOrProseLine(line)) {
        hasProseOrCodeNoise = true;
        discardedLinesCount += 1;
        // Interrupt an active date section if a clear code block or prose paragraph appears
        if (/^(?:public|private|class|import|const|let|function|def)\b/.test(line) || line.length > 140) {
          activeSectionDate = null;
        }
        continue;
      }

      const lineDates = extractExplicitDatesFromText(line, documentYearHint);
      const lineTime = extractExplicitStudyTimeRange(line, prevLineEndMinutes);

      if (lineDates.length > 0) hasExplicitDates = true;
      if (lineTime) {
        hasExplicitTimes = true;
        prevLineEndMinutes = timeToMinutes(lineTime.endTime);
      }

      // Check for weekday-only line without explicit calendar date
      if (
        lineDates.length === 0 &&
        /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(line)
      ) {
        hasWeekdaysWithoutDates = true;
      }

      // Case A: Pure date header line (e.g., "25 November 2026" or "Day 1 - November 25, 2026") -> sets active date header
      if (lineDates.length === 1 && !lineTime) {
        const leftover = cleanExtractedTopic(line, [lineDates[0].raw]);
        // Only treat as section header if leftover is empty or short label like "Day 1" / "Schedule"
        if (!leftover || /^(?:day\s*\d+|schedule|sessions?|agenda)$/i.test(leftover)) {
          activeSectionDate = lineDates[0].iso;
          prevLineEndMinutes = undefined;
          continue;
        }
      }

      // Skip table header boilerplate rows
      if (/^(?:date\s*\|\s*time|time\s*\|\s*monday|sr\.?\s*no)/i.test(line)) {
        continue;
      }

      // Case B: Line has explicit time range AND either inline explicit date OR active date section header
      const resolvedDate = lineDates.length === 1 ? lineDates[0].iso : activeSectionDate;
      if (lineTime && resolvedDate) {
        const stripList = [
          lineTime.matchedRaw,
          ...(lineDates.length === 1 ? [lineDates[0].raw] : []),
        ];
        const topic = cleanExtractedTopic(line, stripList);
        if (!topic || isBreakLabel(topic)) {
          discardedLinesCount += 1;
          continue;
        }

        // Reject lines that still look like prose explanations ("In 2026 between 9:00 and 10:00 the CPU...")
        if (topic.split(/\s+/).length > 16 && /[.]/.test(topic)) {
          hasProseOrCodeNoise = true;
          discardedLinesCount += 1;
          continue;
        }

        sessions.push({
          id: `strict-ln-${page.pageNumber}-${sessions.length + 1}`,
          title: topic,
          date: resolvedDate,
          startTime: lineTime.startTime,
          endTime: lineTime.endTime,
          category: inferCategoryFromTopic(topic),
          priority: inferPriorityFromTopic(topic),
          sourcePage: page.pageNumber,
          notes: '',
          included: true,
        });
      } else {
        discardedLinesCount += 1;
      }
    }
  }

  const dedupedSessions = sortAndDedupeSessions(sessions);

  if (dedupedSessions.length === 0) {
    const signals = {
      hasExplicitDates,
      hasExplicitTimes,
      hasTopicOnlyMarkers,
      hasProseOrCodeNoise,
      hasWeekdaysWithoutDates,
    };
    const { classification, reasonDetail } = buildRejectionReason(signals);
    return {
      accepted: false,
      classification,
      errorMessage: STRICT_SCHEDULE_REJECTION_MESSAGE,
      reasonDetail,
      sessions: [],
      discardedLinesCount,
      signals,
    };
  }

  const isMixed = hasProseOrCodeNoise || discardedLinesCount > dedupedSessions.length * 2;
  return {
    accepted: true,
    classification: isMixed ? 'mixed_with_valid_schedule' : 'valid_schedule',
    errorMessage: null,
    reasonDetail: isMixed
      ? `Validated ${dedupedSessions.length} dated and timed study ${
          dedupedSessions.length === 1 ? 'entry' : 'entries'
        }; non-schedule notes and incomplete lines were excluded.`
      : `Validated ${dedupedSessions.length} dated and timed study ${
          dedupedSessions.length === 1 ? 'session' : 'sessions'
        }.`,
    sessions: dedupedSessions,
    discardedLinesCount,
    signals: {
      hasExplicitDates: true,
      hasExplicitTimes: true,
      hasTopicOnlyMarkers,
      hasProseOrCodeNoise,
      hasWeekdaysWithoutDates,
    },
  };
}

/**
 * Validates a Gemini/structured plan under the exact same strict rules:
 * only explicit calendar dates + explicit start/end times + valid study topics survive.
 */
export function validateStructuredPlanStrict(
  plan: StructuredPdfPlan,
  extraction?: PdfTextExtractionResult | null
): StrictScheduleValidationResult {
  const validSessions: StrictScheduleSession[] = [];
  let discarded = 0;

  for (const item of plan.dailyPlans ?? []) {
    const date = sanitizeIsoDate(item.date);
    const startTime = sanitizeTime24(item.startTime);
    const endTime = sanitizeTime24(item.endTime);
    const title = item.title?.trim() ?? '';

    if (
      !date ||
      item.dateProvenance === 'suggested' ||
      !startTime ||
      !endTime ||
      item.timeProvenance === 'suggested' ||
      timeToMinutes(endTime) <= timeToMinutes(startTime) ||
      !title ||
      isBreakLabel(title) ||
      isNonScheduleCodeOrProseLine(title)
    ) {
      discarded += 1;
      continue;
    }

    validSessions.push({
      id: item.id || `strict-ai-${validSessions.length + 1}`,
      title: title.slice(0, 120),
      date,
      startTime,
      endTime,
      category: sanitizeCategory(item.category),
      priority: sanitizePriority(item.priority),
      sourcePage: item.sourcePage || 1,
      notes: item.notes?.trim() ?? '',
      included: true,
    });
  }

  // Only allow weeklyPlans if they carry BOTH explicit startDate and endDate within a bounded <=14 day range
  for (const wk of plan.weeklyPlans ?? []) {
    const startDate = sanitizeIsoDate(wk.startDate);
    const endDate = sanitizeIsoDate(wk.endDate);
    const startTime = sanitizeTime24(wk.startTime);
    const endTime = sanitizeTime24(wk.endTime);
    const title = wk.title?.trim() ?? '';
    if (!startDate || !endDate || !startTime || !endTime || !title) {
      discarded += 1;
      continue;
    }
    const resolvedDate = resolveWeekdayWithinExplicitRange(wk.weekday, startDate, endDate);
    if (
      !resolvedDate ||
      timeToMinutes(endTime) <= timeToMinutes(startTime) ||
      isBreakLabel(title) ||
      isNonScheduleCodeOrProseLine(title)
    ) {
      discarded += 1;
      continue;
    }

    validSessions.push({
      id: wk.id || `strict-wk-${validSessions.length + 1}`,
      title: title.slice(0, 120),
      date: resolvedDate,
      startTime,
      endTime,
      category: sanitizeCategory(wk.category),
      priority: sanitizePriority(wk.priority),
      sourcePage: wk.sourcePage || 1,
      notes: wk.notes?.trim() ?? '',
      included: true,
    });
  }

  const deduped = sortAndDedupeSessions(validSessions);
  const localCheck = extraction ? extractAndValidateStrictSchedule(extraction) : null;

  if (deduped.length === 0) {
    return {
      accepted: false,
      classification: localCheck?.classification ?? 'rejected_notes_or_textbook',
      errorMessage: STRICT_SCHEDULE_REJECTION_MESSAGE,
      reasonDetail:
        localCheck?.reasonDetail ??
        'No complete study entries with explicit calendar dates, study times, and topics could be verified.',
      sessions: [],
      discardedLinesCount: discarded,
      signals: localCheck?.signals ?? {
        hasExplicitDates: false,
        hasExplicitTimes: false,
        hasTopicOnlyMarkers: (plan.monthlyGoals?.length ?? 0) > 0,
        hasProseOrCodeNoise: false,
        hasWeekdaysWithoutDates: (plan.weeklyPlans?.length ?? 0) > 0,
      },
    };
  }

  return {
    accepted: true,
    classification: discarded > 0 ? 'mixed_with_valid_schedule' : 'valid_schedule',
    errorMessage: null,
    reasonDetail:
      discarded > 0
        ? `Validated ${deduped.length} dated and timed study sessions; non-schedule or undated items were excluded.`
        : `Validated ${deduped.length} dated and timed study sessions.`,
    sessions: deduped,
    discardedLinesCount: discarded,
    signals: {
      hasExplicitDates: true,
      hasExplicitTimes: true,
      hasTopicOnlyMarkers: (plan.monthlyGoals?.length ?? 0) > 0,
      hasProseOrCodeNoise: false,
      hasWeekdaysWithoutDates: false,
    },
  };
}

/**
 * Checks candidate strict sessions against existing calendar activities & imported fingerprints
 * BEFORE the user confirms importing.
 */
export function evaluateStrictSchedulePreviewMetrics(
  sessions: StrictScheduleSession[],
  existingActivities: ScheduleActivity[],
  importedFingerprints: string[],
  sourceFile: string,
  computeFingerprintFn: (
    sourceFile: string,
    titleOrText: string,
    date?: string | null,
    startTime?: string | null
  ) => string = computeImportFingerprint
): {
  duplicateIds: Set<string>;
  conflictsById: Map<string, ScheduleActivity[]>;
  validSelectedCount: number;
  duplicateCount: number;
  conflictCount: number;
} {
  const duplicateIds = new Set<string>();
  const conflictsById = new Map<string, ScheduleActivity[]>();
  const fingerprintSet = new Set(importedFingerprints);

  let validSelectedCount = 0;

  for (const s of sessions) {
    if (!s.included) continue;
    validSelectedCount += 1;

    const normalizedTitle = s.title.trim().toLowerCase();
    const fp = computeFingerprintFn(sourceFile, s.title, s.date, s.startTime);

    const exactMatch = existingActivities.some(
      (a) =>
        a.date === s.date &&
        a.startTime === s.startTime &&
        a.endTime === s.endTime &&
        a.title.trim().toLowerCase() === normalizedTitle
    );

    if (exactMatch || fingerprintSet.has(fp)) {
      duplicateIds.add(s.id);
    }

    const sStart = timeToMinutes(s.startTime);
    const sEnd = timeToMinutes(s.endTime);
    const conflicts = existingActivities.filter((a) => {
      if (a.date !== s.date) return false;
      if (
        a.startTime === s.startTime &&
        a.endTime === s.endTime &&
        a.title.trim().toLowerCase() === normalizedTitle
      ) {
        return false; // Duplicate handled separately
      }
      const aStart = timeToMinutes(a.startTime);
      const aEnd = timeToMinutes(a.endTime);
      return Math.max(sStart, aStart) < Math.min(sEnd, aEnd);
    });

    if (conflicts.length > 0) {
      conflictsById.set(s.id, conflicts);
    }
  }

  return {
    duplicateIds,
    conflictsById,
    validSelectedCount,
    duplicateCount: duplicateIds.size,
    conflictCount: conflictsById.size,
  };
}
