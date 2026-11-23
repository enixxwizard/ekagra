import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Request, Response } from 'express';
import { verifyEkuRequestAuth, type EkuAuthIdentity } from './ekuAuth';
import type {
  CreateLibraryResourcePayload,
  InspectUrlResult,
  LibraryCoverTemplateId,
  LibraryResource,
  LibraryTopic,
  LibraryTopicVerification,
  UpdateLibraryResourcePayload,
} from '../src/types/library';

export const MAX_LIBRARY_PDF_BYTES = 35 * 1024 * 1024; // 35 MB
export const MAX_LIBRARY_COVER_BYTES = 3 * 1024 * 1024; // 3 MB

const LIBRARY_ROOT_DIR = path.resolve(process.cwd(), 'data', 'library', 'users');
const VALID_RESOURCE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const VALID_SCOPE_ID_RE = /^[a-zA-Z0-9_-]{1,96}$/;
const VALID_TEMPLATES = new Set<LibraryCoverTemplateId>([
  'charcoal_tech',
  'cobalt_math',
  'editorial_humanities',
  'botanical_bio',
  'obsidian_physics',
  'terracotta_exam',
]);
const VALID_VERIFICATIONS = new Set<LibraryTopicVerification>([
  'verified_outline',
  'detected_heading',
  'ocr_detected',
  'manual',
  'unverified',
]);

const scopeLocks = new Map<string, Promise<unknown>>();

