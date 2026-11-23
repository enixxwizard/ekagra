import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  computeDocumentHash,
  sanitizeIsoDate,
  validateAndAuditStructuredPlan,
} from './src/utils/pdfSchemaValidator';
import type { ExtractedPdfTable, StructuredPdfPlan } from './src/types/pdfSchedule';
import { verifyEkuRequestAuth } from './server/ekuAuth';
import { getSearchApiConfig } from './server/ekuSearch';
import {
  getOpenAIConfig,
  runEkuConversationTurn,
  sanitizeEkuRequestBody,
} from './server/ekuAgent';
import {
  createLibraryResource,
  deleteLibraryResource,
  getLibraryResourceById,
  inspectAndImportLibraryUrl,
  listLibraryResources,
  MAX_LIBRARY_COVER_BYTES,
  MAX_LIBRARY_PDF_BYTES,
  sanitizeTextField,
  saveLibraryCoverFile,
  saveLibraryPdfFile,
  serveLibraryCoverFile,
  serveLibraryPdfFile,
  updateLibraryResource,
  verifyLibraryAuth,
} from './server/libraryStore';
import type {
  CreateLibraryResourcePayload,
  LibraryCoverTemplateId,
  UpdateLibraryResourcePayload,
} from './src/types/library';

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
  const errObj = err && typeof err === 'object' ? (err as { status?: unknown; code?: unknown }) : null;
  const numericStatus =
    typeof errObj?.status === 'number'
      ? errObj.status
      : typeof errObj?.code === 'number'
      ? errObj.code
      : null;
  const rawMessage = err instanceof Error ? err.message : String(err ?? 'Unknown Gemini error');
  const lower = rawMessage.toLowerCase();

  if (
    numericStatus === 400 ||
    lower.includes('"code":400') ||
    lower.includes('invalid_argument') ||
    lower.includes('bad request')
  ) {
    return {
      status: 400,
      message: 'AI request format was rejected. Please review your schedule items and retry.',
      retryable: false,
    };
  }
  if (
    numericStatus === 401 ||
    numericStatus === 403 ||
    lower.includes('"code":401') ||
    lower.includes('"code":403') ||
    lower.includes('api_key') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated')
  ) {
    return {
      status: 403,
      message: 'AI service authentication failed on the server. Verify GEMINI_API_KEY configuration.',
      retryable: false,
    };
  }
  if (
    numericStatus === 404 ||
    lower.includes('"code":404') ||
    lower.includes('not_found')
  ) {
    return {
      status: 404,
      message: 'Configured AI model is currently unavailable on this server.',
      retryable: true,
    };
  }
  if (
    numericStatus === 429 ||
    lower.includes('"code":429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('quota')
  ) {
    return {
      status: 429,
      message: 'AI rate limit reached. Please wait a moment and retry.',
      retryable: true,
    };
  }
  if (
    numericStatus === 500 ||
    numericStatus === 502 ||
    numericStatus === 503 ||
    numericStatus === 504 ||
    lower.includes('"code":500') ||
    lower.includes('"code":502') ||
    lower.includes('"code":503') ||
    lower.includes('"code":504') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed')
  ) {
    return {
      status: 503,
      message: 'AI service temporarily unavailable due to high demand. Please retry in a moment.',
      retryable: true,
    };
  }

  return {
    status: 502,
    message: 'AI service encountered an upstream error. Please retry.',
    retryable: true,
  };
}

