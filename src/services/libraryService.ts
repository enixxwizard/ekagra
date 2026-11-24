import type {
  CreateLibraryResourcePayload,
  InspectUrlResult,
  LibraryResource,
  UpdateLibraryResourcePayload,
} from '../types/library';
import { generateBookCoverPngBlob, type RenderCoverOptions } from '../utils/libraryCoverGenerator';
import {
  blobStore,
  computeStreamingFileHash,
  StorageQuotaError,
  validatePdfFileHeader,
} from './storage/blobStore';
import {
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  STORE_NAMES,
} from './storage/indexedDb';
import { publishSyncEvent } from './storage/syncChannel';

export interface LibraryAuthHeaderInput {
  accessToken?: string | null;
  isGuest?: boolean;
}

const LOCAL_COVER_PREFIX = 'local-cover://';
const LOCAL_PDF_PREFIX = 'local-pdf://';

function makeResourceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `lib_${crypto.randomUUID()}`;
  }
  return `lib_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function pdfBlobKey(resourceId: string): string {
  return `pdf_${resourceId}`;
}

export function coverBlobKey(resourceId: string): string {
  return `cover_${resourceId}`;
}

export function isSafeWebLink(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if (
      !host ||
      host === 'localhost' ||
      host.startsWith('127.') ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildLibraryAuthHeaders(auth: LibraryAuthHeaderInput): Record<string, string> {
  if (auth.accessToken && !auth.isGuest) {
    return { Authorization: `Bearer ${auth.accessToken}` };
  }
  return { 'x-ekagra-mode': 'guest' };
}

export async function listLibraryResourcesApi(
  _auth?: LibraryAuthHeaderInput
): Promise<LibraryResource[]> {
  const items = await idbGetAll<LibraryResource>(STORE_NAMES.LIBRARY_RESOURCES);
  return items
    .filter((item) => item && typeof item.id === 'string')
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
}

export async function findDuplicateLibraryResource(
  file: File | Blob
): Promise<{ duplicate: LibraryResource | null; fileHash: string }> {
  const fileHash = await computeStreamingFileHash(file);
  const items = await listLibraryResourcesApi();
  const duplicate =
    items.find(
      (item) =>
        item.resourceType === 'pdf' &&
        ((item.fileHash && item.fileHash === fileHash) ||
          (item.originalFileSize === file.size &&
            file instanceof File &&
            item.originalFileName === file.name))
    ) ?? null;
  return { duplicate, fileHash };
}

export async function createLibraryResourceApi(
  _auth: LibraryAuthHeaderInput,
  payload: CreateLibraryResourcePayload
): Promise<LibraryResource> {
  const now = new Date().toISOString();
  const id = makeResourceId();
  const record: LibraryResource = {
    id,
    userId: 'local_device',
    title: payload.title.trim().slice(0, 180) || 'Untitled Resource',
    subtitle: (payload.subtitle ?? '').trim().slice(0, 160),
    subject: payload.subject.trim().slice(0, 80) || 'General Studies',
    description: (payload.description ?? '').trim().slice(0, 1000),
    resourceType: payload.resourceType,
    originalFileReference:
      payload.resourceType === 'pdf' ? `${LOCAL_PDF_PREFIX}${id}` : null,
    originalFileName: payload.originalFileName ?? null,
    originalFileSize: payload.originalFileSize ?? null,
    fileHash: payload.fileHash ?? null,
    originalUrl: payload.originalUrl ?? null,
    generatedCoverReference: null,
    coverTemplate: payload.coverTemplate || 'charcoal_tech',
    totalPages: typeof payload.totalPages === 'number' ? payload.totalPages : null,
    topics: Array.isArray(payload.topics) ? payload.topics : [],
    lastReadPage: typeof payload.lastReadPage === 'number' ? Math.max(0, payload.lastReadPage) : 1,
    analysisStatus: payload.analysisStatus || 'complete',
    analysisNote: payload.analysisNote ?? null,
    createdAt: now,
    updatedAt: now,
  };

  await idbPut(STORE_NAMES.LIBRARY_RESOURCES, record);
  publishSyncEvent('library', { detail: id });
  return record;
}

export async function uploadLibraryPdfFileApi(
  _auth: LibraryAuthHeaderInput,
  resourceId: string,
  file: File | Blob,
  fileName: string,
  options?: {
    onProgress?: (writtenBytes: number, totalBytes: number) => void;
    signal?: AbortSignal;
  }
): Promise<LibraryResource> {
  const existing = await idbGet<LibraryResource>(STORE_NAMES.LIBRARY_RESOURCES, resourceId);
  if (!existing) {
    throw new Error('Resource record was not found.');
  }

  const headerOk = await validatePdfFileHeader(file);
  if (!headerOk) {
    await idbDelete(STORE_NAMES.LIBRARY_RESOURCES, resourceId).catch(() => undefined);
    throw new Error('This file does not contain a valid PDF header.');
  }

  try {
    const meta = await blobStore.savePdfStream(pdfBlobKey(resourceId), file, {
      fileName,
      onProgress: options?.onProgress,
      signal: options?.signal,
    });

    const updated: LibraryResource = {
      ...existing,
      originalFileReference: `${LOCAL_PDF_PREFIX}${resourceId}`,
      originalFileName: fileName || existing.originalFileName || 'document.pdf',
      originalFileSize: meta.sizeBytes,
      fileHash: meta.fileHash ?? existing.fileHash ?? null,
      updatedAt: new Date().toISOString(),
    };

    await idbPut(STORE_NAMES.LIBRARY_RESOURCES, updated);
    publishSyncEvent('library', { detail: resourceId });
    return updated;
  } catch (err) {
    // Clean up orphaned metadata row if initial PDF stream save failed/cancelled
    await blobStore.deleteAsset(pdfBlobKey(resourceId)).catch(() => undefined);
    await idbDelete(STORE_NAMES.LIBRARY_RESOURCES, resourceId).catch(() => undefined);
    if (err instanceof StorageQuotaError) {
      throw new Error('Storage space is insufficient.');
    }
    throw err;
  }
}

export async function uploadLibraryCoverPngApi(
  _auth: LibraryAuthHeaderInput,
  resourceId: string,
  coverOptions: RenderCoverOptions
): Promise<LibraryResource> {
  const existing = await idbGet<LibraryResource>(STORE_NAMES.LIBRARY_RESOURCES, resourceId);
  if (!existing) {
    throw new Error('Resource record was not found.');
  }

  const blob = await generateBookCoverPngBlob(coverOptions);
  await blobStore.saveCoverBlob(coverBlobKey(resourceId), blob);

  const updated: LibraryResource = {
    ...existing,
    generatedCoverReference: `${LOCAL_COVER_PREFIX}${resourceId}?v=${Date.now()}`,
    updatedAt: new Date().toISOString(),
  };

  await idbPut(STORE_NAMES.LIBRARY_RESOURCES, updated);
  publishSyncEvent('library', { detail: resourceId });
  return updated;
}

export async function updateLibraryResourceApi(
  _auth: LibraryAuthHeaderInput,
  resourceId: string,
  patch: UpdateLibraryResourcePayload
): Promise<LibraryResource> {
  const existing = await idbGet<LibraryResource>(STORE_NAMES.LIBRARY_RESOURCES, resourceId);
  if (!existing) {
    throw new Error('Resource not found.');
  }

  const updated: LibraryResource = {
    ...existing,
    ...(typeof patch.title === 'string' && patch.title.trim()
      ? { title: patch.title.trim().slice(0, 180) }
      : {}),
    ...(typeof patch.subtitle === 'string'
      ? { subtitle: patch.subtitle.trim().slice(0, 160) }
      : {}),
    ...(typeof patch.subject === 'string' && patch.subject.trim()
      ? { subject: patch.subject.trim().slice(0, 80) }
      : {}),
    ...(typeof patch.description === 'string'
      ? { description: patch.description.trim().slice(0, 1000) }
      : {}),
    ...(patch.originalUrl !== undefined ? { originalUrl: patch.originalUrl } : {}),
    ...(patch.coverTemplate !== undefined ? { coverTemplate: patch.coverTemplate } : {}),
    ...(patch.totalPages !== undefined ? { totalPages: patch.totalPages } : {}),
    ...(Array.isArray(patch.topics) ? { topics: patch.topics } : {}),
    ...(typeof patch.lastReadPage === 'number'
      ? {
          lastReadPage:
            existing.totalPages && existing.totalPages > 0
              ? Math.max(1, Math.min(existing.totalPages, Math.round(patch.lastReadPage)))
              : Math.max(0, Math.round(patch.lastReadPage)),
        }
      : {}),
    ...(patch.analysisStatus !== undefined ? { analysisStatus: patch.analysisStatus } : {}),
    ...(patch.analysisNote !== undefined ? { analysisNote: patch.analysisNote } : {}),
    updatedAt: new Date().toISOString(),
  };

  await idbPut(STORE_NAMES.LIBRARY_RESOURCES, updated);
  publishSyncEvent('library', { detail: resourceId });
  return updated;
}

export async function deleteLibraryResourceApi(
  _auth: LibraryAuthHeaderInput,
  resourceId: string
): Promise<void> {
  await Promise.all([
    blobStore.deleteAsset(pdfBlobKey(resourceId)).catch(() => undefined),
    blobStore.deleteAsset(coverBlobKey(resourceId)).catch(() => undefined),
    idbDelete(STORE_NAMES.LIBRARY_RESOURCES, resourceId),
  ]);
  publishSyncEvent('library', { detail: resourceId });
}

function buildLocalUrlInspectResult(parsed: URL): InspectUrlResult {
  const hostLabel = parsed.hostname.replace(/^www\./, '');
  const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  const cleanFromPath = lastSegment
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const suggestedTitle =
    cleanFromPath.length >= 3
      ? cleanFromPath.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 120)
      : hostLabel;

  return {
    kind: 'external_url',
    safeUrl: parsed.toString(),
    suggestedTitle,
    suggestedDescription: `Saved study link from ${hostLabel}.`,
    note: 'Link validated and ready to save on this device for offline access to your notes and bookmarks.',
  };
}

export async function inspectLibraryUrlApi(
  auth: LibraryAuthHeaderInput,
  url: string
): Promise<InspectUrlResult> {
  const safeParsed = isSafeWebLink(url);
  if (!safeParsed) {
    throw new Error('Please enter a valid public http:// or https:// URL.');
  }

  // Optional online enrichment when server is reachable; falls back gracefully offline
  try {
    const res = await fetch('/api/library/import-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildLibraryAuthHeaders(auth),
      },
      body: JSON.stringify({ url: safeParsed.toString() }),
      signal: AbortSignal.timeout(4500),
    });

    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('application/json')) {
      return buildLocalUrlInspectResult(safeParsed);
    }

    const parsed = (await res.json()) as InspectUrlResult;
    if (parsed.kind === 'pdf_imported' && parsed.resource) {
      // Pull public PDF once from server into local device storage, then delete temp server record
      const fileRes = await fetch(
        `/api/library/resources/${encodeURIComponent(parsed.resource.id)}/file`,
        {
          method: 'GET',
          headers: buildLibraryAuthHeaders(auth),
        }
      );
      if (fileRes.ok) {
        const pdfBlob = await fileRes.blob();
        const fileName =
          parsed.resource.originalFileName || `${parsed.suggestedTitle || 'Resource'}.pdf`;
        const localCreated = await createLibraryResourceApi(auth, {
          title: parsed.suggestedTitle || parsed.resource.title,
          subtitle: safeParsed.hostname.replace(/^www\./, ''),
          subject: parsed.resource.subject || 'General Studies',
          description: parsed.suggestedDescription || '',
          resourceType: 'pdf',
          originalFileName: fileName,
          originalFileSize: pdfBlob.size,
          originalUrl: parsed.safeUrl,
          coverTemplate: 'charcoal_tech',
          totalPages: null,
          topics: [],
          lastReadPage: 1,
          analysisStatus: 'complete',
          analysisNote: null,
        });
        const localWithPdf = await uploadLibraryPdfFileApi(
          auth,
          localCreated.id,
          pdfBlob,
          fileName
        );
        // Clean up temporary server copy silently
        void fetch(`/api/library/resources/${encodeURIComponent(parsed.resource.id)}`, {
          method: 'DELETE',
          headers: buildLibraryAuthHeaders(auth),
        }).catch(() => undefined);

        return {
          ...parsed,
          resource: localWithPdf,
        };
      }
      return buildLocalUrlInspectResult(safeParsed);
    }

    return parsed;
  } catch {
    return buildLocalUrlInspectResult(safeParsed);
  }
}

export async function openLocalPdfForReader(resourceId: string) {
  const source = await blobStore.openPdfRangeSource(pdfBlobKey(resourceId));
  if (!source) {
    throw new Error(
      'This PDF file is not available on this device. Re-upload it from your device to read.'
    );
  }
  return source;
}

export async function getLocalPdfBlob(resourceId: string): Promise<Blob> {
  const blob = await blobStore.getPdfBlob(pdfBlobKey(resourceId));
  if (!blob) {
    throw new Error('This PDF file is not available on this device.');
  }
  return blob;
}

export async function fetchAuthenticatedPdfBytes(
  _auth: LibraryAuthHeaderInput,
  resourceId: string
): Promise<Uint8Array> {
  const blob = await getLocalPdfBlob(resourceId);
  return new Uint8Array(await blob.arrayBuffer());
}

export async function fetchAuthenticatedCoverObjectUrl(
  _auth: LibraryAuthHeaderInput,
  coverReference: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal?.aborted) {
    throw new Error('Aborted');
  }
  if (coverReference.startsWith(LOCAL_COVER_PREFIX)) {
    const idPart = coverReference.slice(LOCAL_COVER_PREFIX.length).split('?')[0];
    const url = await blobStore.getCoverObjectUrl(coverBlobKey(idPart));
    if (!url) throw new Error('Cover not cached');
    return url;
  }
  throw new Error('Cover not cached');
}

export async function downloadLocalLibraryPdf(
  resourceId: string,
  fallbackFilename: string
): Promise<void> {
  const blob = await getLocalPdfBlob(resourceId);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = fallbackFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

export async function downloadAuthenticatedLibraryFile(
  _auth: LibraryAuthHeaderInput,
  resourceIdOrUrl: string,
  fallbackFilename: string
): Promise<void> {
  const match = /\/api\/library\/resources\/([^/]+)\/file/.exec(resourceIdOrUrl);
  const resourceId = match ? decodeURIComponent(match[1]) : resourceIdOrUrl;
  await downloadLocalLibraryPdf(resourceId, fallbackFilename);
}

export async function downloadGeneratedCoverPng(
  coverOptions: RenderCoverOptions,
  fileNameBase: string
): Promise<void> {
  const blob = await generateBookCoverPngBlob(coverOptions);
  const objectUrl = URL.createObjectURL(blob);
  const cleanName =
    fileNameBase
      .replace(/[^a-zA-Z0-9 _.-]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 60) || 'ekagra-cover';
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = `${cleanName}-cover.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

export async function runLibraryOrphanCleanup(): Promise<number> {
  const resources = await listLibraryResourcesApi();
  const validPdfKeys = new Set<string>();
  const validCoverKeys = new Set<string>();
  for (const r of resources) {
    if (r.resourceType === 'pdf') {
      validPdfKeys.add(pdfBlobKey(r.id));
    }
    validCoverKeys.add(coverBlobKey(r.id));
  }
  return blobStore.cleanupOrphanedAssets(validPdfKeys, validCoverKeys);
}