function runSerializedForScope<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = scopeLocks.get(scopeId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  scopeLocks.set(
    scopeId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

function resolveConfinedPath(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Path escapes confined storage root');
  }
  return resolvedTarget;
}

function sanitizeScopeId(rawScope: string): string {
  const cleaned = rawScope.trim();
  if (!VALID_SCOPE_ID_RE.test(cleaned)) {
    throw new Error('Invalid user storage scope');
  }
  return cleaned;
}

export function isValidResourceId(id: string): boolean {
  return VALID_RESOURCE_ID_RE.test(id);
}

function getUserDirs(scopeId: string) {
  const safeScope = sanitizeScopeId(scopeId);
  const userDir = resolveConfinedPath(LIBRARY_ROOT_DIR, safeScope);
  const filesDir = resolveConfinedPath(userDir, 'files');
  const coversDir = resolveConfinedPath(userDir, 'covers');
  const indexPath = resolveConfinedPath(userDir, 'index.json');
  return { userDir, filesDir, coversDir, indexPath };
}

async function ensureUserDirs(scopeId: string) {
  const dirs = getUserDirs(scopeId);
  await fsp.mkdir(dirs.filesDir, { recursive: true });
  await fsp.mkdir(dirs.coversDir, { recursive: true });
  return dirs;
}

async function readUserIndex(scopeId: string): Promise<LibraryResource[]> {
  const { indexPath } = await ensureUserDirs(scopeId);
  try {
    const raw = await fsp.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LibraryResource[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

async function writeUserIndexAtomic(scopeId: string, items: LibraryResource[]): Promise<void> {
  const { indexPath, userDir } = await ensureUserDirs(scopeId);
  const tmpName = `index.${crypto.randomUUID()}.tmp`;
  const tmpPath = resolveConfinedPath(userDir, tmpName);
  await fsp.writeFile(tmpPath, JSON.stringify(items, null, 2), 'utf8');
  await fsp.rename(tmpPath, indexPath);
}

export async function verifyLibraryAuth(
  req: Request
): Promise<EkuAuthIdentity | { authenticated: false; status: number; error: string }> {
  const auth = await verifyEkuRequestAuth(req);
  if (!auth.authenticated) {
    return {
      authenticated: false,
      status: auth.status,
      error:
        auth.status === 401
          ? 'Sign in or use Guest mode to access your personal library.'
          : auth.error,
    };
  }
  return auth;
}

export function sanitizeTextField(val: unknown, maxLen: number, fallback = ''): string {
  if (typeof val !== 'string') return fallback;
  return val.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}

export function sanitizeSafeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function sanitizeDownloadFilename(name: string, ext: string): string {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9 _.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'ekagra-resource'}${ext}`;
}

export function sanitizeTopics(rawTopics: unknown, totalPages: number | null): LibraryTopic[] {
  if (!Array.isArray(rawTopics)) return [];
  const result: LibraryTopic[] = [];
  const maxPage = typeof totalPages === 'number' && totalPages >= 1 ? totalPages : null;

  for (const item of rawTopics.slice(0, 300)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = sanitizeTextField(obj.title, 200);
    if (!title) continue;

    let startPage: number | null = null;
    let endPage: number | null = null;

    if (typeof obj.startPage === 'number' && Number.isFinite(obj.startPage) && obj.startPage >= 1) {
      const floored = Math.floor(obj.startPage);
      startPage = maxPage ? Math.min(floored, maxPage) : floored;
    }
    if (typeof obj.endPage === 'number' && Number.isFinite(obj.endPage) && obj.endPage >= 1) {
      const floored = Math.floor(obj.endPage);
      endPage = maxPage ? Math.min(floored, maxPage) : floored;
    }
    if (startPage !== null && endPage !== null && endPage < startPage) {
      endPage = startPage;
    }
    if (startPage === null && endPage !== null) {
      endPage = null;
    }

    const verificationStatus: LibraryTopicVerification =
      typeof obj.verificationStatus === 'string' &&
      VALID_VERIFICATIONS.has(obj.verificationStatus as LibraryTopicVerification)
        ? (obj.verificationStatus as LibraryTopicVerification)
        : startPage !== null
        ? 'manual'
        : 'unverified';

    const rawId = sanitizeTextField(obj.id, 64);
    const id = rawId && VALID_RESOURCE_ID_RE.test(rawId) ? rawId : `top_${crypto.randomUUID().slice(0, 12)}`;
    const description = sanitizeTextField(obj.description, 400);

    result.push({
      id,
      title,
      startPage,
      endPage,
      ...(description ? { description } : {}),
      verificationStatus,
    });
  }

  return result;
}

export function hasPdfMagicBytes(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 5) return false;
  const headerSlice = buffer.subarray(0, Math.min(buffer.length, 1024));
  return headerSlice.indexOf(Buffer.from('%PDF-')) !== -1;
}

export function hasPngMagicBytes(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 8) return false;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buffer.subarray(0, 8).equals(sig);
}

export async function listLibraryResources(scopeId: string): Promise<LibraryResource[]> {
  const items = await readUserIndex(scopeId);
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getLibraryResourceById(
  scopeId: string,
  resourceId: string
): Promise<LibraryResource | null> {
  if (!isValidResourceId(resourceId)) return null;
  const items = await readUserIndex(scopeId);
  return items.find((item) => item.id === resourceId) ?? null;
}

export async function createLibraryResource(
  scopeId: string,
  payload: CreateLibraryResourcePayload
): Promise<LibraryResource> {
  return runSerializedForScope(scopeId, async () => {
    const items = await readUserIndex(scopeId);
    const now = new Date().toISOString();
    const id = `lib_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

    const resourceType = payload.resourceType === 'external_url' ? 'external_url' : 'pdf';
    const totalPages =
      resourceType === 'pdf' &&
      typeof payload.totalPages === 'number' &&
      Number.isFinite(payload.totalPages) &&
      payload.totalPages >= 1
        ? Math.floor(payload.totalPages)
        : null;

    const coverTemplate: LibraryCoverTemplateId = VALID_TEMPLATES.has(payload.coverTemplate)
      ? payload.coverTemplate
      : 'charcoal_tech';

    const safeUrl = sanitizeSafeHttpUrl(payload.originalUrl);
    if (resourceType === 'external_url' && !safeUrl) {
      throw new Error('A valid http:// or https:// resource URL is required.');
    }

    const lastReadRaw =
      typeof payload.lastReadPage === 'number' && Number.isFinite(payload.lastReadPage)
        ? Math.floor(payload.lastReadPage)
        : resourceType === 'pdf'
        ? 1
        : 0;
    const lastReadPage =
      resourceType === 'pdf'
        ? Math.max(1, totalPages ? Math.min(lastReadRaw, totalPages) : lastReadRaw)
        : 0;

    const created: LibraryResource = {
      id,
      userId: scopeId,
      title: sanitizeTextField(payload.title, 180) || 'Untitled Resource',
      subtitle: sanitizeTextField(payload.subtitle, 180),
      subject: sanitizeTextField(payload.subject, 80) || 'General Studies',
      description: sanitizeTextField(payload.description, 1000),
      resourceType,
      originalFileReference: resourceType === 'pdf' ? `/api/library/resources/${id}/file` : null,
      originalFileName: sanitizeTextField(payload.originalFileName, 180) || null,
      originalFileSize:
        typeof payload.originalFileSize === 'number' && payload.originalFileSize > 0
          ? Math.floor(payload.originalFileSize)
          : null,
      originalUrl: safeUrl,
      generatedCoverReference: null,
      coverTemplate,
      totalPages,
      topics: sanitizeTopics(payload.topics, totalPages),
      lastReadPage,
      analysisStatus:
        payload.analysisStatus === 'scanned_needs_ocr' ||
        payload.analysisStatus === 'ocr_partial' ||
        payload.analysisStatus === 'external_link' ||
        payload.analysisStatus === 'error'
          ? payload.analysisStatus
          : resourceType === 'external_url'
          ? 'external_link'
          : 'complete',
      analysisNote: sanitizeTextField(payload.analysisNote, 400) || null,
      createdAt: now,
      updatedAt: now,
    };

    items.unshift(created);
    await writeUserIndexAtomic(scopeId, items);
    return created;
  });
}

export async function updateLibraryResource(
  scopeId: string,
  resourceId: string,
  patch: UpdateLibraryResourcePayload
): Promise<LibraryResource | null> {
  if (!isValidResourceId(resourceId)) return null;

  return runSerializedForScope(scopeId, async () => {
    const items = await readUserIndex(scopeId);
    const idx = items.findIndex((item) => item.id === resourceId);
    if (idx === -1) return null;

    const current = items[idx];
    const nextTotalPages =
      patch.totalPages !== undefined
        ? typeof patch.totalPages === 'number' &&
          Number.isFinite(patch.totalPages) &&
          patch.totalPages >= 1
          ? Math.floor(patch.totalPages)
          : null
        : current.totalPages;

    const nextTitle =
      patch.title !== undefined
        ? sanitizeTextField(patch.title, 180) || current.title
        : current.title;
    const nextSubtitle =
      patch.subtitle !== undefined
        ? sanitizeTextField(patch.subtitle, 180)
        : current.subtitle;
    const nextSubject =
      patch.subject !== undefined
        ? sanitizeTextField(patch.subject, 80) || current.subject
        : current.subject;
    const nextDescription =
      patch.description !== undefined
        ? sanitizeTextField(patch.description, 1000)
        : current.description;
    const nextCoverTemplate =
      patch.coverTemplate && VALID_TEMPLATES.has(patch.coverTemplate)
        ? patch.coverTemplate
        : current.coverTemplate;

    let nextLastReadPage = current.lastReadPage;
    if (typeof patch.lastReadPage === 'number' && Number.isFinite(patch.lastReadPage)) {
      const clamped = Math.max(1, Math.floor(patch.lastReadPage));
      nextLastReadPage =
        nextTotalPages && nextTotalPages >= 1 ? Math.min(clamped, nextTotalPages) : clamped;
    }

    const nextTopics =
      patch.topics !== undefined ? sanitizeTopics(patch.topics, nextTotalPages) : current.topics;

    const nextUrl =
      patch.originalUrl !== undefined ? sanitizeSafeHttpUrl(patch.originalUrl) : current.originalUrl;

    const updated: LibraryResource = {
      ...current,
      title: nextTitle,
      subtitle: nextSubtitle,
      subject: nextSubject,
      description: nextDescription,
      originalUrl: nextUrl,
      coverTemplate: nextCoverTemplate,
      totalPages: nextTotalPages,
      topics: nextTopics,
      lastReadPage: current.resourceType === 'pdf' ? nextLastReadPage : 0,
      analysisStatus: patch.analysisStatus ?? current.analysisStatus,
      analysisNote:
        patch.analysisNote !== undefined
          ? sanitizeTextField(patch.analysisNote, 400) || null
          : current.analysisNote,
      updatedAt: new Date().toISOString(),
    };

    items[idx] = updated;
    await writeUserIndexAtomic(scopeId, items);
    return updated;
  });
}

export async function saveLibraryPdfFile(
  scopeId: string,
  resourceId: string,
  pdfBuffer: Buffer,
  fileName?: string
): Promise<LibraryResource | null> {
  if (!isValidResourceId(resourceId)) return null;
  if (!hasPdfMagicBytes(pdfBuffer)) {
    throw new Error('Uploaded file is not a valid PDF document (%PDF- header missing).');
  }
  if (pdfBuffer.length > MAX_LIBRARY_PDF_BYTES) {
    throw new Error('PDF exceeds the 35 MB library limit.');
  }

  const dirs = await ensureUserDirs(scopeId);
  const filePath = resolveConfinedPath(dirs.filesDir, `${resourceId}.pdf`);

  return runSerializedForScope(scopeId, async () => {
    const items = await readUserIndex(scopeId);
    const idx = items.findIndex((item) => item.id === resourceId);
    if (idx === -1) return null;

    // Persist exact unmodified original PDF bytes via atomic temp write + rename
    const tmpFile = resolveConfinedPath(dirs.filesDir, `${resourceId}.${crypto.randomUUID()}.tmp`);
    await fsp.writeFile(tmpFile, pdfBuffer);
    await fsp.rename(tmpFile, filePath);

    const current = items[idx];
    const updated: LibraryResource = {
      ...current,
      originalFileReference: `/api/library/resources/${resourceId}/file`,
      originalFileName: fileName ? sanitizeTextField(fileName, 180) : current.originalFileName,
      originalFileSize: pdfBuffer.length,
      updatedAt: new Date().toISOString(),
    };
    items[idx] = updated;
    await writeUserIndexAtomic(scopeId, items);
    return updated;
  });
}

export async function saveLibraryCoverFile(
  scopeId: string,
  resourceId: string,
  pngBuffer: Buffer
): Promise<LibraryResource | null> {
  if (!isValidResourceId(resourceId)) return null;
  if (!hasPngMagicBytes(pngBuffer)) {
    throw new Error('Cover image must be a valid PNG file.');
  }
  if (pngBuffer.length > MAX_LIBRARY_COVER_BYTES) {
    throw new Error('Cover image exceeds the 3 MB limit.');
  }

  const dirs = await ensureUserDirs(scopeId);
  const coverPath = resolveConfinedPath(dirs.coversDir, `${resourceId}.png`);

  return runSerializedForScope(scopeId, async () => {
    const items = await readUserIndex(scopeId);
    const idx = items.findIndex((item) => item.id === resourceId);
    if (idx === -1) return null;

    const tmpCover = resolveConfinedPath(dirs.coversDir, `${resourceId}.${crypto.randomUUID()}.tmp`);
    await fsp.writeFile(tmpCover, pngBuffer);
    await fsp.rename(tmpCover, coverPath);

    const versionTag = Date.now();
    const updated: LibraryResource = {
      ...items[idx],
      generatedCoverReference: `/api/library/resources/${resourceId}/cover?v=${versionTag}`,
      updatedAt: new Date().toISOString(),
    };
    items[idx] = updated;
    await writeUserIndexAtomic(scopeId, items);
    return updated;
  });
}

export async function deleteLibraryResource(
  scopeId: string,
  resourceId: string
): Promise<boolean> {
  if (!isValidResourceId(resourceId)) return false;

  return runSerializedForScope(scopeId, async () => {
    const items = await readUserIndex(scopeId);
    const idx = items.findIndex((item) => item.id === resourceId);
    if (idx === -1) return false;

    const target = items[idx];
    items.splice(idx, 1);
    await writeUserIndexAtomic(scopeId, items);

    const dirs = getUserDirs(scopeId);
    const filePath = resolveConfinedPath(dirs.filesDir, `${target.id}.pdf`);
    const coverPath = resolveConfinedPath(dirs.coversDir, `${target.id}.png`);
    await fsp.unlink(filePath).catch(() => undefined);
    await fsp.unlink(coverPath).catch(() => undefined);
    return true;
  });
}

export async function serveLibraryPdfFile(
  req: Request,
  res: Response,
  scopeId: string,
  resourceId: string
): Promise<void> {
  if (!isValidResourceId(resourceId)) {
    res.status(400).json({ error: 'Invalid resource ID.' });
    return;
  }

  const resource = await getLibraryResourceById(scopeId, resourceId);
  if (!resource || resource.resourceType !== 'pdf') {
    res.status(404).json({ error: 'PDF resource not found.' });
    return;
  }

  const dirs = getUserDirs(scopeId);
  const filePath = resolveConfinedPath(dirs.filesDir, `${resourceId}.pdf`);

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.status(404).json({ error: 'Original PDF file could not be found on disk.' });
    return;
  }

  const totalSize = stat.size;
  const isDownload = req.query.download === '1' || req.query.download === 'true';
  const downloadName = sanitizeDownloadFilename(
    resource.originalFileName || resource.title,
    '.pdf'
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader(
    'Content-Disposition',
    `${isDownload ? 'attachment' : 'inline'}; filename="${downloadName}"`
  );

  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
    const [rawStart, rawEnd] = rangeHeader.replace(/^bytes=/, '').split('-');
    const start = rawStart ? Number.parseInt(rawStart, 10) : 0;
    const end = rawEnd ? Number.parseInt(rawEnd, 10) : totalSize - 1;

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end >= totalSize ||
      start > end
    ) {
      res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
      return;
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', String(end - start + 1));

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(totalSize));
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
  });
  stream.pipe(res);
}

