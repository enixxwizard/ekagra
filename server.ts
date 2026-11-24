import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDocumentHash, sanitizeIsoDate } from './src/utils/pdfSchemaValidator';
import type { ExtractedPdfTable } from './src/types/pdfSchedule';
import {
  analyzeSchedulePdfWithBrain,
  checkAiRateLimit,
  classifyGeminiHttpError,
  enhanceScheduleWithBrain,
  getAiBrainStatus,
  verifyGeminiModelConnection,
} from './server/aiBrain';

dotenv.config();
const localEnvPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath, override: false });
}
import { verifyEkuRequestAuth } from './server/ekuAuth';
import { getSearchApiConfig } from './server/ekuSearch';
import {
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

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '8mb' }));

  app.get('/api/health', async (req: Request, res: Response) => {
    const searchCfg = getSearchApiConfig();
    const aiBrain = getAiBrainStatus();
    const shouldVerify = req.query.verify === '1' || req.query.verify === 'true';
    const verification = shouldVerify ? await verifyGeminiModelConnection() : undefined;
    res.json({
      ok: true,
      geminiConfigured: aiBrain.geminiConfigured,
      aiBrain,
      ...(verification ? { geminiVerification: verification } : {}),
      searchConfigured: Boolean(
        searchCfg.tavilyKey ||
          searchCfg.braveKey ||
          searchCfg.youtubeKey ||
          searchCfg.geminiSearchAvailable
      ),
    });
  });

  app.post('/api/pdf/analyze', async (req: Request, res: Response) => {
    const auth = await verifyEkuRequestAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const rate = checkAiRateLimit(auth.scopeId, req.ip, 'pdf', 15, 60_000);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      res.status(429).json({
        error: `Too many PDF analysis requests. Please wait ${rate.retryAfterSeconds}s and retry.`,
      });
      return;
    }

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

    try {
      const validated = await analyzeSchedulePdfWithBrain({
        fileName,
        documentHash,
        referenceDate,
        pages,
        pageImages,
      });
      res.json(validated);
    } catch (err) {
      const existingStatus = (err as { status?: number })?.status;
      if (typeof existingStatus === 'number' && existingStatus >= 400 && existingStatus < 600) {
        res.status(existingStatus).json({
          error: err instanceof Error ? err.message : 'Unable to analyze schedule PDF.',
        });
        return;
      }
      const classified = classifyGeminiHttpError(err);
      res.status(classified.status).json({ error: classified.message });
    }
  });

  app.post('/api/ai/enhance', async (req: Request, res: Response) => {
    const auth = await verifyEkuRequestAuth(req);
    if (!auth.authenticated) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const rate = checkAiRateLimit(auth.scopeId, req.ip, 'enhance', 20, 60_000);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      res.status(429).json({
        error: `Rate limit reached for schedule optimization. Please wait ${rate.retryAfterSeconds}s and retry.`,
      });
      return;
    }

    const rawSnapshot =
      req.body && typeof req.body === 'object' && 'snapshot' in req.body
        ? (req.body as { snapshot?: unknown }).snapshot
        : req.body;

    const parsedReq = sanitizeEkuRequestBody({
      message: 'enhance-schedule',
      history: [],
      snapshot: rawSnapshot,
    });
    if (!parsedReq.valid || !parsedReq.data) {
      res.status(400).json({ error: parsedReq.error ?? 'Invalid schedule snapshot payload.' });
      return;
    }

    const forceRefresh =
      Boolean(req.body && typeof req.body === 'object' && (req.body as { forceRefresh?: unknown }).forceRefresh === true);

    try {
      const result = await enhanceScheduleWithBrain(parsedReq.data.snapshot, forceRefresh);
      res.json(result);
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

    const rate = checkAiRateLimit(auth.scopeId, req.ip, 'eku', 24, 60_000);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      res.status(429).json({
        error: `Eku is taking a short breather. Please wait ${rate.retryAfterSeconds}s and retry.`,
      });
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
        server: {
          middlewareMode: true,
          hmr: false,
          ws: false,
          watch: null,
        },
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
