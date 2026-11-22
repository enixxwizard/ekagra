import * as pdfjsLib from 'pdfjs-dist';
import {
  ActivityCategory,
  PdfExtractedQuotation,
  PdfSuggestedActivity,
  PriorityLevel,
  ScheduleActivity,
} from '../types/dayflow';
import type {
  ExtractedPdfPage,
  ExtractedPdfTable,
  PdfPageImagePayload,
  StructuredPdfPlan,
} from '../types/pdfSchedule';
import {
  generateId,
  getTodayISO,
  minutesToTime24,
  parseTimeToMinutes,
  shiftDateISO,
} from './dateTime';
import {
  computeDocumentHash,
  computeImportFingerprint,
  expandWeekdayRange,
  isBreakLabel,
  MONTH_FULL_NAMES,
  normalizeMonthNumber,
  normalizeWeekdayNumber,
  parseTimeRangeString,
  timeToMinutes,
  validateAndAuditStructuredPlan,
  WEEKDAY_FULL_NAMES,
} from './pdfSchemaValidator';
import { resolveActivitiesForDate } from './recurrence';
import { findAvailableSlots } from './scheduler';

export { computeDocumentHash, computeImportFingerprint };

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export type { ExtractedPdfPage };

export interface PdfTextExtractionResult {
  fileName: string;
  fileSize: number;
  documentHash: string;
  pageCount: number;
  pages: ExtractedPdfPage[];
  totalCharacters: number;
  hasComplexTables: boolean;
  isScannedOrEmpty: boolean;
  scannedReason?: string;
}

export interface RawParsedPdfCandidate {
  title: string;
  notes: string;
  explicitDate: string | null;
  explicitStartTime: string | null;
  durationMinutes: number;
  category: ActivityCategory;
  priority: PriorityLevel;
  pageNumber: number;
  kind: 'activity' | 'deadline' | 'exam' | 'task';
}

export interface RawParsedPdfQuote {
  text: string;
  category: ActivityCategory;
  pageNumber: number;
}

interface PositionedCellToken {
  text: string;
  x: number;
  endX: number;
  y: number;
}

interface WeekdayColumnAnchor {
  weekday: number;
  label: string;
  centerX: number;
  leftBound: number;
  rightBound: number;
}