export async function serveLibraryCoverFile(
  req: Request,
  res: Response,
  scopeId: string,
  resourceId: string
): Promise<void> {
  if (!isValidResourceId(resourceId)) {
    res.status(400).json({ error: 'Invalid resource ID.' });
    return;
  }

  const resource = await getLibraryResourceById(scopeId, resourceId);
  if (!resource) {
    res.status(404).json({ error: 'Resource not found.' });
    return;
  }

  const dirs = getUserDirs(scopeId);
  const coverPath = resolveConfinedPath(dirs.coversDir, `${resourceId}.png`);
  try {
    const stat = await fsp.stat(coverPath);
    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const fileName = sanitizeDownloadFilename(`${resource.title}-cover`, '.png');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    }
    fs.createReadStream(coverPath).pipe(res);
  } catch {
    res.status(404).json({ error: 'Cover image has not been generated yet.' });
  }
}

// ============================================================================
// SSRF-Safe External URL Inspection & Optional Public PDF Import
// ============================================================================

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    const mappedV4 = normalized.slice(7);
    if (net.isIPv4(mappedV4)) {
      return isBlockedIPv4(mappedV4);
    }
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/i.test(normalized) || normalized.startsWith('fe80:')) return true; // fe80::/10
  if (normalized.startsWith('ff')) return true; // multicast
  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIPv4(ip);
  if (kind === 6) return isBlockedIPv6(ip);
  return true;
}

