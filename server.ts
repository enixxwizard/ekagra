import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';
import {
  computeDocumentHash,
  sanitizeIsoDate,
  validateAndAuditStructuredPlan,
} from './src/utils/pdfSchemaValidator';
import type { ExtractedPdfTable, StructuredPdfPlan } from './src/types/pdfSchedule';
import type {
  EnhancerActivitySnapshot,
  EnhancerTaskSnapshot,
  ScheduleEnhancementResponseBody,
} from './src/types/scheduleEnhancer';
import {
  isValidIsoDate,
  isValidTime24,
  logEnhancerDiagnostic,
  runDeterministicScheduleAnalysis,
  sanitizeActivitiesForEnhancer,
  validateEnhancementSuggestions,
} from './src/utils/scheduleEnhancer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 40;

interface IncomingPdfPage {
  pageNumber: number;
  text: string;
  layoutText?: string;
  tables?: ExtractedPdfTable[];
}

interface IncomingPageImage {
  pageNumber: number;
  mimeType: 'image/jpeg' | 'image/png';
  base64Data: string;
}

interface AnalyzePdfBody {
  fileName?: unknown;
  documentHash?: unknown;
  referenceDate?: unknown;
  pages?: unknown;
  pageImages?: unknown;
}

const analysisCache = new Map<string, { expiresAt: number; plan: StructuredPdfPlan }>();

function getCachedPlan(key: string): StructuredPdfPlan | null {
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    analysisCache.delete(key);
    return null;
  }
  return entry.plan;
}

function setCachedPlan(key: string, plan: StructuredPdfPlan): void {
  if (analysisCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = analysisCache.keys().next().value;
    if (oldestKey) analysisCache.delete(oldestKey);
  }
  analysisCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, plan });
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function classifyGeminiHttpError(err: unknown): {
  status: number;
  message: string;
  retryable: boolean;
} {
  const rawMessage = err instanceof Error ? err.message : String(err ?? 'Unknown Gemini error');
  const lower = rawMessage.toLowerCase();

  if (lower.includes('400') || lower.includes('invalid_argument') || lower.includes('bad request')) {
    return {
      status: 400,
      message: 'Schedule request format was rejected by Gemini.',
      retryable: false,
    };
  }
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('api_key') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated')
  ) {
    return {
      status: 403,
      message: 'Gemini API authentication failed on the server. Verify GEMINI_API_KEY configuration.',
      retryable: false,
    };
  }
  if (lower.includes('404') || lower.includes('not_found')) {
    return {
      status: 404,
      message: 'Configured Gemini model is unavailable.',
      retryable: false,
    };
  }
  if (lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('rate limit') || lower.includes('quota')) {
    return {
      status: 429,
      message: 'Gemini rate limit reached. Please wait a moment and retry.',
      retryable: false,
    };
  }
  if (
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('unavailable') ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed')
  ) {
    return {
      status: 503,
      message: 'Gemini service is temporarily unavailable. Please try again.',
      retryable: true,
    };
  }

  return {
    status: 502,
    message: 'Schedule analysis failed due to an upstream AI error. Please retry.',
    retryable: false,
  };
}

