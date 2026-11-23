import type {
  CreateLibraryResourcePayload,
  InspectUrlResult,
  LibraryResource,
  UpdateLibraryResourcePayload,
} from '../types/library';
import { generateBookCoverPngBlob, type RenderCoverOptions } from '../utils/libraryCoverGenerator';

export interface LibraryAuthHeaderInput {
  accessToken?: string | null;
  isGuest?: boolean;
}

export function buildLibraryAuthHeaders(auth: LibraryAuthHeaderInput): Record<string, string> {
  if (auth.accessToken) {
    return { Authorization: `Bearer ${auth.accessToken}` };
  }
  if (auth.isGuest) {
    return { 'x-ekagra-mode': 'guest' };
  }
  return {};
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error('Unexpected response from server.');
  }
  if (!response.ok) {
    const errMsg =
      typeof parsed.error === 'string' && parsed.error.trim()
        ? parsed.error
        : `Request failed (HTTP ${response.status}).`;
    throw new Error(errMsg);
  }
  return parsed as T;
}

export async function listLibraryResourcesApi(
  auth: LibraryAuthHeaderInput
): Promise<LibraryResource[]> {
  const res = await fetch('/api/library/resources', {
    method: 'GET',
    headers: buildLibraryAuthHeaders(auth),
  });
  const data = await parseJsonOrThrow<{ resources: LibraryResource[] }>(res);
  return Array.isArray(data.resources) ? data.resources : [];
}

export async function createLibraryResourceApi(
  auth: LibraryAuthHeaderInput,
  payload: CreateLibraryResourcePayload
): Promise<LibraryResource> {
  const res = await fetch('/api/library/resources', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildLibraryAuthHeaders(auth),
    },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonOrThrow<{ resource: LibraryResource }>(res);
  return data.resource;
}

export async function uploadLibraryPdfFileApi(
  auth: LibraryAuthHeaderInput,
  resourceId: string,
  file: File | Blob,
  fileName: string
): Promise<LibraryResource> {
  const buffer = await file.arrayBuffer();
  const res = await fetch(`/api/library/resources/${encodeURIComponent(resourceId)}/file`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-File-Name': encodeURIComponent(fileName),
      ...buildLibraryAuthHeaders(auth),
    },
    body: buffer,
  });
  const data = await parseJsonOrThrow<{ resource: LibraryResource }>(res);
  return data.resource;
}

export async function uploadLibraryCoverPngApi(
  auth: LibraryAuthHeaderInput,
  resourceId: string,
  coverOptions: RenderCoverOptions
): Promise<LibraryResource> {
  const blob = await generateBookCoverPngBlob(coverOptions);
  const res = await fetch(`/api/library/resources/${encodeURIComponent(resourceId)}/cover`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      ...buildLibraryAuthHeaders(auth),
    },
    body: await blob.arrayBuffer(),
  });
  const data = await parseJsonOrThrow<{ resource: LibraryResource }>(res);
  return data.resource;
}

export async function updateLibraryResourceApi(
  auth: LibraryAuthHeaderInput,
  resourceId: string,
  patch: UpdateLibraryResourcePayload
): Promise<LibraryResource> {
  const res = await fetch(`/api/library/resources/${encodeURIComponent(resourceId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...buildLibraryAuthHeaders(auth),
    },
    body: JSON.stringify(patch),
  });
  const data = await parseJsonOrThrow<{ resource: LibraryResource }>(res);
  return data.resource;
}

export async function deleteLibraryResourceApi(
  auth: LibraryAuthHeaderInput,
  resourceId: string
): Promise<void> {
  const res = await fetch(`/api/library/resources/${encodeURIComponent(resourceId)}`, {
    method: 'DELETE',
    headers: buildLibraryAuthHeaders(auth),
  });
  await parseJsonOrThrow<{ ok: boolean }>(res);
}

export async function inspectLibraryUrlApi(
  auth: LibraryAuthHeaderInput,
  url: string
): Promise<InspectUrlResult> {
  const res = await fetch('/api/library/import-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildLibraryAuthHeaders(auth),
    },
    body: JSON.stringify({ url }),
  });
  return parseJsonOrThrow<InspectUrlResult>(res);
}

export async function fetchAuthenticatedPdfBytes(
  auth: LibraryAuthHeaderInput,
  resourceId: string
): Promise<Uint8Array> {
  const res = await fetch(`/api/library/resources/${encodeURIComponent(resourceId)}/file`, {
    method: 'GET',
    headers: buildLibraryAuthHeaders(auth),
  });
  if (!res.ok) {
    let msg = 'Could not load PDF file.';
    try {
      const errJson = (await res.json()) as { error?: string };
      if (errJson.error) msg = errJson.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

export async function fetchAuthenticatedCoverObjectUrl(
  auth: LibraryAuthHeaderInput,
  coverReference: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(coverReference, {
    method: 'GET',
    headers: buildLibraryAuthHeaders(auth),
    signal,
  });
  if (!res.ok) {
    throw new Error('Cover not cached');
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function downloadAuthenticatedLibraryFile(
  auth: LibraryAuthHeaderInput,
  url: string,
  fallbackFilename: string
): Promise<void> {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}download=1`, {
    method: 'GET',
    headers: buildLibraryAuthHeaders(auth),
  });
  if (!res.ok) {
    throw new Error('Download failed.');
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = fallbackFilename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
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