async function validatePublicUrlTarget(rawUrl: string): Promise<URL> {
  const safe = sanitizeSafeHttpUrl(rawUrl);
  if (!safe) {
    throw new Error('Please provide a valid public http:// or https:// URL.');
  }
  const parsed = new URL(safe);
  const host = parsed.hostname.toLowerCase();

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Local or internal network URLs are not allowed.');
  }

  if (net.isIP(host)) {
    if (isBlockedIpAddress(host)) {
      throw new Error('Private or loopback IP addresses are not allowed.');
    }
    return parsed;
  }

  const resolved = await dns.lookup(host, { all: true, verbatim: true });
  if (!resolved || resolved.length === 0) {
    throw new Error('Could not resolve that hostname.');
  }
  for (const addr of resolved) {
    if (isBlockedIpAddress(addr.address)) {
      throw new Error('URL resolves to a restricted network address.');
    }
  }

  return parsed;
}

function deriveTitleFromUrl(targetUrl: URL): string {
  const segments = targetUrl.pathname
    .split('/')
    .map((s) => decodeURIComponent(s).trim())
    .filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (last && last.toLowerCase() !== 'index.html') {
    return last
      .replace(/\.pdf$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }
  return targetUrl.hostname.replace(/^www\./, '');
}

async function readResponseBytesWithLimit(
  response: globalThis.Response,
  maxBytes: number
): Promise<Buffer> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error('Remote file exceeds the maximum allowed library size.');
    }
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Remote file exceeds the maximum allowed library size.');
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
}