async function generateWithTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1200];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classified = classifyGeminiHttpError(err);
      if (!classified.retryable || attempt === delays.length) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  throw lastError;
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean(getGeminiClient()),
    });
  });

  app.post('/api/pdf/analyze', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as AnalyzePdfBody;
    const fileName =
      typeof body.fileName === 'string' && body.fileName.trim()
        ? body.fileName.trim().slice(0, 180)
        : 'Document.pdf';
    const referenceDate =
      sanitizeIsoDate(body.referenceDate) ?? new Date().toISOString().slice(0, 10);

    const pages: IncomingPdfPage[] = [];
    let totalChars = 0;

    if (Array.isArray(body.pages)) {
      for (const rawPage of body.pages.slice(0, 40)) {
        if (!rawPage || typeof rawPage !== 'object') continue;
        const pObj = rawPage as Record<string, unknown>;
        if (typeof pObj.pageNumber !== 'number') continue;
        const rawText =
          typeof pObj.layoutText === 'string' && pObj.layoutText.trim()
            ? pObj.layoutText.trim()
            : typeof pObj.text === 'string'
            ? pObj.text.trim()
            : '';

        const tables = Array.isArray(pObj.tables)
          ? (pObj.tables as ExtractedPdfTable[]).slice(0, 8)
          : [];

        if (!rawText && tables.length === 0) continue;
        const remainingBudget = 110_000 - totalChars;
        if (remainingBudget <= 0) break;

        const clipped = rawText.slice(0, remainingBudget);
        totalChars += clipped.length;
        pages.push({
          pageNumber: Math.max(1, Math.floor(pObj.pageNumber)),
          text: typeof pObj.text === 'string' ? pObj.text.trim().slice(0, remainingBudget) : clipped,
          layoutText: clipped,
          tables,
        });
      }
    }

    const pageImages: IncomingPageImage[] = [];
    if (Array.isArray(body.pageImages)) {
      for (const rawImg of body.pageImages.slice(0, 6)) {
        if (!rawImg || typeof rawImg !== 'object') continue;
        const imgObj = rawImg as Record<string, unknown>;
        const mimeType =
          imgObj.mimeType === 'image/png' || imgObj.mimeType === 'image/jpeg'
            ? imgObj.mimeType
            : null;
        const base64Data =
          typeof imgObj.base64Data === 'string' ? imgObj.base64Data.trim() : '';
        if (!mimeType || !base64Data || base64Data.length > 2_000_000) continue;
        if (!/^[A-Za-z0-9+/=]+$/.test(base64Data)) continue;
        pageImages.push({
          pageNumber:
            typeof imgObj.pageNumber === 'number' && imgObj.pageNumber >= 1
              ? Math.floor(imgObj.pageNumber)
              : pageImages.length + 1,
          mimeType,
          base64Data,
        });
      }
    }

    if (pages.length === 0 && pageImages.length === 0) {
      res.status(400).json({
        error: 'No PDF text or page snapshots were provided for analysis.',
      });
      return;
    }

    const documentHash =
      typeof body.documentHash === 'string' && body.documentHash.trim()
        ? body.documentHash.trim().slice(0, 64)
        : computeDocumentHash(fileName, pages);
    const cacheKey = `${documentHash}::${pageImages.length > 0 ? 'mm' : 'txt'}`;

    const cached = getCachedPlan(cacheKey);
    if (cached) {
      res.json({ ...cached, cached: true });
      return;
    }

    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'Gemini API key is not configured on this server. Add GEMINI_API_KEY in Settings > Secrets, or review the local table extraction.',
      });
      return;
    }

    const formattedDocument = pages
      .map((p) => {
        const tableSection =
          p.tables && p.tables.length > 0
            ? `\n[Detected Spatial Tables on Page ${p.pageNumber}]\n${JSON.stringify(
                p.tables.map((t) => ({ headers: t.headers, rows: t.rows })),
                null,
                1
              )}`
            : '';
        return `--- PAGE ${p.pageNumber} ---\n${p.layoutText || p.text}${tableSection}`;
      })
      .join('\n\n');

    const promptText = [
      `Document filename: ${fileName}`,
      `Reference date (today): ${referenceDate}`,
      '',
      'Analyze this document and classify EVERY planning structure without flattening tables or inventing missing dates/weekdays.',
      formattedDocument
        ? `\nExtracted table-preserving text:\n${formattedDocument}`
        : '\nNo selectable text was available; inspect the attached PDF page images carefully.',
    ].join('\n');

    const parts: Array<
      | { text: string }
      | { inlineData: { mimeType: 'image/jpeg' | 'image/png'; data: string } }
    > = [];

    for (const img of pageImages) {
      parts.push({
        inlineData: {
          mimeType: img.mimeType,
          data: img.base64Data,
        },
      });
    }
    parts.push({ text: promptText });

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          systemInstruction: [
            'You are a precision timetable and academic schedule extraction engine for DayFlow.',
            'Your task is to classify PDF schedules into structured JSON with exact table-cell fidelity.',
            '',
            'STRICT CLASSIFICATION RULES:',
            '1. Determine documentType: "daily" | "weekly" | "monthly" | "deadlines" | "mixed".',
            '2. WEEKLY RECURRING PLANS ("weeklyPlans"):',
            '   - Use for any recurring weekly timetable (e.g., Monday-Saturday timetables, "Monday, 9:00-10:30, Maths", column headers Mon..Sun).',
            '   - Emit ONE entry per (weekday, time-slot, activity) with weekday as full name ("Monday".."Sunday") or integer 0..6 (0=Sunday, 1=Monday..6=Saturday).',
            '   - CRITICAL: Preserve column-to-weekday alignment! If Saturday has "Maths test" while Monday-Friday have "Maths", Monday-Friday MUST say "Maths" and Saturday MUST say "Maths test". Never shift cells across columns.',
            '   - Use 24-hour HH:mm times! Understand daytime academic wrap-around: if a timetable runs 9:00-10:30, 10:45-11:45, 11:45-12:45, 12:45-1:15, 1:15-2:45, 3:00-4:00, then 12:45-1:15 is 12:45-13:15, 1:15-2:45 is 13:15-14:45, and 3:00-4:00 is 15:00-16:00.',
            '   - Only set startDate / endDate (YYYY-MM-DD) if explicitly stated in the PDF; otherwise leave null.',
            '3. BREAK PERIODS ("breakPeriods"):',
            '   - Any "Break", "Lunch", "Tea break", "Recess", or "Rest" slot belongs in "breakPeriods", NEVER in "weeklyPlans" or "dailyPlans".',
            '4. DAILY PLANS ("dailyPlans"):',
            '   - Use ONLY for single specific calendar-date events/schedules (e.g., "2026-12-01 09:00-10:30 Orientation"). Do NOT put recurring weekly classes here.',
            '5. MONTHLY GOALS ("monthlyGoals"):',
            '   - Use for monthly learning priorities/roadmaps (e.g., "March: Spring Boot, SQL and PostgreSQL", "December through May priorities").',
            '   - NEVER assign arbitrary daily dates or clock times to monthly goals.',
            '6. DEADLINES ("deadlines"):',
            '   - Use for assignments, project submissions, or exam dates (e.g., "Submit assignment by 15 December").',
            '   - NEVER invent a dueDate if none is written in the PDF; leave dueDate null and note it in warnings.',
            '7. QUOTATIONS ("quotations"):',
            '   - Extract standalone study quotes, definitions, rules, or key takeaways.',
            '8. PROVENANCE & VALIDATION ("warnings"):',
            '   - Mark provenance accurately as "explicit" (directly stated) or "inferred" (derived from layout/context).',
            '   - Add a clear warning in "warnings" whenever any table cell, weekday column, ambiguous time, or missing date is uncertain so the user can review it.',
          ].join('\n'),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              documentType: { type: Type.STRING },
              dailyPlans: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    date: { type: Type.STRING },
                    dateProvenance: { type: Type.STRING },
                    startTime: { type: Type.STRING },
                    endTime: { type: Type.STRING },
                    timeProvenance: { type: Type.STRING },
                    category: { type: Type.STRING },
                    priority: { type: Type.STRING },
                    sourcePage: { type: Type.INTEGER },
                    notes: { type: Type.STRING },
                  },
                  required: ['title', 'startTime', 'endTime', 'sourcePage'],
                },
              },
              weeklyPlans: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    weekday: { type: Type.STRING },
                    startTime: { type: Type.STRING },
                    endTime: { type: Type.STRING },
                    startDate: { type: Type.STRING },
                    endDate: { type: Type.STRING },
                    category: { type: Type.STRING },
                    priority: { type: Type.STRING },
                    sourcePage: { type: Type.INTEGER },
                    provenance: { type: Type.STRING },
                    notes: { type: Type.STRING },
                  },
                  required: ['title', 'weekday', 'startTime', 'endTime', 'sourcePage'],
                },
              },
              monthlyGoals: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    month: { type: Type.STRING },
                    year: { type: Type.INTEGER },
                    goals: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    category: { type: Type.STRING },
                    sourcePage: { type: Type.INTEGER },
                    provenance: { type: Type.STRING },
                  },
                  required: ['month', 'goals', 'sourcePage'],
                },
              },
              deadlines: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    dueDate: { type: Type.STRING },
                    dueTime: { type: Type.STRING },
                    estimatedMinutes: { type: Type.INTEGER },
                    category: { type: Type.STRING },
                    priority: { type: Type.STRING },
                    kind: { type: Type.STRING },
                    sourcePage: { type: Type.INTEGER },
                    provenance: { type: Type.STRING },
                    notes: { type: Type.STRING },
                  },
                  required: ['title', 'sourcePage'],
                },
              },
              breakPeriods: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    weekdays: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    date: { type: Type.STRING },
                    startTime: { type: Type.STRING },
                    endTime: { type: Type.STRING },
                    sourcePage: { type: Type.INTEGER },
                    provenance: { type: Type.STRING },
                  },
                  required: ['title', 'startTime', 'endTime', 'sourcePage'],
                },
              },
              quotations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING },
                    category: { type: Type.STRING },
                    pageNumber: { type: Type.INTEGER },
                  },
                  required: ['text', 'pageNumber'],
                },
              },
              warnings: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    severity: { type: Type.STRING },
                    section: { type: Type.STRING },
                    message: { type: Type.STRING },
                    sourcePage: { type: Type.INTEGER },
                  },
                  required: ['message'],
                },
              },
            },
            required: [
              'documentType',
              'dailyPlans',
              'weeklyPlans',
              'monthlyGoals',
              'deadlines',
              'breakPeriods',
              'warnings',
            ],
          },
        },
      });

      const rawJson = (response.text ?? '{}').trim();
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;

      const validated = validateAndAuditStructuredPlan(parsed, {
        fileName,
        documentHash,
        analysisSource: pageImages.length > 0 ? 'gemini-multimodal' : 'gemini',
        cached: false,
      });

      setCachedPlan(cacheKey, validated);
      res.json(validated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gemini PDF analysis failed.';
      const status =
        message.includes('403') || message.includes('API_KEY')
          ? 403
          : message.includes('429') || message.includes('RESOURCE_EXHAUSTED')
          ? 429
          : 502;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/schedule/enhance', async (req: Request, res: Response) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const todayISO = isValidIsoDate(rawBody.todayISO)
      ? rawBody.todayISO
      : new Date().toISOString().slice(0, 10);
    const nowMinutes =
      typeof rawBody.nowMinutes === 'number' && Number.isFinite(rawBody.nowMinutes)
        ? Math.max(0, Math.min(1439, Math.round(rawBody.nowMinutes)))
        : new Date().getHours() * 60 + new Date().getMinutes();
    const timeZone =
      typeof rawBody.timeZone === 'string' && rawBody.timeZone.trim()
        ? rawBody.timeZone.trim().slice(0, 64)
        : 'Local Time';
    const dailyCapacityHours =
      typeof rawBody.dailyCapacityHours === 'number' && Number.isFinite(rawBody.dailyCapacityHours)
        ? Math.max(2, Math.min(16, rawBody.dailyCapacityHours))
        : 8;

    const rawActivities = Array.isArray(rawBody.activities) ? rawBody.activities : [];
    const rawTasks = Array.isArray(rawBody.tasks) ? rawBody.tasks : [];

    // Strip any unconsented fields (descriptions, notes, quotations, auth fields)
    const allowedCategories = new Set(['Work', 'Study', 'Health', 'Personal', 'Deep Work', 'Admin']);
    const allowedPriorities = new Set(['low', 'medium', 'high']);
    const allowedStatuses = new Set(['pending', 'completed', 'skipped']);
    const allowedFrequencies = new Set(['none', 'daily', 'weekdays', 'weekly', 'custom']);

    const cleanActivities: EnhancerActivitySnapshot[] = [];
    for (const item of rawActivities.slice(0, 300)) {
      if (!item || typeof item !== 'object') continue;
      const a = item as Record<string, unknown>;
      if (typeof a.id !== 'string' || typeof a.title !== 'string') continue;
      const recRaw = (a.recurrence && typeof a.recurrence === 'object'
        ? a.recurrence
        : {}) as Record<string, unknown>;
      const frequency =
        typeof recRaw.frequency === 'string' && allowedFrequencies.has(recRaw.frequency)
          ? (recRaw.frequency as EnhancerActivitySnapshot['recurrence']['frequency'])
          : 'none';
      const customDays = Array.isArray(recRaw.customDays)
        ? recRaw.customDays.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
        : undefined;
      const endDate =
        typeof recRaw.endDate === 'string' && isValidIsoDate(recRaw.endDate)
          ? recRaw.endDate
          : null;

      const overrides: EnhancerActivitySnapshot['occurrenceOverrides'] = {};
      if (a.occurrenceOverrides && typeof a.occurrenceOverrides === 'object') {
        for (const [k, v] of Object.entries(a.occurrenceOverrides as Record<string, unknown>)) {
          if (!isValidIsoDate(k) || !v || typeof v !== 'object') continue;
          const ov = v as Record<string, unknown>;
          overrides[k] = {
            title: typeof ov.title === 'string' ? ov.title.trim().slice(0, 120) : undefined,
            startTime: isValidTime24(ov.startTime) ? ov.startTime : undefined,
            endTime: isValidTime24(ov.endTime) ? ov.endTime : undefined,
            category:
              typeof ov.category === 'string' && allowedCategories.has(ov.category)
                ? (ov.category as EnhancerActivitySnapshot['category'])
                : undefined,
            priority:
              typeof ov.priority === 'string' && allowedPriorities.has(ov.priority)
                ? (ov.priority as EnhancerActivitySnapshot['priority'])
                : undefined,
            status:
              typeof ov.status === 'string' && allowedStatuses.has(ov.status)
                ? (ov.status as EnhancerActivitySnapshot['status'])
                : undefined,
          };
        }
      }

      cleanActivities.push({
        id: a.id.trim().slice(0, 80),
        title: a.title.trim().slice(0, 120),
        date: typeof a.date === 'string' ? a.date.trim() : '',
        startTime: typeof a.startTime === 'string' ? a.startTime.trim() : '',
        endTime: typeof a.endTime === 'string' ? a.endTime.trim() : '',
        category:
          typeof a.category === 'string' && allowedCategories.has(a.category)
            ? (a.category as EnhancerActivitySnapshot['category'])
            : 'Personal',
        priority:
          typeof a.priority === 'string' && allowedPriorities.has(a.priority)
            ? (a.priority as EnhancerActivitySnapshot['priority'])
            : 'medium',
        status:
          typeof a.status === 'string' && allowedStatuses.has(a.status)
            ? (a.status as EnhancerActivitySnapshot['status'])
            : 'pending',
        linkedTaskId: typeof a.linkedTaskId === 'string' ? a.linkedTaskId.trim().slice(0, 80) : null,
        recurrence: {
          frequency,
          customDays,
          endDate,
        },
        excludedDates: Array.isArray(a.excludedDates)
          ? a.excludedDates.filter((d): d is string => isValidIsoDate(d))
          : [],
        occurrenceOverrides: overrides,
      });
    }

    const cleanTasks: EnhancerTaskSnapshot[] = [];
    for (const item of rawTasks.slice(0, 200)) {
      if (!item || typeof item !== 'object') continue;
      const t = item as Record<string, unknown>;
      if (typeof t.id !== 'string' || typeof t.title !== 'string') continue;
      cleanTasks.push({
        id: t.id.trim().slice(0, 80),
        title: t.title.trim().slice(0, 120),
        priority:
          typeof t.priority === 'string' && allowedPriorities.has(t.priority)
            ? (t.priority as EnhancerTaskSnapshot['priority'])
            : 'medium',
        dueDate: typeof t.dueDate === 'string' && isValidIsoDate(t.dueDate) ? t.dueDate : null,
        category:
          typeof t.category === 'string' && allowedCategories.has(t.category)
            ? (t.category as EnhancerTaskSnapshot['category'])
            : 'Study',
        completed: Boolean(t.completed),
        estimatedMinutes:
          typeof t.estimatedMinutes === 'number' && Number.isFinite(t.estimatedMinutes)
            ? Math.max(10, Math.min(480, Math.round(t.estimatedMinutes)))
            : 30,
        scheduledActivityId:
          typeof t.scheduledActivityId === 'string' ? t.scheduledActivityId.trim().slice(0, 80) : null,
      });
    }

    if (cleanActivities.length === 0) {
      const emptyResponse: ScheduleEnhancementResponseBody = {
        status: 'empty',
        emptyReason: 'no_activities',
        message: 'Add activities to your schedule before requesting AI suggestions.',
        summary: 'No schedule activities yet.',
        suggestions: [],
        deterministicSummary: {
          overlapsCount: 0,
          overloadedDaysCount: 0,
          deadlineConflictsCount: 0,
          flexibleBlocksCount: 0,
          breakOpportunitiesCount: 0,
        },
      };
      res.json(emptyResponse);
      return;
    }

    const report = runDeterministicScheduleAnalysis({
      activities: cleanActivities,
      tasks: cleanTasks,
      todayISO,
      nowMinutes,
      timeZone,
      dailyCapacityHours,
      horizonDays: 7,
    });

    const deterministicSummary = {
      overlapsCount: report.overlaps.length,
      overloadedDaysCount: report.overloadedDaysCount,
      deadlineConflictsCount: report.deadlineFindings.length,
      flexibleBlocksCount: report.flexibleBlocksCount,
      breakOpportunitiesCount: report.days.reduce((sum, d) => sum + d.contiguousWorkRuns.length, 0),
    };

    logEnhancerDiagnostic('deterministic_completed', {
      validOccurrences: report.validOccurrencesCount,
      invalidActivities: report.invalidActivitiesCount,
      overlaps: deterministicSummary.overlapsCount,
      overloadedDays: deterministicSummary.overloadedDaysCount,
      deadlineFindings: deterministicSummary.deadlineConflictsCount,
    });

    const ai = getGeminiClient();
    if (!ai) {
      res.status(503).json({
        error:
          'Gemini API key is not configured on the server. Add GEMINI_API_KEY in environment secrets to enable Improve My Plan.',
      });
      return;
    }

    const currentHour = Math.floor(nowMinutes / 60);
    const currentMin = nowMinutes % 60;
    const currentTimeLabel = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;

    const promptContext = {
      todayISO,
      currentTime24: currentTimeLabel,
      nowMinutes,
      timeZone,
      dailyCapacityHours,
      overlaps: report.overlaps,
      deadlineFindings: report.deadlineFindings,
      days: report.days.map((d) => ({
        date: d.date,
        weekday: d.weekday,
        plannedMinutes: d.plannedMinutes,
        capacityMinutes: d.capacityMinutes,
        isOverloaded: d.isOverloaded,
        overloadMinutes: d.overloadMinutes,
        freeMinutesAfterNow: d.freeMinutesAfterNow,
        openSlots: d.openSlots.slice(0, 8),
        contiguousWorkRuns: d.contiguousWorkRuns,
        blocks: d.blocks,
      })),
    };

    logEnhancerDiagnostic('gemini_request_started', {
      daysAnalyzed: report.days.length,
      sourceActivities: report.totalSourceActivities,
    });

    try {
      const response = await generateWithTransientRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: [
            'Analyze this pre-computed 7-day DayFlow schedule report and propose up to 3 high-impact, realistic improvements.',
            '',
            JSON.stringify(promptContext),
          ].join('\n'),
          config: {
            systemInstruction: [
              'You are DayFlow AI Schedule Coach. Produce realistic, concrete, conflict-free schedule improvements.',
              'STRICT RULES:',
              '1. Propose AT MOST 3 suggestions in "suggestions", ordered by highest practical impact (resolving overlaps, deadline risks, overloaded days, or long contiguous study/work streaks without breaks).',
              '2. If the schedule is already balanced with no overlaps, no overloaded days, no urgent unscheduled deadlines, and adequate breaks, set "noImprovementsNeeded": true and "suggestions": []. Do NOT invent unnecessary churn.',
              '3. ONLY reference exact existing activityId values from days[].blocks and exact existing taskId values from deadlineFindings.',
              '4. Respect fixed vs flexible commitments: prefer moving commitmentType: "flexible" blocks rather than "fixed" blocks (completed, high-priority, recurring, or already started today). If moving a recurring block is genuinely required, set scope: "single" on a single date.',
              '5. NEVER place any activity or break into a past time slot! On todayISO, every newStartTime or startTime MUST be >= currentTime24. All dates MUST be between todayISO and 7 days ahead.',
              '6. EVERY proposed block MUST fit strictly inside openSlots (or replace the moved block without overlapping ANY other block in days[].blocks). Use exact 24-hour HH:mm times and YYYY-MM-DD dates.',
              '7. Change types allowed in changes[]:',
              '   - type: "reschedule_activity" -> MUST include activityId, occurrenceDate (the day the block currently occurs), newDate, newStartTime, newEndTime, scope ("single" | "series"). If newDate != occurrenceDate, scope MUST be "single".',
              '   - type: "schedule_task" -> MUST include taskId, date, startTime, endTime.',
              '   - type: "insert_break" -> MUST include title (short break name like "15m Recovery Break"), date, startTime, endTime (5-60 min, placed inside a gap or openSlot).',
              '8. Every suggestion MUST clearly populate title, reason, evidence (referencing specific days/times/conflicts from the report), beforePreview, afterPreview, and tradeOffs (honest side-effects or "Minimal trade-off").',
            ].join('\n'),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                summary: { type: Type.STRING },
                noImprovementsNeeded: { type: Type.BOOLEAN },
                suggestions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      title: { type: Type.STRING },
                      reason: { type: Type.STRING },
                      evidence: { type: Type.STRING },
                      beforePreview: { type: Type.STRING },
                      afterPreview: { type: Type.STRING },
                      tradeOffs: { type: Type.STRING },
                      changes: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            type: { type: Type.STRING },
                            activityId: { type: Type.STRING },
                            occurrenceDate: { type: Type.STRING },
                            newDate: { type: Type.STRING },
                            newStartTime: { type: Type.STRING },
                            newEndTime: { type: Type.STRING },
                            scope: { type: Type.STRING },
                            taskId: { type: Type.STRING },
                            title: { type: Type.STRING },
                            date: { type: Type.STRING },
                            startTime: { type: Type.STRING },
                            endTime: { type: Type.STRING },
                          },
                          required: ['type'],
                        },
                      },
                    },
                    required: [
                      'title',
                      'reason',
                      'evidence',
                      'beforePreview',
                      'afterPreview',
                      'tradeOffs',
                      'changes',
                    ],
                  },
                },
              },
              required: ['summary', 'noImprovementsNeeded', 'suggestions'],
            },
          },
        })
      );

      logEnhancerDiagnostic('gemini_response_received', {
        hasText: Boolean(response.text?.trim()),
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        res.status(502).json({
          error: 'Gemini returned an empty response. Please retry.',
        });
        return;
      }

      let parsed: {
        summary?: unknown;
        noImprovementsNeeded?: unknown;
        suggestions?: unknown;
      };
      try {
        parsed = JSON.parse(rawText);
      } catch {
        res.status(502).json({
          error: 'Gemini returned malformed JSON. Please retry.',
        });
        return;
      }

      const { valid: sanitizedActivities } = sanitizeActivitiesForEnhancer(cleanActivities);
      const { validSuggestions, rejectedReasons } = validateEnhancementSuggestions(
        parsed.suggestions,
        {
          activities: sanitizedActivities,
          tasks: cleanTasks,
          todayISO,
          nowMinutes,
        }
      );

      logEnhancerDiagnostic('suggestions_validated', {
        accepted: validSuggestions.length,
        rejected: rejectedReasons.length,
      });

      const summaryText =
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : 'Analyzed your upcoming 7-day schedule.';

      if (validSuggestions.length === 0) {
        if (rejectedReasons.length > 0 && report.hasActionableFindings) {
          res.status(422).json({
            error:
              'Suggested schedule edits failed conflict or timeline validation. Please retry for a fresh conflict-free plan.',
          });
          return;
        }

        const emptyResult: ScheduleEnhancementResponseBody = {
          status: 'empty',
          emptyReason: 'no_improvements',
          message: 'No meaningful improvements found',
          summary: summaryText,
          suggestions: [],
          deterministicSummary,
          rejectedCount: rejectedReasons.length,
        };
        res.json(emptyResult);
        return;
      }

      const successResult: ScheduleEnhancementResponseBody = {
        status: 'success',
        summary: summaryText,
        suggestions: validSuggestions,
        deterministicSummary,
        rejectedCount: rejectedReasons.length,
      };
      res.json(successResult);
    } catch (err) {
      const classified = classifyGeminiHttpError(err);
      logEnhancerDiagnostic('error_encountered', {
        status: classified.status,
      });
      res.status(classified.status).json({ error: classified.message });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(__dirname, 'dist');

  if (!isProd) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } catch {
      if (fs.existsSync(distDir)) {
        app.use(express.static(distDir));
        app.use((_req: Request, res: Response) => {
          res.sendFile(path.join(distDir, 'index.html'));
        });
      }
    }
  } else {
    app.use(express.static(distDir));
    app.use((_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DayFlow server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start DayFlow server:', err);
  process.exit(1);
});