const MONTH_MAP: Record<string, number> = {
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

function buildPageRowsAndTables(
  rawItems: Array<{ str: string; transform?: number[]; width?: number }>,
  pageNumber: number
): { plainText: string; layoutText: string; tables: ExtractedPdfTable[] } {
  const tokens: PositionedCellToken[] = [];

  for (const item of rawItems) {
    const clean = item.str.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const x = Array.isArray(item.transform) ? Number(item.transform[4]) || 0 : 0;
    const y = Array.isArray(item.transform) ? Number(item.transform[5]) || 0 : 0;
    const estWidth =
      typeof item.width === 'number' && item.width > 0 ? item.width : clean.length * 4.8;
    tokens.push({
      text: clean,
      x,
      endX: x + estWidth,
      y,
    });
  }

  if (tokens.length === 0) {
    return { plainText: '', layoutText: '', tables: [] };
  }

  // Sort top-to-bottom (descending PDF y), then left-to-right (ascending x)
  tokens.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 4.5) return b.y - a.y;
    return a.x - b.x;
  });

  // Cluster tokens into visual rows by Y-coordinate proximity
  const rawRows: PositionedCellToken[][] = [];
  for (const token of tokens) {
    const lastRow = rawRows[rawRows.length - 1];
    if (!lastRow || Math.abs(lastRow[0].y - token.y) > 4.5) {
      rawRows.push([token]);
    } else {
      lastRow.push(token);
    }
  }

  // Within each row, merge adjacent tokens separated by small word spaces while preserving column gaps
  const cellRows: PositionedCellToken[][] = rawRows.map((row) => {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    const merged: PositionedCellToken[] = [];

    for (const tok of sorted) {
      const prev = merged[merged.length - 1];
      if (!prev) {
        merged.push({ ...tok });
        continue;
      }
      const gap = tok.x - prev.endX;
      const avgCharWidth =
        prev.text.length > 0 ? Math.max(3.5, Math.min(8, (prev.endX - prev.x) / prev.text.length)) : 5;
      if (gap <= Math.max(10, avgCharWidth * 2.2)) {
        prev.text = `${prev.text} ${tok.text}`.replace(/\s+/g, ' ').trim();
        prev.endX = Math.max(prev.endX, tok.endX);
      } else {
        merged.push({ ...tok });
      }
    }
    return merged;
  });

  const plainLines = cellRows.map((r) => r.map((c) => c.text).join(' ').trim()).filter(Boolean);
  const layoutLines = cellRows
    .map((r) => (r.length > 1 ? r.map((c) => c.text).join(' | ') : r[0]?.text ?? ''))
    .filter(Boolean);

  // Reconstruct weekday-column tables from spatial cell positions
  const tables: ExtractedPdfTable[] = [];
  let rowIdx = 0;

  while (rowIdx < cellRows.length) {
    const row = cellRows[rowIdx];
    const weekdayCells: Array<{ cell: PositionedCellToken; weekday: number }> = [];

    for (const cell of row) {
      const words = cell.text.split(/[\s/|]+/).filter(Boolean);
      if (words.length <= 2) {
        for (const w of words) {
          const wd = normalizeWeekdayNumber(w);
          if (wd !== null && !weekdayCells.some((wc) => wc.weekday === wd)) {
            weekdayCells.push({ cell, weekday: wd });
            break;
          }
        }
      }
    }

    if (weekdayCells.length >= 2) {
      weekdayCells.sort((a, b) => a.cell.x - b.cell.x);
      const anchors: WeekdayColumnAnchor[] = weekdayCells.map((wc, i) => {
        const centerX = (wc.cell.x + wc.cell.endX) / 2;
        const prevCenter =
          i > 0
            ? (weekdayCells[i - 1].cell.x + weekdayCells[i - 1].cell.endX) / 2
            : centerX - 100;
        const nextCenter =
          i < weekdayCells.length - 1
            ? (weekdayCells[i + 1].cell.x + weekdayCells[i + 1].cell.endX) / 2
            : centerX + 100;

        return {
          weekday: wc.weekday,
          label: WEEKDAY_FULL_NAMES[wc.weekday],
          centerX,
          leftBound: (prevCenter + centerX) / 2,
          rightBound: (centerX + nextCenter) / 2,
        };
      });

      const headers = ['Time', ...anchors.map((a) => a.label)];
      const tableRows: string[][] = [];
      let currentRowCells: string[] | null = null;
      let cursor = rowIdx + 1;

      while (cursor < cellRows.length) {
        const candidateRow = cellRows[cursor];
        const rowJoined = candidateRow.map((c) => c.text).join(' ');

        // Stop table if we hit a new section header
        if (
          /^(monthly\s+(goals|roadmap|priorities|plan)|deadlines?|assignments?|important\s+dates|notes|quotations?)\b/i.test(
            rowJoined
          )
        ) {
          break;
        }

        // Stop if another weekday header row starts
        const nextHeaderMatches = candidateRow.filter(
          (c) => c.text.split(/\s+/).length <= 2 && normalizeWeekdayNumber(c.text) !== null
        );
        if (nextHeaderMatches.length >= 2) {
          break;
        }

        const timeCell = candidateRow.find((c) => parseTimeRangeString(c.text) !== null);
        const firstDayLeft = anchors[0].leftBound;

        // Check whether cells align inside weekday columns or look like prose below the table
        const alignedTokens = candidateRow.filter(
          (c) => (c.x + c.endX) / 2 >= firstDayLeft - 12 && c !== timeCell
        );

        if (!timeCell && alignedTokens.length === 0 && candidateRow.length === 1 && rowJoined.length > 55) {
          break;
        }

        if (timeCell) {
          if (currentRowCells) {
            tableRows.push(currentRowCells);
          }
          currentRowCells = new Array(1 + anchors.length).fill('');
          currentRowCells[0] = timeCell.text;
        }

        if (currentRowCells) {
          for (const cell of candidateRow) {
            if (cell === timeCell) continue;
            const midX = (cell.x + cell.endX) / 2;
            let matchedIdx = -1;
            let bestDist = Infinity;

            for (let aIdx = 0; aIdx < anchors.length; aIdx++) {
              const anc = anchors[aIdx];
              if (midX >= anc.leftBound && midX <= anc.rightBound) {
                matchedIdx = aIdx;
                break;
              }
              const dist = Math.abs(midX - anc.centerX);
              if (dist < bestDist) {
                bestDist = dist;
                matchedIdx = aIdx;
              }
            }

            if (matchedIdx !== -1 && (midX >= firstDayLeft - 24 || bestDist < 75)) {
              const existing = currentRowCells[1 + matchedIdx];
              currentRowCells[1 + matchedIdx] = existing
                ? `${existing} ${cell.text}`.trim()
                : cell.text;
            }
          }
        }

        cursor++;
      }

      if (currentRowCells) {
        tableRows.push(currentRowCells);
      }

      if (tableRows.length > 0) {
        tables.push({
          pageNumber,
          headers,
          weekdayColumns: anchors.map((a, i) => ({
            colIndex: 1 + i,
            weekday: a.weekday,
            label: a.label,
          })),
          rows: tableRows,
        });
        rowIdx = cursor;
        continue;
      }
    }

    rowIdx++;
  }

  return {
    plainText: plainLines.join('\n').trim(),
    layoutText: layoutLines.join('\n').trim(),
    tables,
  };
}

export async function extractPdfPages(file: File): Promise<PdfTextExtractionResult> {
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });

  const pdf = await loadingTask.promise;
  const maxPages = Math.min(pdf.numPages, 60);
  const pages: ExtractedPdfPage[] = [];
  let totalNonWhitespace = 0;
  let detectedTableCount = 0;

  for (let p = 1; p <= maxPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const rawItems = content.items.filter(
      (item): item is Extract<(typeof content.items)[number], { str: string }> => 'str' in item
    );

    const { plainText, layoutText, tables } = buildPageRowsAndTables(rawItems, p);
    totalNonWhitespace += plainText.replace(/\s+/g, '').length;
    detectedTableCount += tables.length;

    pages.push({
      pageNumber: p,
      text: plainText,
      layoutText,
      tables,
    });
  }

  const avgPerPage = maxPages > 0 ? totalNonWhitespace / maxPages : 0;
  const isScannedOrEmpty = totalNonWhitespace < 30 || (maxPages >= 2 && avgPerPage < 12);
  const hasComplexTables =
    detectedTableCount > 0 || pages.some((p) => (p.layoutText.match(/\|/g) ?? []).length >= 6);

  return {
    fileName: file.name,
    fileSize: file.size,
    documentHash: computeDocumentHash(file.name, pages, file.size),
    pageCount: pdf.numPages,
    pages,
    totalCharacters: totalNonWhitespace,
    hasComplexTables,
    isScannedOrEmpty,
    scannedReason: isScannedOrEmpty
      ? 'No selectable text was found in this PDF. It appears to be a scanned or image-based document—use Gemini multimodal analysis to read it directly, or convert with OCR.'
      : undefined,
  };
}