function extractHtmlTitleAndDescription(html: string): { title: string; description: string } {
  const titleMatch = /<title[^>]*>([\s\S]{1,220}?)<\/title>/i.exec(html);
  const metaDescMatch =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,360})["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']{1,360})["'][^>]+name=["']description["']/i.exec(html);

  const decodeBasic = (str: string) =>
    str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

  return {
    title: titleMatch ? decodeBasic(titleMatch[1]).slice(0, 160) : '',
    description: metaDescMatch ? decodeBasic(metaDescMatch[1]).slice(0, 360) : '',
  };
}

export async function inspectAndImportLibraryUrl(
  rawUrl: string
): Promise<
  | { kind: 'pdf_buffer'; safeUrl: string; fileName: string; buffer: Buffer }
  | InspectUrlResult
> {
  let currentUrl = await validatePublicUrlTarget(rawUrl);
  let response: globalThis.Response | null = null;

  for (let hop = 0; hop <= 3; hop++) {
    try {
      const candidate = await fetch(currentUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
        headers: {
          'User-Agent': 'EkagraLibraryFetcher/1.0 (+https://ekagra.app)',
          Accept: 'application/pdf,text/html,application/xhtml+xml,*/*;q=0.8',
        },
      });

      if (candidate.status >= 300 && candidate.status < 400) {
        const location = candidate.headers.get('location');
        await candidate.body?.cancel().catch(() => undefined);
        if (!location || hop === 3) {
          return {
            kind: 'external_url',
            safeUrl: currentUrl.toString(),
            suggestedTitle: deriveTitleFromUrl(currentUrl),
            suggestedDescription: `Saved web resource from ${currentUrl.hostname}.`,
            note: 'Link saved as an external study resource. Click to open the original site.',
          };
        }
        const resolvedRedirect = new URL(location, currentUrl).toString();
        currentUrl = await validatePublicUrlTarget(resolvedRedirect);
        continue;
      }

      response = candidate;
      break;
    } catch {
      return {
        kind: 'external_url',
        safeUrl: currentUrl.toString(),
        suggestedTitle: deriveTitleFromUrl(currentUrl),
        suggestedDescription: `Saved web resource from ${currentUrl.hostname}.`,
        note: 'Could not download directly; saved safely as an external link that opens the original page.',
      };
    }
  }

  if (!response) {
    return {
      kind: 'external_url',
      safeUrl: currentUrl.toString(),
      suggestedTitle: deriveTitleFromUrl(currentUrl),
      suggestedDescription: `Saved web resource from ${currentUrl.hostname}.`,
      note: 'Saved as an external study resource.',
    };
  }

  // Respect auth/paywall/restriction HTTP codes strictly — never bypass
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const restrictedNote =
      response.status === 401 || response.status === 403
        ? 'This site requires authentication or restricts direct downloads. Saved as an external resource that opens the original site.'
        : `Server returned HTTP ${response.status}. Saved as an external resource so you can open it directly.`;
    return {
      kind: 'external_url',
      safeUrl: currentUrl.toString(),
      suggestedTitle: deriveTitleFromUrl(currentUrl),
      suggestedDescription: `External study link on ${currentUrl.hostname}.`,
      note: restrictedNote,
    };
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const looksLikePdf =
    contentType.includes('application/pdf') ||
    currentUrl.pathname.toLowerCase().endsWith('.pdf');

  if (looksLikePdf) {
    try {
      const bytes = await readResponseBytesWithLimit(response, MAX_LIBRARY_PDF_BYTES);
      if (hasPdfMagicBytes(bytes)) {
        const lastSegment = currentUrl.pathname.split('/').filter(Boolean).pop() || 'resource.pdf';
        const safeName = lastSegment.toLowerCase().endsWith('.pdf')
          ? decodeURIComponent(lastSegment)
          : `${deriveTitleFromUrl(currentUrl)}.pdf`;
        return {
          kind: 'pdf_buffer',
          safeUrl: currentUrl.toString(),
          fileName: safeName.slice(0, 160),
          buffer: bytes,
        };
      }
    } catch (err) {
      return {
        kind: 'external_url',
        safeUrl: currentUrl.toString(),
        suggestedTitle: deriveTitleFromUrl(currentUrl),
        suggestedDescription: `PDF link hosted on ${currentUrl.hostname}.`,
        note:
          err instanceof Error
            ? `${err.message} Saved as an external link instead.`
            : 'Saved as an external link.',
      };
    }
  }

  // Not a PDF — read a small HTML head snippet if HTML to infer a helpful title
  let suggestedTitle = deriveTitleFromUrl(currentUrl);
  let suggestedDescription = `Study resource hosted on ${currentUrl.hostname}.`;

  if (contentType.includes('text/html')) {
    try {
      const snippet = await readResponseBytesWithLimit(response, 180_000);
      const htmlMeta = extractHtmlTitleAndDescription(snippet.toString('utf8'));
      if (htmlMeta.title) suggestedTitle = htmlMeta.title;
      if (htmlMeta.description) suggestedDescription = htmlMeta.description;
    } catch {
      // Keep hostname fallback
    }
  } else {
    await response.body?.cancel().catch(() => undefined);
  }

  return {
    kind: 'external_url',
    safeUrl: currentUrl.toString(),
    suggestedTitle,
    suggestedDescription,
    note: 'Web page saved to your bookshelf. Opening it will launch the original site in a new tab.',
  };
}
