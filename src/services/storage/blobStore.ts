import * as pdfjsLib from 'pdfjs-dist';
import {
  idbDelete,
  idbDeleteFileChunksByKey,
  idbEstimateAppMetadataBytes,
  idbGet,
  idbGetAll,
  idbGetAllBlobMeta,
  idbGetFileChunksByKey,
  idbPut,
  STORE_NAMES,
} from './indexedDb';
import type {
  BlobAssetKind,
  BlobMetaRecord,
  FileChunkRecord,
  ILargeFileStore,
  StorageBackendKind,
  StorageQuotaReport,
} from './types';
import type { LibraryResource } from '../../types/library';

export const PDF_STREAM_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MB sequential streaming write slices
export const PDF_SOFT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB practical ceiling when device quota allows
const OPFS_ROOT_FOLDER = 'ekagra-storage';
const OPFS_PDF_FOLDER = 'pdfs';
const OPFS_COVER_FOLDER = 'covers';

export class StorageQuotaError extends Error {
  constructor(message = 'Storage space is insufficient.') {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

export class StorageOperationAbortedError extends Error {
  constructor(message = 'Operation was cancelled.') {
    super(message);
    this.name = 'StorageOperationAbortedError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new StorageOperationAbortedError();
  }
}

function sanitizeKeyForFileName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 140);
}

async function isOpfsSupported(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return false;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_ROOT_FOLDER, { create: true });
    // Ensure createWritable is supported (Safari versions prior to 15.2 lacked it in main thread)
    const probeHandle = await dir.getFileHandle('.probe', { create: true });
    const supported = typeof probeHandle.createWritable === 'function';
    await dir.removeEntry('.probe').catch(() => undefined);
    return supported;
  } catch {
    return false;
  }
}

async function getOpfsSubdir(kind: BlobAssetKind): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle(OPFS_ROOT_FOLDER, { create: true });
  const subName = kind === 'pdf' ? OPFS_PDF_FOLDER : OPFS_COVER_FOLDER;
  return base.getDirectoryHandle(subName, { create: true });
}

export async function requestPersistentStorageSafely(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return false;
  }
  try {
    const already = await navigator.storage.persisted?.();
    if (already) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function checkStorageHeadroom(requiredBytes: number): Promise<{
  ok: boolean;
  availableBytes: number | null;
  quotaBytes: number | null;
  usedBytes: number | null;
}> {
  if (requiredBytes > PDF_SOFT_MAX_BYTES) {
    return {
      ok: false,
      availableBytes: PDF_SOFT_MAX_BYTES,
      quotaBytes: PDF_SOFT_MAX_BYTES,
      usedBytes: null,
    };
  }

  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { ok: true, availableBytes: null, quotaBytes: null, usedBytes: null };
  }

  try {
    const est = await navigator.storage.estimate();
    const quota = typeof est.quota === 'number' && Number.isFinite(est.quota) ? est.quota : null;
    const usage = typeof est.usage === 'number' && Number.isFinite(est.usage) ? est.usage : 0;

    if (quota === null) {
      return { ok: true, availableBytes: null, quotaBytes: null, usedBytes: usage };
    }

    const available = Math.max(0, quota - usage);
    // Keep a small 5% or 512 KB safety margin
    const safetyMargin = Math.max(512 * 1024, Math.min(20 * 1024 * 1024, Math.round(requiredBytes * 0.05)));
    return {
      ok: available >= requiredBytes + safetyMargin,
      availableBytes: available,
      quotaBytes: quota,
      usedBytes: usage,
    };
  } catch {
    return { ok: true, availableBytes: null, quotaBytes: null, usedBytes: null };
  }
}

/**
 * Computes a deterministic content fingerprint without buffering huge PDFs in RAM.
 * Uses full SHA-256 for files <= 20 MB, and size + sampled head/mid/tail SHA-256 for large files.
 */