/**
 * Renders selected PDF pages to compact JPEG images for multimodal table/scanned PDF understanding.
 */
export async function renderPdfPagesAsImages(
  file: File,
  maxPages = 4
): Promise<PdfPageImagePayload[]> {
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });

  const pdf = await loadingTask.promise;
  const limit = Math.min(pdf.numPages, maxPages);
  const images: PdfPageImagePayload[] = [];

  for (let p = 1; p <= limit; p++) {
    const page = await pdf.getPage(p);
    const baseViewport = page.getViewport({ scale: 1 });
    const targetScale = Math.min(1.6, Math.max(1.0, 1100 / Math.max(1, baseViewport.width)));
    const viewport = page.getViewport({ scale: targetScale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport, canvas } as never).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    const base64Data = dataUrl.split(',')[1] ?? '';
    if (base64Data) {
      images.push({
        pageNumber: p,
        mimeType: 'image/jpeg',
        base64Data,
      });
    }
  }

  return images;
}

function toIsoDateSafe(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function detectExplicitDateInLine(line: string, referenceDateISO: string): string | null {
  const refYear = Number(referenceDateISO.slice(0, 4)) || new Date().getFullYear();

  // 1. YYYY-MM-DD
  const isoMatch = /\b(20\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/.exec(line);
  if (isoMatch) {
    return toIsoDateSafe(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  // 2. Month DD(, YYYY)
  const monthFirstMatch =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\b/i.exec(
      line
    );
  if (monthFirstMatch) {
    const m = MONTH_MAP[monthFirstMatch[1].toLowerCase()];
    const day = Number(monthFirstMatch[2]);
    const year = monthFirstMatch[3] ? Number(monthFirstMatch[3]) : refYear;
    if (m) return toIsoDateSafe(year, m, day);
  }

  // 3. DD Month (YYYY)
  const dayFirstMatch =
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?:,?\s*(20\d{2}))?\b/i.exec(
      line
    );
  if (dayFirstMatch) {
    const day = Number(dayFirstMatch[1]);
    const m = MONTH_MAP[dayFirstMatch[2].toLowerCase()];
    const year = dayFirstMatch[3] ? Number(dayFirstMatch[3]) : refYear;
    if (m) return toIsoDateSafe(year, m, day);
  }

  // 4. MM/DD(/YYYY) or DD/MM(/YYYY)
  const slashMatch = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}|\d{2}))?\b/.exec(line);
  if (slashMatch) {
    const a = Number(slashMatch[1]);
    const b = Number(slashMatch[2]);
    let year = refYear;
    if (slashMatch[3]) {
      year = slashMatch[3].length === 2 ? 2000 + Number(slashMatch[3]) : Number(slashMatch[3]);
    }
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
      return toIsoDateSafe(year, a, b);
    }
    if (b >= 1 && b <= 12 && a >= 1 && a <= 31) {
      return toIsoDateSafe(year, b, a);
    }
  }

  return null;
}

function to24hMinutes(hourRaw: number, minuteRaw: number, ampm?: string): number | null {
  let h = hourRaw;
  const m = minuteRaw;
  if (m < 0 || m > 59) return null;
  if (ampm) {
    const p = ampm.toLowerCase();
    if (h < 1 || h > 12) return null;
    if (p === 'pm' && h !== 12) h += 12;
    if (p === 'am' && h === 12) h = 0;
  } else if (h < 0 || h > 23) {
    return null;
  }
  return h * 60 + m;
}

function detectExplicitTimeAndDuration(line: string): {
  startTime: string | null;
  durationMinutes: number | null;
} {
  const rangeParsed = parseTimeRangeString(line);
  if (rangeParsed) {
    return {
      startTime: rangeParsed.startTime,
      durationMinutes: timeToMinutes(rangeParsed.endTime) - timeToMinutes(rangeParsed.startTime),
    };
  }

  const singleRegex = /\b(\d{1,2})(?::(\d{2}))\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/i;
  const singleMatch = singleRegex.exec(line);
  let detectedStart: string | null = null;
  if (singleMatch) {
    if (singleMatch[1]) {
      const min = to24hMinutes(Number(singleMatch[1]), Number(singleMatch[2]), singleMatch[3]);
      if (min !== null) detectedStart = minutesToTime24(min);
    } else if (singleMatch[4] && singleMatch[5]) {
      const min = to24hMinutes(Number(singleMatch[4]), 0, singleMatch[5]);
      if (min !== null) detectedStart = minutesToTime24(min);
    }
  }

  let detectedDuration: number | null = null;
  const minMatch = /\b(\d{1,3})\s*(?:min|mins|minute|minutes)\b/i.exec(line);
  const hrMatch = /\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i.exec(line);
  if (minMatch) {
    const val = Number(minMatch[1]);
    if (val >= 10 && val <= 300) detectedDuration = val;
  } else if (hrMatch) {
    const val = Math.round(Number(hrMatch[1]) * 60);
    if (val >= 15 && val <= 360) detectedDuration = val;
  }

  return {
    startTime: detectedStart,
    durationMinutes: detectedDuration,
  };
}