function parseGeminiJsonObject(rawText: string): Record<string, unknown> {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenceMatch ? fenceMatch[1] : trimmed).trim();

  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const sliced = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      if (sliced && typeof sliced === 'object' && !Array.isArray(sliced)) {
        return sliced as Record<string, unknown>;
      }
    }
  }

  throw new Error('Malformed JSON object in Gemini response');
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function generateWithTransientRetry<T>(
  fn: (modelName: string) => Promise<T>,
  primaryModel = 'gemini-4-hydrogen',
  fallbackModel = 'gemini-3.1-flash-lite'
): Promise<T> {
  const attempts: Array<{ model: string; waitBeforeMs: number; timeoutMs: number }> = [
    { model: primaryModel, waitBeforeMs: 0, timeoutMs: 16_000 },
    { model: fallbackModel, waitBeforeMs: 200, timeoutMs: 14_000 },
    { model: primaryModel, waitBeforeMs: 500, timeoutMs: 15_000 },
  ];
  let lastError: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const { model, waitBeforeMs, timeoutMs } = attempts[i];
    if (waitBeforeMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitBeforeMs));
    }
    try {
      return await withTimeout(fn(model), timeoutMs, `Gemini (${model})`);
    } catch (err) {
      lastError = err;
      const classified = classifyGeminiHttpError(err);
      console.warn(
        `[Ekagra AI] attempt ${i + 1}/${attempts.length} (${model}) failed with HTTP ${classified.status}`
      );
      if (!classified.retryable || i === attempts.length - 1) {
        throw err;
      }
    }
  }
  throw lastError;
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    const searchCfg = getSearchApiConfig();
    res.json({
      ok: true,
      geminiConfigured: Boolean(getGeminiClient()),
      openaiConfigured: getOpenAIConfig().configured,
      searchConfigured: Boolean(
        searchCfg.tavilyKey || searchCfg.braveKey || searchCfg.youtubeKey
      ),
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
      const response = await generateWithTransientRetry((modelName) =>
        ai.models.generateContent({
          model: modelName,
          contents: { parts },
          config: {
            ...(modelName === 'gemini-4-hydrogen'
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
            systemInstruction: [
              'You are a strict timetable and dated study schedule validation & extraction engine for Ekagra.',
              'Your task is to classify PDF documents and ONLY emit schedule entries when explicit calendar dates, explicit study times, and genuine study topics are present.',
              '',
              'STRICT VALIDATION & REJECTION RULES:',
              '1. NEVER guess or invent missing calendar dates, start times, end times, or study topics.',
              '2. NEVER classify a document as a schedule just because its filename contains words like "schedule", "roadmap", or "timetable".',
              '3. NEVER treat programming notes, textbooks, e-books, assignments, question papers, server logs, or code timestamps (e.g. "12:30:45", "2026-11-20T09:15:00Z INFO", "System.out.println") as schedule items.',
              '4. Topic-only roadmaps like "Week 1: Java Basics" or "March: Spring Boot" without explicit calendar dates AND explicit study times belong ONLY in monthlyGoals (or empty dailyPlans/weeklyPlans), NEVER in dailyPlans.',
              '5. DAILY PLANS ("dailyPlans"):',
              '   - Emit ONLY entries that have ALL THREE explicitly in the document: an explicit calendar date (YYYY-MM-DD), an explicit startTime (HH:mm), an explicit endTime (HH:mm) or explicit duration, and a clear study topic/activity.',
              '   - If a document has dates without times, or times/weekdays without dates, DO NOT invent values and DO NOT emit them into dailyPlans.',
              '6. WEEKLY PLANS ("weeklyPlans"):',
              '   - Only set startDate / endDate (YYYY-MM-DD) when the PDF explicitly states that calendar date range; otherwise leave null.',
              '   - Preserve exact column-to-weekday alignment and convert daytime wrap-around (e.g. 12:45-1:15 -> 12:45-13:15).',
              '7. BREAK PERIODS ("breakPeriods"):',
              '   - Any "Break", "Lunch", "Tea break", "Recess", or "Rest" slot belongs in "breakPeriods", NEVER in "dailyPlans" or "weeklyPlans".',
              '8. SCANNED / UNREADABLE PDFs:',
              '   - If text or page snapshots are blurry, illegible, or lack readable dates/times/topics, return empty dailyPlans/weeklyPlans and explain why in "warnings".',
              '9. PROVENANCE & VALIDATION ("warnings"):',
              '   - Mark provenance strictly as "explicit" only when directly stated.',
              '   - Add a clear warning whenever dates, times, or readability are missing or uncertain.',
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
        })
      );

      const rawJson = (response.text ?? '{}').trim();
      const parsed = parseGeminiJsonObject(rawJson);

      const validated = validateAndAuditStructuredPlan(parsed, {
        fileName,
        documentHash,
        analysisSource: pageImages.length > 0 ? 'gemini-multimodal' : 'gemini',
        cached: false,
      });

      setCachedPlan(cacheKey, validated);
      res.json(validated);
    } catch (err) {
      const classified = classifyGeminiHttpError(err);
      res.status(classified.status).json({ error: classified.message });
    }
  });

  app.post('/api/eku/chat', async (req: Request, res: Response) => {
    const auth = await verifyEkuRequestAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const parsedReq = sanitizeEkuRequestBody(req.body);
    if (!parsedReq.valid || !parsedReq.data) {
      res.status(400).json({ error: parsedReq.error ?? 'Invalid request payload.' });
      return;
    }

    try {
      const result = await runEkuConversationTurn(parsedReq.data);
      res.json(result);
    } catch (err) {
      const errObj = err as Error & { status?: number };
      const status =
        typeof errObj?.status === 'number' && errObj.status >= 400 && errObj.status < 600
          ? errObj.status
          : 502;
      const message =
        err instanceof Error && err.message.trim()
          ? err.message
          : 'Eku could not reach the AI service right now. Please try again.';
      res.status(status).json({ error: message });
    }
  });

  // ============================================================================
  // EKAGRA Smart Digital Library API (Strictly owner-scoped & path-confined)
  // ============================================================================

  app.get('/api/library/resources', async (req: Request, res: Response) => {
    const auth = await verifyLibraryAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    try {
      const resources = await listLibraryResources(auth.scopeId);
      res.json({ resources });
    } catch {
      res.status(500).json({ error: 'Unable to load your library right now.' });
    }
  });

  app.post('/api/library/resources', async (req: Request, res: Response) => {
    const auth = await verifyLibraryAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const body = (req.body ?? {}) as Partial<CreateLibraryResourcePayload>;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: 'Invalid library resource payload.' });
      return;
    }
    try {
      const created = await createLibraryResource(auth.scopeId, {
        title: typeof body.title === 'string' ? body.title : 'Untitled Resource',
        subtitle: typeof body.subtitle === 'string' ? body.subtitle : '',
        subject: typeof body.subject === 'string' ? body.subject : 'General Studies',
        description: typeof body.description === 'string' ? body.description : '',
        resourceType: body.resourceType === 'external_url' ? 'external_url' : 'pdf',
        originalFileName: body.originalFileName ?? null,
        originalFileSize: body.originalFileSize ?? null,
        originalUrl: body.originalUrl ?? null,
        coverTemplate: (body.coverTemplate as LibraryCoverTemplateId) ?? 'charcoal_tech',
        totalPages: typeof body.totalPages === 'number' ? body.totalPages : null,
        topics: Array.isArray(body.topics) ? body.topics : [],
        lastReadPage: typeof body.lastReadPage === 'number' ? body.lastReadPage : undefined,
        analysisStatus: body.analysisStatus ?? 'complete',
        analysisNote: body.analysisNote ?? null,
      });
      res.status(201).json({ resource: created });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save library resource.';
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/library/resources/:id', async (req: Request, res: Response) => {
    const auth = await verifyLibraryAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    try {
      const resource = await getLibraryResourceById(auth.scopeId, String(req.params.id || ''));
      if (!resource) {
        res.status(404).json({ error: 'Resource not found.' });
        return;
      }
      res.json({ resource });
    } catch {
      res.status(500).json({ error: 'Unable to load resource details.' });
    }
  });

  app.patch('/api/library/resources/:id', async (req: Request, res: Response) => {
    const auth = await verifyLibraryAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const patch = (req.body ?? {}) as UpdateLibraryResourcePayload;
    try {
      const updated = await updateLibraryResource(
        auth.scopeId,
        String(req.params.id || ''),
        patch
      );
      if (!updated) {
        res.status(404).json({ error: 'Resource not found.' });
        return;
      }
      res.json({ resource: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to update resource.';
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/library/resources/:id', async (req: Request, res: Response) => {
    const auth = await verifyLibraryAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    try {
      const deleted = await deleteLibraryResource(auth.scopeId, String(req.params.id || ''));
      if (!deleted) {
        res.status(404).json({ error: 'Resource not found.' });
        return;
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Unable to delete resource.' });
    }
  });

  app.post(
    '/api/library/resources/:id/file',
    express.raw({
      type: ['application/pdf', 'application/octet-stream'],
      limit: MAX_LIBRARY_PDF_BYTES,
    }),
    async (req: Request, res: Response) => {
      const auth = await verifyLibraryAuth(req);
      if (!auth.authenticated) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'No PDF binary payload was uploaded.' });
        return;
      }
      const rawNameHeader = req.headers['x-file-name'];
      const decodedName =
        typeof rawNameHeader === 'string'
          ? (() => {
              try {
                return decodeURIComponent(rawNameHeader);
              } catch {
                return rawNameHeader;
              }
            })()
          : undefined;
      try {
        const updated = await saveLibraryPdfFile(
          auth.scopeId,
          String(req.params.id || ''),
          req.body,
          decodedName
        );
        if (!updated) {
          res.status(404).json({ error: 'Resource record not found.' });
          return;
        }
        res.json({ resource: updated });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid PDF file upload.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.get('/api/library/resources/:id/file', async (req: Request, res: Response) => {
    const auth = await verifyLibraryAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    await serveLibraryPdfFile(req, res, auth.scopeId, String(req.params.id || ''));
  });

  app.post(
    '/api/library/resources/:id/cover',
    express.raw({
      type: ['image/png', 'application/octet-stream'],
      limit: MAX_LIBRARY_COVER_BYTES,
    }),
    async (req: Request, res: Response) => {
      const auth = await verifyLibraryAuth(req);
      if (!auth.authenticated) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'No PNG cover image payload was uploaded.' });
        return;
      }
      try {
        const updated = await saveLibraryCoverFile(
          auth.scopeId,
          String(req.params.id || ''),
          req.body
        );
        if (!updated) {
          res.status(404).json({ error: 'Resource record not found.' });
          return;
        }
        res.json({ resource: updated });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid cover image upload.';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.get('/api/library/resources/:id/cover', async (req: Request, res: Response) => {
    const auth = await verifyLibraryAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    await serveLibraryCoverFile(req, res, auth.scopeId, String(req.params.id || ''));
  });

  app.post('/api/library/import-url', async (req: Request, res: Response) => {
    const auth = await verifyLibraryAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!rawUrl) {
      res.status(400).json({ error: 'Please enter a resource URL.' });
      return;
    }
    try {
      const inspected = await inspectAndImportLibraryUrl(rawUrl);
      if (inspected.kind === 'pdf_buffer') {
        const cleanTitle =
          sanitizeTextField(inspected.fileName.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' '), 160) ||
          'Imported PDF';
        const created = await createLibraryResource(auth.scopeId, {
          title: cleanTitle,
          subtitle: '',
          subject: 'General Studies',
          description: `PDF imported from ${new URL(inspected.safeUrl).hostname}.`,
          resourceType: 'pdf',
          originalFileName: inspected.fileName,
          originalFileSize: inspected.buffer.length,
          originalUrl: inspected.safeUrl,
          coverTemplate: 'charcoal_tech',
          totalPages: null,
          topics: [],
          lastReadPage: 1,
          analysisStatus: 'complete',
          analysisNote: null,
        });
        const saved = await saveLibraryPdfFile(
          auth.scopeId,
          created.id,
          inspected.buffer,
          inspected.fileName
        );
        res.status(201).json({
          kind: 'pdf_imported',
          safeUrl: inspected.safeUrl,
          suggestedTitle: cleanTitle,
          suggestedDescription: created.description,
          note: 'PDF downloaded and saved to your library.',
          resource: saved ?? created,
        });
        return;
      }

      res.json(inspected);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to inspect URL.';
      res.status(400).json({ error: msg });
    }
  });

  // Guarantee unmatched /api/* endpoints return JSON rather than SPA index.html
  app.use('/api', (req: Request, res: Response) => {
    res.status(404).json({
      error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
    });
  });

  // Guarantee Express body-parser / API errors return JSON rather than HTML pages
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api')) {
      next(err);
      return;
    }
    const rawStatus =
      (err as { status?: unknown; statusCode?: unknown })?.status ??
      (err as { statusCode?: unknown })?.statusCode;
    const status = typeof rawStatus === 'number' ? rawStatus : 500;
    if (status === 413) {
      res.status(413).json({
        error: 'Request payload is too large. Please retry with a shorter history.',
      });
      return;
    }
    if (status === 400) {
      res.status(400).json({
        error: 'Invalid JSON request payload sent to the API.',
      });
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: 'API service encountered an unexpected server error. Please retry.',
    });
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
    console.log(`Ekagra server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Ekagra server:', err);
  process.exit(1);
});