export async function computeStreamingFileHash(
  file: File | Blob,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal);

  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle) {
    return `size_${file.size}_${file instanceof File ? file.name : 'blob'}`;
  }

  try {
    if (file.size <= 20 * 1024 * 1024) {
      const buf = await file.arrayBuffer();
      throwIfAborted(signal);
      const digest = await subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }

    const sampleSize = 64 * 1024;
    const midOffset = Math.max(0, Math.floor(file.size / 2) - Math.floor(sampleSize / 2));
    const tailOffset = Math.max(0, file.size - sampleSize);

    const [headBuf, midBuf, tailBuf] = await Promise.all([
      file.slice(0, sampleSize).arrayBuffer(),
      file.slice(midOffset, midOffset + sampleSize).arrayBuffer(),
      file.slice(tailOffset, file.size).arrayBuffer(),
    ]);
    throwIfAborted(signal);

    const headerBytes = new TextEncoder().encode(`len:${file.size}:`);
    const combined = new Uint8Array(
      headerBytes.byteLength + headBuf.byteLength + midBuf.byteLength + tailBuf.byteLength
    );
    let offset = 0;
    combined.set(headerBytes, offset);
    offset += headerBytes.byteLength;
    combined.set(new Uint8Array(headBuf), offset);
    offset += headBuf.byteLength;
    combined.set(new Uint8Array(midBuf), offset);
    offset += midBuf.byteLength;
    combined.set(new Uint8Array(tailBuf), offset);

    const digest = await subtle.digest('SHA-256', combined);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch (err) {
    if (err instanceof StorageOperationAbortedError) throw err;
    return `size_${file.size}`;
  }
}

export async function validatePdfFileHeader(file: File | Blob): Promise<boolean> {
  if (file.size === 0) return false;
  const slice = await file.slice(0, Math.min(1024, file.size)).arrayBuffer();
  const header = new TextDecoder('ascii').decode(new Uint8Array(slice));
  return header.includes('%PDF-');
}

function isQuotaError(err: unknown): boolean {
  if (err instanceof StorageQuotaError) return true;
  const name = (err as { name?: string })?.name ?? '';
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    msg.includes('quota') ||
    msg.includes('disk full') ||
    msg.includes('no space')
  );
}

/**
 * Custom PDF.js RangeTransport that lazily streams byte slices from OPFS or IndexedDB chunks,
 * preventing full-file memory allocation for large PDFs.
 */
export function createLazyPdfRangeTransport(
  totalLength: number,
  readRange: (begin: number, end: number) => Promise<Uint8Array>
): pdfjsLib.PDFDataRangeTransport {
  class EkagraPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    override requestDataRange(begin: number, end: number): void {
      const safeBegin = Math.max(0, begin);
      const safeEnd = Math.min(totalLength, Math.max(safeBegin, end));
      void readRange(safeBegin, safeEnd)
        .then((chunk) => {
          this.onDataRange(safeBegin, chunk);
        })
        .catch(() => {
          // PDF.js handles incomplete ranges gracefully if aborted/destroyed
        });
    }
  }

  return new EkagraPdfRangeTransport(totalLength, new Uint8Array(0));
}

export function createFileRangeReader(file: File | Blob): (begin: number, end: number) => Promise<Uint8Array> {
  return async (begin: number, end: number) => {
    const slice = file.slice(begin, end);
    const buf = await slice.arrayBuffer();
    return new Uint8Array(buf);
  };
}