function inferCategory(text: string): ActivityCategory {
  const lower = text.toLowerCase();
  if (/\b(workout|gym|yoga|run|sleep|exercise|meditation|health|walk|break|lunch)\b/.test(lower)) {
    return 'Health';
  }
  if (/\b(deep work|focus|pomodoro|coding sprint|uninterrupted)\b/.test(lower)) {
    return 'Deep Focus';
  }
  if (/\b(meeting|standup|client|deliverable|deploy|sprint|development|backend|spring boot|project)\b/.test(lower)) {
    return 'Work';
  }
  if (/\b(submit|register|form|email|admin|fee|enrollment|check-in)\b/.test(lower)) {
    return 'Admin';
  }
  if (/\b(errand|grocer|dinner|family|personal|call)\b/.test(lower)) {
    return 'Personal';
  }
  return 'Study';
}

function inferPriority(text: string): PriorityLevel {
  const lower = text.toLowerCase();
  if (/\b(exam|final|midterm|due|deadline|urgent|mandatory|graded|submit|test|quiz)\b/.test(lower)) {
    return 'high';
  }
  if (/\b(optional|bonus|extra|suggested|break|lunch)\b/.test(lower)) {
    return 'low';
  }
  return 'medium';
}

function inferKind(text: string): RawParsedPdfCandidate['kind'] {
  const lower = text.toLowerCase();
  if (/\b(exam|midterm|final|quiz|test)\b/.test(lower)) return 'exam';
  if (/\b(due|deadline|submission|submit)\b/.test(lower)) return 'deadline';
  if (/\b(assignment|homework|read|chapter|complete|write|prepare|task)\b/.test(lower)) return 'task';
  return 'activity';
}

function cleanActionTitle(line: string): string {
  let cleaned = line
    .replace(/^[-*•\u2022\d.)\]]+\s*/, '')
    .replace(/\b(20\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/g, '')
    .replace(
      /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|—|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi,
      ''
    )
    .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, '')
    .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, '')
    .replace(/^[:\-–—|\s]+|[:\-–—|\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (cleaned.length > 100) {
    cleaned = `${cleaned.slice(0, 97).trim()}...`;
  }
  return cleaned;
}

function stripWeekdayTokens(line: string): string {
  return line
    .replace(
      /\b(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b[,:\-–—\s]*/gi,
      ''
    )
    .replace(/^[:\-–—|\s]+|[:\-–—|\s]+$/g, '')
    .trim();
}

/**
 * Local table-aware parser producing StructuredPdfPlan (Daily, Weekly, Monthly Goals, Deadlines, Breaks, Warnings).
 * Preserves table column/row relationships without flattening tables into fragments.
 */
export function parsePdfPagesToStructuredPlan(
  fileName: string,
  pages: ExtractedPdfPage[],
  options?: {
    documentHash?: string;
    referenceDateISO?: string;
  }
): StructuredPdfPlan {
  const referenceDateISO = options?.referenceDateISO ?? getTodayISO();
  const refYear = Number(referenceDateISO.slice(0, 4)) || new Date().getFullYear();
  const documentHash =
    options?.documentHash ?? computeDocumentHash(fileName, pages, 0);

  const rawWeekly: Array<Record<string, unknown>> = [];
  const rawDaily: Array<Record<string, unknown>> = [];
  const rawMonthly: Array<Record<string, unknown>> = [];
  const rawDeadlines: Array<Record<string, unknown>> = [];
  const rawBreaks: Array<Record<string, unknown>> = [];
  const rawQuotes: Array<Record<string, unknown>> = [];
  const rawWarnings: Array<Record<string, unknown>> = [];

  const seenWeeklyKeys = new Set<string>();
  const seenDeadlineKeys = new Set<string>();
  const seenDailyKeys = new Set<string>();
  const seenQuotes = new Set<string>();

  const monthlyMap = new Map<
    string,
    { month: number; year: number | null; goals: string[]; sourcePage: number; category: ActivityCategory }
  >();

  const addMonthlyGoal = (month: number, year: number | null, goalText: string, pageNumber: number) => {
    const clean = goalText.replace(/^[-*•\u2022:\s]+/, '').trim();
    if (clean.length < 3) return;
    const key = `${month}::${year ?? ''}`;
    const existing = monthlyMap.get(key);
    const items = clean
      .split(/\s*[;•]\s*|\s+-\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    if (existing) {
      for (const it of items) {
        if (!existing.goals.includes(it)) existing.goals.push(it);
      }
    } else {
      monthlyMap.set(key, {
        month,
        year,
        goals: items.length > 0 ? items : [clean],
        sourcePage: pageNumber,
        category: inferCategory(clean),
      });
    }
  };

  for (const page of pages) {
    const consumedTableTimeRanges = new Set<string>();
    let lastEndMinutes: number | undefined;

    // 1. Parse detected 2D tables first (columns -> weekdays, rows -> time slots)
    for (const table of page.tables ?? []) {
      const tableWeekdays = table.weekdayColumns.map((w) => w.weekday);

      for (const row of table.rows) {
        const timeText = row[0] ?? '';
        const timeRange = parseTimeRangeString(timeText, lastEndMinutes);
        if (!timeRange) continue;
        lastEndMinutes = timeToMinutes(timeRange.endTime);
        consumedTableTimeRanges.add(`${page.pageNumber}::${timeText.trim()}`);

        const nonEmptyDayCells = table.weekdayColumns
          .map((wc) => ({
            weekday: wc.weekday,
            text: (row[wc.colIndex] ?? '').trim(),
          }))
          .filter((c) => c.text.length > 0 && !/^[-–—]+$/.test(c.text));

        // If a break/lunch label spans the row (e.g. centered in one column or repeated across columns)
        if (
          nonEmptyDayCells.length > 0 &&
          nonEmptyDayCells.every((c) => isBreakLabel(c.text))
        ) {
          const breakTitle = nonEmptyDayCells[0].text;
          rawBreaks.push({
            title: breakTitle,
            weekdays:
              nonEmptyDayCells.length === 1 && tableWeekdays.length > 1
                ? tableWeekdays
                : nonEmptyDayCells.map((c) => c.weekday),
            startTime: timeRange.startTime,
            endTime: timeRange.endTime,
            sourcePage: page.pageNumber,
            provenance: 'explicit',
          });
          continue;
        }

        for (const cell of nonEmptyDayCells) {
          if (isBreakLabel(cell.text)) {
            rawBreaks.push({
              title: cell.text,
              weekdays: [cell.weekday],
              startTime: timeRange.startTime,
              endTime: timeRange.endTime,
              sourcePage: page.pageNumber,
              provenance: 'explicit',
            });
            continue;
          }

          const key = `${cell.weekday}::${timeRange.startTime}::${timeRange.endTime}::${cell.text.toLowerCase()}`;
          if (seenWeeklyKeys.has(key)) continue;
          seenWeeklyKeys.add(key);

          rawWeekly.push({
            title: cell.text,
            weekday: cell.weekday,
            startTime: timeRange.startTime,
            endTime: timeRange.endTime,
            category: inferCategory(cell.text),
            priority: inferPriority(cell.text),
            sourcePage: page.pageNumber,
            provenance: 'explicit',
          });
        }
      }
    }

    // 2. Parse structured lines / pipe-delimited rows / inline weekday spans / monthly goals / deadlines
    const lines = (page.layoutText || page.text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 3);

    let activeWeekdayScope: number[] | null = null;
    let activeSingleDate: string | null = null;
    let activeMonthScope: { month: number; year: number | null } | null = null;
    let lineLastEndMin: number | undefined;

    for (const line of lines) {
      // Skip raw pipe rows that were already consumed accurately by table extraction
      const firstPipeCell = line.split('|')[0]?.trim() ?? '';
      if (consumedTableTimeRanges.has(`${page.pageNumber}::${firstPipeCell}`)) {
        continue;
      }

      // Skip table header lines
      const pipeParts = line.split('|').map((p) => p.trim()).filter(Boolean);
      const headerDayMatches = pipeParts.filter((p) => normalizeWeekdayNumber(p) !== null);
      if (headerDayMatches.length >= 2) {
        activeWeekdayScope = headerDayMatches
          .map((p) => normalizeWeekdayNumber(p))
          .filter((d): d is number => d !== null);
        activeMonthScope = null;
        lineLastEndMin = undefined;
        continue;
      }

      // Detect standalone weekday-range heading (e.g., "Monday–Saturday", "Monday - Friday:")
      const rangeDayMatch =
        /^(?:schedule|timetable|weekly\s+(?:plan|schedule|timetable)|days)?[:\s-]*(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s*(?:-|–|—|to)\s*(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s*[:\-]*$/i.exec(
          line
        );
      if (rangeDayMatch) {
        const sDay = normalizeWeekdayNumber(rangeDayMatch[1]);
        const eDay = normalizeWeekdayNumber(rangeDayMatch[2]);
        if (sDay !== null && eDay !== null) {
          activeWeekdayScope = expandWeekdayRange(sDay, eDay);
          activeMonthScope = null;
          activeSingleDate = null;
          continue;
        }
      }

      // Detect Monthly or Deadlines section headings
      if (/^(?:monthly\s+(?:goals?|roadmap|priorities|objectives?|targets?|plan)|deadlines?|assignments?|important\s+dates|exam\s+dates?)/i.test(line)) {
        activeWeekdayScope = null;
        activeSingleDate = null;
        lineLastEndMin = undefined;
        continue;
      }

      // Detect Monthly roadmap lines like "March: Spring Boot, SQL and PostgreSQL" or "December 2026 - Core Java"
      const monthGoalMatch =
        /^(?:[-*•]\s*)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?:\s+(20\d{2}))?\s*(?::|-|–|—|\|)\s*(.+)$/i.exec(
          line
        );
      if (monthGoalMatch && !/\b\d{1,2}:\d{2}\b/.test(line)) {
        const mNum = normalizeMonthNumber(monthGoalMatch[1]);
        const yr = monthGoalMatch[2] ? Number(monthGoalMatch[2]) : null;
        const goalRest = monthGoalMatch[3].trim();
        // Make sure it isn't "15 December: submit" (that begins with day number, handled below)
        if (mNum && goalRest.length >= 3 && !/^\d{1,2}\b/.test(goalRest)) {
          activeWeekdayScope = null;
          activeMonthScope = { month: mNum, year: yr };
          addMonthlyGoal(mNum, yr, goalRest, page.pageNumber);
          continue;
        }
      }

      // Detect deadline / submission / exam lines (e.g., "Submit assignment by 15 December")
      const lineDate = detectExplicitDateInLine(line, referenceDateISO);
      const isDeadlineCue = /\b(submit|submission|due|deadline|by\s+\d{1,2}\s+[a-z]+|assignment|final\s+exam|midterm)\b/i.test(
        line
      );
      const lineTimeRange = parseTimeRangeString(line, lineLastEndMin);

      if (isDeadlineCue && (!lineTimeRange || Boolean(lineDate))) {
        const cleanTitle = cleanActionTitle(
          line
            .replace(/\b(?:by|due|on|before)\s+\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+(?:\s+20\d{2})?/gi, '')
            .replace(/\b(?:by|due|on|before)\s+[a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*20\d{2})?/gi, '')
        );
        if (cleanTitle.length >= 3) {
          const dlKey = `${cleanTitle.toLowerCase()}::${lineDate ?? ''}`;
          if (!seenDeadlineKeys.has(dlKey)) {
            seenDeadlineKeys.add(dlKey);
            rawDeadlines.push({
              title: cleanTitle,
              dueDate: lineDate,
              dueTime: lineTimeRange?.startTime ?? detectExplicitTimeAndDuration(line).startTime,
              estimatedMinutes: inferKind(line) === 'exam' ? 90 : 60,
              category: inferCategory(line),
              priority: 'high',
              kind: /\b(exam|midterm|final|quiz|test)\b/i.test(line)
                ? 'exam'
                : /\bassignment\b/i.test(line)
                ? 'assignment'
                : 'deadline',
              sourcePage: page.pageNumber,
              provenance: lineDate ? 'explicit' : 'inferred',
              notes: lineDate ? '' : 'No calendar date stated in PDF',
            });
            continue;
          }
        }
      }

      // Detect inline weekday + time range + activity (+ optional exception like "(Saturday: Maths test)")
      if (lineTimeRange) {
        lineLastEndMin = timeToMinutes(lineTimeRange.endTime);

        // Check if line explicitly names a single weekday (e.g., "Monday, 9:00-10:30, Maths" or "Tue 10:45-11:45 SSC Reasoning")
        const explicitDayRegex =
          /\b(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi;
        const matchedDays = Array.from(line.matchAll(explicitDayRegex))
          .map((m) => ({
            raw: m[0],
            weekday: normalizeWeekdayNumber(m[1]),
            index: m.index ?? 0,
          }))
          .filter((d): d is { raw: string; weekday: number; index: number } => d.weekday !== null);

        // Extract parenthetical override such as "(Saturday: Maths test)" or "(Sat: DSA review)"
        const parenOverrideMatch =
          /\((mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s*:\s*([^)]+)\)/i.exec(
            line
          );

        if (parenOverrideMatch) {
          const overrideDay = normalizeWeekdayNumber(parenOverrideMatch[1]);
          const overrideTitle = parenOverrideMatch[2].trim();
          const baseText = line.replace(parenOverrideMatch[0], '').trim();
          const baseTitle = stripWeekdayTokens(cleanActionTitle(baseText));
          const targetWeekdays =
            activeWeekdayScope && activeWeekdayScope.length > 0
              ? activeWeekdayScope
              : [1, 2, 3, 4, 5, 6];

          for (const wd of targetWeekdays) {
            const cellTitle = wd === overrideDay ? overrideTitle : baseTitle;
            if (!cellTitle) continue;
            if (isBreakLabel(cellTitle)) {
              rawBreaks.push({
                title: cellTitle,
                weekdays: [wd],
                startTime: lineTimeRange.startTime,
                endTime: lineTimeRange.endTime,
                sourcePage: page.pageNumber,
                provenance: 'explicit',
              });
            } else {
              const key = `${wd}::${lineTimeRange.startTime}::${lineTimeRange.endTime}::${cellTitle.toLowerCase()}`;
              if (!seenWeeklyKeys.has(key)) {
                seenWeeklyKeys.add(key);
                rawWeekly.push({
                  title: cellTitle,
                  weekday: wd,
                  startTime: lineTimeRange.startTime,
                  endTime: lineTimeRange.endTime,
                  category: inferCategory(cellTitle),
                  priority: inferPriority(cellTitle),
                  sourcePage: page.pageNumber,
                  provenance: 'explicit',
                });
              }
            }
          }
          continue;
        }

        // Handle "Monday, 9:00-10:30, Maths"
        if (matchedDays.length === 1 && !lineDate) {
          const wd = matchedDays[0].weekday;
          const cellTitle = stripWeekdayTokens(cleanActionTitle(line));
          if (cellTitle.length >= 2) {
            if (isBreakLabel(cellTitle)) {
              rawBreaks.push({
                title: cellTitle,
                weekdays: [wd],
                startTime: lineTimeRange.startTime,
                endTime: lineTimeRange.endTime,
                sourcePage: page.pageNumber,
                provenance: 'explicit',
              });
            } else {
              const key = `${wd}::${lineTimeRange.startTime}::${lineTimeRange.endTime}::${cellTitle.toLowerCase()}`;
              if (!seenWeeklyKeys.has(key)) {
                seenWeeklyKeys.add(key);
                rawWeekly.push({
                  title: cellTitle,
                  weekday: wd,
                  startTime: lineTimeRange.startTime,
                  endTime: lineTimeRange.endTime,
                  category: inferCategory(cellTitle),
                  priority: inferPriority(cellTitle),
                  sourcePage: page.pageNumber,
                  provenance: 'explicit',
                });
              }
            }
            continue;
          }
        }

        // Handle lines inside an active weekday range scope (e.g., under "Monday–Saturday")
        if (activeWeekdayScope && activeWeekdayScope.length > 0 && !lineDate) {
          const cellTitle = stripWeekdayTokens(cleanActionTitle(line));
          if (cellTitle.length >= 2) {
            if (isBreakLabel(cellTitle)) {
              rawBreaks.push({
                title: cellTitle,
                weekdays: activeWeekdayScope,
                startTime: lineTimeRange.startTime,
                endTime: lineTimeRange.endTime,
                sourcePage: page.pageNumber,
                provenance: 'explicit',
              });
            } else {
              const isVaryingNote = /\b(varying|depending on|varies)\b/i.test(cellTitle);
              if (isVaryingNote) {
                rawWarnings.push({
                  severity: 'warning',
                  section: 'weekly',
                  sourcePage: page.pageNumber,
                  message: `"${cellTitle}" (${lineTimeRange.startTime}–${lineTimeRange.endTime}) says it varies by weekday—review or use Gemini AI to assign exact per-day subjects.`,
                });
              }
              for (const wd of activeWeekdayScope) {
                const key = `${wd}::${lineTimeRange.startTime}::${lineTimeRange.endTime}::${cellTitle.toLowerCase()}`;
                if (!seenWeeklyKeys.has(key)) {
                  seenWeeklyKeys.add(key);
                  rawWeekly.push({
                    title: cellTitle,
                    weekday: wd,
                    startTime: lineTimeRange.startTime,
                    endTime: lineTimeRange.endTime,
                    category: inferCategory(cellTitle),
                    priority: inferPriority(cellTitle),
                    sourcePage: page.pageNumber,
                    provenance: isVaryingNote ? 'inferred' : 'explicit',
                  });
                }
              }
            }
            continue;
          }
        }

        // Otherwise treat as a Daily Plan timed item
        const dailyTitle = cleanActionTitle(line);
        if (dailyTitle.length >= 2) {
          if (isBreakLabel(dailyTitle)) {
            rawBreaks.push({
              title: dailyTitle,
              weekdays: [],
              date: lineDate ?? activeSingleDate,
              startTime: lineTimeRange.startTime,
              endTime: lineTimeRange.endTime,
              sourcePage: page.pageNumber,
              provenance: 'explicit',
            });
          } else {
            const targetDate = lineDate ?? activeSingleDate;
            const dKey = `${targetDate ?? ''}::${lineTimeRange.startTime}::${dailyTitle.toLowerCase()}`;
            if (!seenDailyKeys.has(dKey)) {
              seenDailyKeys.add(dKey);
              rawDaily.push({
                title: dailyTitle,
                date: targetDate,
                dateProvenance: targetDate ? 'explicit' : 'suggested',
                startTime: lineTimeRange.startTime,
                endTime: lineTimeRange.endTime,
                timeProvenance: 'explicit',
                category: inferCategory(dailyTitle),
                priority: inferPriority(dailyTitle),
                sourcePage: page.pageNumber,
              });
            }
          }
          continue;
        }
      }

      // Pure date heading (e.g. "2026-12-01" or "December 1, 2026")
      if (lineDate && !lineTimeRange && line.length < 40) {
        activeSingleDate = lineDate;
        activeWeekdayScope = null;
        activeMonthScope = null;
        continue;
      }

      // Continuation bullet under an active month goal
      if (activeMonthScope && /^[-*•\u2022]/.test(line)) {
        addMonthlyGoal(activeMonthScope.month, activeMonthScope.year, line, page.pageNumber);
        continue;
      }

      // Quotations & key study notes
      const quotedMatches = line.match(/[“"]([^”"]{24,320})[”"]/g);
      if (quotedMatches) {
        for (const rawQuoted of quotedMatches) {
          const cleanQ = rawQuoted.replace(/^[“"]|[”"]$/g, '').trim();
          if (cleanQ.length >= 24 && !seenQuotes.has(cleanQ.toLowerCase()) && rawQuotes.length < 25) {
            seenQuotes.add(cleanQ.toLowerCase());
            rawQuotes.push({
              text: cleanQ,
              category: inferCategory(cleanQ),
              pageNumber: page.pageNumber,
            });
          }
        }
      }

      const quotePrefixMatch =
        /^(?:quote|quotation|note|key takeaway|takeaway|definition|important|remember|principle|formula|summary|highlight)\s*:\s*(.+)$/i.exec(
          line
        );
      if (quotePrefixMatch) {
        const cleanQ = quotePrefixMatch[1].trim().replace(/^[“"]|[”"]$/g, '').trim();
        if (cleanQ.length >= 16 && !seenQuotes.has(cleanQ.toLowerCase()) && rawQuotes.length < 25) {
          seenQuotes.add(cleanQ.toLowerCase());
          rawQuotes.push({
            text: cleanQ,
            category: inferCategory(cleanQ),
            pageNumber: page.pageNumber,
          });
        }
      }
    }

    // Check for multi-month ranges like "December through May: ..."
    const fullPageText = page.text;
    const rangeMonthMatch =
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:through|to|-|–)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.exec(
        fullPageText
      );
    if (rangeMonthMatch && monthlyMap.size === 0) {
      const startM = normalizeMonthNumber(rangeMonthMatch[1]);
      const endM = normalizeMonthNumber(rangeMonthMatch[2]);
      if (startM && endM) {
        rawWarnings.push({
          severity: 'info',
          section: 'monthly',
          sourcePage: page.pageNumber,
          message: `Detected a multi-month roadmap (${MONTH_FULL_NAMES[startM]}–${MONTH_FULL_NAMES[endM]}). Click "Analyze with Gemini AI" if individual month goals need deeper extraction.`,
        });
      }
    }
  }

  for (const entry of monthlyMap.values()) {
    rawMonthly.push({
      month: entry.month,
      monthLabel: MONTH_FULL_NAMES[entry.month],
      year: entry.year ?? refYear,
      goals: entry.goals,
      category: entry.category,
      sourcePage: entry.sourcePage,
      provenance: 'explicit',
    });
  }

  return validateAndAuditStructuredPlan(
    {
      dailyPlans: rawDaily,
      weeklyPlans: rawWeekly,
      monthlyGoals: rawMonthly,
      deadlines: rawDeadlines,
      breakPeriods: rawBreaks,
      quotations: rawQuotes,
      warnings: rawWarnings,
    },
    {
      fileName,
      documentHash,
      analysisSource: 'local',
    }
  );
}

export function assignSuggestedSlots(
  fileName: string,
  candidates: RawParsedPdfCandidate[],
  quotes: RawParsedPdfQuote[],
  existingActivities: ScheduleActivity[],
  referenceDateISO = getTodayISO()
): {
  activities: PdfSuggestedActivity[];
  quotations: PdfExtractedQuotation[];
} {
  const daysPool: Record<string, { start: number; end: number }[]> = {};
  for (let d = 0; d < 14; d++) {
    const dateISO = shiftDateISO(referenceDateISO, d);
    const dayResolved = resolveActivitiesForDate(existingActivities, dateISO);
    daysPool[dateISO] = findAvailableSlots(dayResolved, dateISO, 20, 8, 21).map((s) => ({
      start: parseTimeToMinutes(s.startTime),
      end: parseTimeToMinutes(s.endTime),
    }));
  }

  const reserveSlot = (targetDate: string | null, durationMinutes: number): { date: string; startTime: string } => {
    if (targetDate) {
      if (!daysPool[targetDate]) {
        const dayResolved = resolveActivitiesForDate(existingActivities, targetDate);
        daysPool[targetDate] = findAvailableSlots(dayResolved, targetDate, 20, 8, 21).map((s) => ({
          start: parseTimeToMinutes(s.startTime),
          end: parseTimeToMinutes(s.endTime),
        }));
      }
      const slots = daysPool[targetDate];
      for (const slot of slots) {
        if (slot.end - slot.start >= durationMinutes) {
          const startTime = minutesToTime24(slot.start);
          slot.start += durationMinutes + 15;
          return { date: targetDate, startTime };
        }
      }
      return { date: targetDate, startTime: '09:00' };
    }

    for (let d = 0; d < 14; d++) {
      const dateISO = shiftDateISO(referenceDateISO, d);
      const slots = daysPool[dateISO];
      for (const slot of slots) {
        if (slot.end - slot.start >= durationMinutes) {
          const startTime = minutesToTime24(slot.start);
          slot.start += durationMinutes + 15;
          return { date: dateISO, startTime };
        }
      }
    }

    return { date: referenceDateISO, startTime: '09:00' };
  };

  const activities: PdfSuggestedActivity[] = candidates.map((cand) => {
    const duration = Math.max(15, Math.min(240, cand.durationMinutes || 60));
    const dateStatus = cand.explicitDate ? 'explicit' : 'suggested';
    const timeStatus = cand.explicitStartTime ? 'explicit' : 'suggested';

    let finalDate = cand.explicitDate;
    let finalTime = cand.explicitStartTime;

    if (!finalDate || !finalTime) {
      const slot = reserveSlot(finalDate, duration);
      if (!finalDate) finalDate = slot.date;
      if (!finalTime) finalTime = slot.startTime;
    }

    return {
      id: generateId(),
      title: cand.title,
      notes: cand.notes,
      date: finalDate,
      dateStatus,
      startTime: finalTime,
      timeStatus,
      durationMinutes: duration,
      category: cand.category,
      priority: cand.priority,
      sourceFile: fileName,
      pageNumber: cand.pageNumber,
      kind: cand.kind,
      fingerprint: computeImportFingerprint(fileName, cand.title, finalDate, finalTime),
      status: 'pending',
    };
  });

  const quotations: PdfExtractedQuotation[] = quotes.map((q) => ({
    id: generateId(),
    text: q.text,
    category: q.category,
    sourceFile: fileName,
    pageNumber: q.pageNumber,
    fingerprint: computeImportFingerprint(fileName, q.text),
    saved: false,
  }));

  return { activities, quotations };
}

export function parsePdfPagesLocally(
  fileName: string,
  pages: ExtractedPdfPage[],
  existingActivities: ScheduleActivity[],
  referenceDateISO = getTodayISO()
): {
  activities: PdfSuggestedActivity[];
  quotations: PdfExtractedQuotation[];
} {
  const structured = parsePdfPagesToStructuredPlan(fileName, pages, { referenceDateISO });
  const candidates: RawParsedPdfCandidate[] = structured.dailyPlans.map((d) => ({
    title: d.title,
    notes: d.notes,
    explicitDate: d.date,
    explicitStartTime: d.timeProvenance === 'explicit' ? d.startTime : null,
    durationMinutes: Math.max(15, timeToMinutes(d.endTime) - timeToMinutes(d.startTime)),
    category: d.category,
    priority: d.priority,
    pageNumber: d.sourcePage,
    kind: 'activity',
  }));

  for (const dl of structured.deadlines) {
    candidates.push({
      title: dl.title,
      notes: dl.notes,
      explicitDate: dl.dueDate,
      explicitStartTime: dl.dueTime,
      durationMinutes: dl.estimatedMinutes,
      category: dl.category,
      priority: dl.priority,
      pageNumber: dl.sourcePage,
      kind: dl.kind === 'exam' ? 'exam' : 'deadline',
    });
  }

  const assigned = assignSuggestedSlots(
    fileName,
    candidates,
    structured.quotations.map((q) => ({
      text: q.text,
      category: q.category,
      pageNumber: q.pageNumber,
    })),
    existingActivities,
    referenceDateISO
  );

  return assigned;
}