export const blobStore: ILargeFileStore & {
  saveCoverBlob: (key: string, blob: Blob) => Promise<BlobMetaRecord>;
  getCoverObjectUrl: (key: string) => Promise<string | null>;
  getPdfBlob: (key: string) => Promise<Blob | null>;
  openPdfRangeSource: (key: string) => Promise<{
    totalBytes: number;
    readRange: (begin: number, end: number) => Promise<Uint8Array>;
    createRangeTransport: () => pdfjsLib.PDFDataRangeTransport;
  } | null>;
  cleanupOrphanedAssets: (validPdfKeys: Set<string>, validCoverKeys: Set<string>) => Promise<number>;
  getStorageDiagnostics: () => Promise<StorageQuotaReport>;
} = {
  async savePdfStream(key, file, options) {
    const signal = options?.signal;
    throwIfAborted(signal);

    if (file.size === 0) {
      throw new Error('This file appears to be empty.');
    }
    if (file.size > PDF_SOFT_MAX_BYTES) {
      throw new StorageQuotaError('This file exceeds the 1 GB per-document limit.');
    }

    const headroom = await checkStorageHeadroom(file.size);
    if (!headroom.ok) {
      throw new StorageQuotaError('Storage space is insufficient.');
    }

    void requestPersistentStorageSafely();
    const fileHash = await computeStreamingFileHash(file, signal);
    throwIfAborted(signal);

    const now = new Date().toISOString();
    const fileName = options?.fileName ?? (file instanceof File ? file.name : `${key}.pdf`);
    const safeName = sanitizeKeyForFileName(key);
    const useOpfs = await isOpfsSupported();

    if (useOpfs) {
      let dir: FileSystemDirectoryHandle | null = null;
      let writable: FileSystemWritableFileStream | null = null;
      try {
        dir = await getOpfsSubdir('pdf');
        const handle = await dir.getFileHandle(`${safeName}.pdf`, { create: true });
        writable = await handle.createWritable();

        let written = 0;
        while (written < file.size) {
          throwIfAborted(signal);
          const nextEnd = Math.min(file.size, written + PDF_STREAM_CHUNK_BYTES);
          const chunkSlice = file.slice(written, nextEnd);
          const chunkBuffer = await chunkSlice.arrayBuffer();
          throwIfAborted(signal);
          await writable.write(chunkBuffer);
          written = nextEnd;
          options?.onProgress?.(written, file.size);
        }

        await writable.close();
        writable = null;

        const meta: BlobMetaRecord = {
          key,
          kind: 'pdf',
          sizeBytes: file.size,
          mimeType: 'application/pdf',
          fileName,
          fileHash,
          chunkCount: Math.max(1, Math.ceil(file.size / PDF_STREAM_CHUNK_BYTES)),
          backend: 'opfs',
          createdAt: now,
          updatedAt: now,
        };
        await idbPut(STORE_NAMES.BLOB_META, meta);
        return meta;
      } catch (err) {
        if (writable) {
          await writable.abort().catch(() => undefined);
        }
        if (dir) {
          await dir.removeEntry(`${safeName}.pdf`).catch(() => undefined);
        }
        if (err instanceof StorageOperationAbortedError) throw err;
        if (isQuotaError(err)) {
          throw new StorageQuotaError('Storage space is insufficient.');
        }
        // Only fall through to IDB chunk store if OPFS failed due to API unavailability, not quota/abort
      }
    }

    // Fallback: sequential 2 MB chunked Blob writes into IndexedDB
    let chunkIndex = 0;
    let written = 0;
    try {
      await idbDeleteFileChunksByKey(key);
      while (written < file.size) {
        throwIfAborted(signal);
        const nextEnd = Math.min(file.size, written + PDF_STREAM_CHUNK_BYTES);
        const chunkBlob = file.slice(written, nextEnd, 'application/pdf');
        const chunkRec: FileChunkRecord = {
          id: `${key}::${chunkIndex}`,
          key,
          chunkIndex,
          blob: chunkBlob,
        };
        await idbPut(STORE_NAMES.FILE_CHUNKS, chunkRec);
        chunkIndex += 1;
        written = nextEnd;
        options?.onProgress?.(written, file.size);
      }

      const meta: BlobMetaRecord = {
        key,
        kind: 'pdf',
        sizeBytes: file.size,
        mimeType: 'application/pdf',
        fileName,
        fileHash,
        chunkCount: Math.max(1, chunkIndex),
        backend: 'indexeddb',
        createdAt: now,
        updatedAt: now,
      };
      await idbPut(STORE_NAMES.BLOB_META, meta);
      return meta;
    } catch (err) {
      await idbDeleteFileChunksByKey(key).catch(() => undefined);
      await idbDelete(STORE_NAMES.BLOB_META, key).catch(() => undefined);
      if (err instanceof StorageOperationAbortedError) throw err;
      if (isQuotaError(err)) {
        throw new StorageQuotaError('Storage space is insufficient.');
      }
      throw err;
    }
  },

  async saveCoverBlob(key, blob) {
    const now = new Date().toISOString();
    const safeName = sanitizeKeyForFileName(key);
    const useOpfs = await isOpfsSupported();

    if (useOpfs) {
      try {
        const dir = await getOpfsSubdir('cover');
        const handle = await dir.getFileHandle(`${safeName}.png`, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();

        const meta: BlobMetaRecord = {
          key,
          kind: 'cover',
          sizeBytes: blob.size,
          mimeType: blob.type || 'image/png',
          fileName: `${safeName}.png`,
          fileHash: null,
          chunkCount: 1,
          backend: 'opfs',
          createdAt: now,
          updatedAt: now,
        };
        await idbPut(STORE_NAMES.BLOB_META, meta);
        return meta;
      } catch {
        // Fallback to IndexedDB below
      }
    }

    const chunkRec: FileChunkRecord = {
      id: `${key}::0`,
      key,
      chunkIndex: 0,
      blob,
    };
    await idbPut(STORE_NAMES.FILE_CHUNKS, chunkRec);
    const meta: BlobMetaRecord = {
      key,
      kind: 'cover',
      sizeBytes: blob.size,
      mimeType: blob.type || 'image/png',
      fileName: `${safeName}.png`,
      fileHash: null,
      chunkCount: 1,
      backend: 'indexeddb',
      createdAt: now,
      updatedAt: now,
    };
    await idbPut(STORE_NAMES.BLOB_META, meta);
    return meta;
  },

  async getCoverObjectUrl(key) {
    const meta = await idbGet<BlobMetaRecord>(STORE_NAMES.BLOB_META, key);
    if (!meta) return null;
    const safeName = sanitizeKeyForFileName(key);

    if (meta.backend === 'opfs' && (await isOpfsSupported())) {
      try {
        const dir = await getOpfsSubdir('cover');
        const handle = await dir.getFileHandle(`${safeName}.png`);
        const file = await handle.getFile();
        return URL.createObjectURL(file);
      } catch {
        // Fall through to IDB check
      }
    }

    const chunks = await idbGetFileChunksByKey(key);
    if (chunks.length === 0) return null;
    const blob =
      chunks.length === 1
        ? chunks[0].blob
        : new Blob(chunks.map((c) => c.blob), { type: meta.mimeType || 'image/png' });
    return URL.createObjectURL(blob);
  },

  async openPdfRangeSource(key) {
    const meta = await idbGet<BlobMetaRecord>(STORE_NAMES.BLOB_META, key);
    if (!meta) return null;
    const safeName = sanitizeKeyForFileName(key);

    if (meta.backend === 'opfs' && (await isOpfsSupported())) {
      try {
        const dir = await getOpfsSubdir('pdf');
        const handle = await dir.getFileHandle(`${safeName}.pdf`);
        const file = await handle.getFile();
        const readRange = createFileRangeReader(file);
        return {
          totalBytes: file.size,
          readRange,
          createRangeTransport: () => createLazyPdfRangeTransport(file.size, readRange),
        };
      } catch {
        // Check IDB fallback below
      }
    }

    const chunks = await idbGetFileChunksByKey(key);
    if (chunks.length === 0) return null;

    // Build chunk byte offsets for O(1) random range slicing across chunk boundaries
    const chunkOffsets: Array<{ start: number; end: number; blob: Blob }> = [];
    let cursor = 0;
    for (const ch of chunks) {
      const start = cursor;
      const end = cursor + ch.blob.size;
      chunkOffsets.push({ start, end, blob: ch.blob });
      cursor = end;
    }
    const totalBytes = cursor;

    const readRange = async (begin: number, end: number): Promise<Uint8Array> => {
      const safeBegin = Math.max(0, begin);
      const safeEnd = Math.min(totalBytes, Math.max(safeBegin, end));
      const out = new Uint8Array(safeEnd - safeBegin);
      let writeOffset = 0;

      for (const ch of chunkOffsets) {
        if (ch.end <= safeBegin) continue;
        if (ch.start >= safeEnd) break;
        const localStart = Math.max(0, safeBegin - ch.start);
        const localEnd = Math.min(ch.blob.size, safeEnd - ch.start);
        const part = new Uint8Array(await ch.blob.slice(localStart, localEnd).arrayBuffer());
        out.set(part, writeOffset);
        writeOffset += part.byteLength;
      }
      return out;
    };

    return {
      totalBytes,
      readRange,
      createRangeTransport: () => createLazyPdfRangeTransport(totalBytes, readRange),
    };
  },

  async readPdfRange(key, begin, end) {
    const src = await this.openPdfRangeSource(key);
    if (!src) {
      throw new Error('Stored PDF document could not be found on this device.');
    }
    return src.readRange(begin, end);
  },

  async getPdfBlob(key) {
    const meta = await idbGet<BlobMetaRecord>(STORE_NAMES.BLOB_META, key);
    if (!meta) return null;
    const safeName = sanitizeKeyForFileName(key);

    if (meta.backend === 'opfs' && (await isOpfsSupported())) {
      try {
        const dir = await getOpfsSubdir('pdf');
        const handle = await dir.getFileHandle(`${safeName}.pdf`);
        return await handle.getFile();
      } catch {
        // Fallback below
      }
    }

    const chunks = await idbGetFileChunksByKey(key);
    if (chunks.length === 0) return null;
    return new Blob(chunks.map((c) => c.blob), { type: 'application/pdf' });
  },

  async deleteAsset(key) {
    const meta = await idbGet<BlobMetaRecord>(STORE_NAMES.BLOB_META, key);
    const safeName = sanitizeKeyForFileName(key);

    if (await isOpfsSupported()) {
      try {
        const pdfDir = await getOpfsSubdir('pdf');
        await pdfDir.removeEntry(`${safeName}.pdf`).catch(() => undefined);
      } catch {
        // ignore
      }
      try {
        const coverDir = await getOpfsSubdir('cover');
        await coverDir.removeEntry(`${safeName}.png`).catch(() => undefined);
      } catch {
        // ignore
      }
    }

    if (!meta || meta.backend !== 'opfs') {
      await idbDeleteFileChunksByKey(key).catch(() => undefined);
    } else {
      await idbDeleteFileChunksByKey(key).catch(() => undefined);
    }
    await idbDelete(STORE_NAMES.BLOB_META, key).catch(() => undefined);
  },

  async cleanupOrphanedAssets(validPdfKeys, validCoverKeys) {
    const allMeta = await idbGetAllBlobMeta();
    let cleanedCount = 0;

    for (const meta of allMeta) {
      const keep =
        (meta.kind === 'pdf' && validPdfKeys.has(meta.key)) ||
        (meta.kind === 'cover' && validCoverKeys.has(meta.key));
      if (!keep) {
        await this.deleteAsset(meta.key);
        cleanedCount += 1;
      }
    }

    // Also sweep orphaned OPFS files not tracked in BLOB_META
    if (await isOpfsSupported()) {
      try {
        const pdfDir = await getOpfsSubdir('pdf');
        const entries = (pdfDir as unknown as { values?: () => AsyncIterable<FileSystemHandle> }).values?.();
        if (entries) {
          for await (const entry of entries) {
            if (entry.kind !== 'file') continue;
            const stem = entry.name.replace(/\.pdf$/i, '');
            const matchesValid = Array.from(validPdfKeys).some(
              (k) => sanitizeKeyForFileName(k) === stem
            );
            if (!matchesValid) {
              await pdfDir.removeEntry(entry.name).catch(() => undefined);
              cleanedCount += 1;
            }
          }
        }
      } catch {
        // Ignore OPFS iteration errors on older implementations
      }

      try {
        const coverDir = await getOpfsSubdir('cover');
        const entries = (coverDir as unknown as { values?: () => AsyncIterable<FileSystemHandle> }).values?.();
        if (entries) {
          for await (const entry of entries) {
            if (entry.kind !== 'file') continue;
            const stem = entry.name.replace(/\.png$/i, '');
            const matchesValid = Array.from(validCoverKeys).some(
              (k) => sanitizeKeyForFileName(k) === stem
            );
            if (!matchesValid) {
              await coverDir.removeEntry(entry.name).catch(() => undefined);
              cleanedCount += 1;
            }
          }
        }
      } catch {
        // Ignore
      }
    }

    return cleanedCount;
  },

  async getStorageDiagnostics() {
    const [blobs, libraryResources, appDataBytes, opfsSupported] = await Promise.all([
      idbGetAllBlobMeta(),
      idbGetAll<LibraryResource>(STORE_NAMES.LIBRARY_RESOURCES),
      idbEstimateAppMetadataBytes(),
      isOpfsSupported(),
    ]);

    let pdfBytes = 0;
    let coverAndCacheBytes = 0;
    for (const b of blobs) {
      if (b.kind === 'pdf') pdfBytes += b.sizeBytes;
      else coverAndCacheBytes += b.sizeBytes;
    }

    let estimatedQuotaBytes: number | null = null;
    let browserUsageBytes: number | null = null;
    let isPersisted = false;

    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (typeof est.quota === 'number' && Number.isFinite(est.quota)) {
          estimatedQuotaBytes = est.quota;
        }
        if (typeof est.usage === 'number' && Number.isFinite(est.usage)) {
          browserUsageBytes = est.usage;
        }
      } catch {
        // ignore
      }
    }

    if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
      try {
        isPersisted = Boolean(await navigator.storage.persisted());
      } catch {
        isPersisted = false;
      }
    }

    const totalLogicalBytes = pdfBytes + coverAndCacheBytes + appDataBytes;
    const totalUsedBytes =
      browserUsageBytes !== null ? Math.max(browserUsageBytes, totalLogicalBytes) : totalLogicalBytes;
    const estimatedAvailableBytes =
      estimatedQuotaBytes !== null ? Math.max(0, estimatedQuotaBytes - totalUsedBytes) : null;

    const pdfCount = libraryResources.filter((r) => r.resourceType === 'pdf').length;
    const linkCount = libraryResources.filter((r) => r.resourceType !== 'pdf').length;

    return {
      supported: typeof indexedDB !== 'undefined',
      isPersisted,
      totalUsedBytes,
      pdfBytes,
      coverAndCacheBytes,
      appDataBytes,
      estimatedQuotaBytes,
      estimatedAvailableBytes,
      savedResourcesCount: libraryResources.length,
      pdfCount,
      linkCount,
      storageBackend: opfsSupported ? 'opfs' : typeof indexedDB !== 'undefined' ? 'indexeddb' : 'memory',
    };
  },
};
