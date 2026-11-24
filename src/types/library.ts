export type LibraryResourceType = 'pdf' | 'external_url';

export type LibraryCoverTemplateId =
  | 'charcoal_tech'
  | 'cobalt_math'
  | 'editorial_humanities'
  | 'botanical_bio'
  | 'obsidian_physics'
  | 'terracotta_exam';

export type LibraryTopicVerification =
  | 'verified_outline'
  | 'detected_heading'
  | 'ocr_detected'
  | 'manual'
  | 'unverified';

export type LibraryAnalysisStatus =
  | 'complete'
  | 'scanned_needs_ocr'
  | 'ocr_partial'
  | 'external_link'
  | 'error';

export interface LibraryTopic {
  id: string;
  title: string;
  startPage: number | null;
  endPage: number | null;
  description?: string;
  verificationStatus: LibraryTopicVerification;
}

export interface LibraryResource {
  id: string;
  userId: string;
  title: string;
  subtitle: string;
  subject: string;
  description: string;
  resourceType: LibraryResourceType;
  originalFileReference: string | null;
  originalFileName: string | null;
  originalFileSize: number | null;
  fileHash?: string | null;
  originalUrl: string | null;
  generatedCoverReference: string | null;
  coverTemplate: LibraryCoverTemplateId;
  totalPages: number | null;
  topics: LibraryTopic[];
  lastReadPage: number;
  analysisStatus: LibraryAnalysisStatus;
  analysisNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLibraryResourcePayload {
  title: string;
  subtitle?: string;
  subject: string;
  description: string;
  resourceType: LibraryResourceType;
  originalFileName?: string | null;
  originalFileSize?: number | null;
  fileHash?: string | null;
  originalUrl?: string | null;
  coverTemplate: LibraryCoverTemplateId;
  totalPages: number | null;
  topics: LibraryTopic[];
  lastReadPage?: number;
  analysisStatus: LibraryAnalysisStatus;
  analysisNote?: string | null;
}

export interface UpdateLibraryResourcePayload {
  title?: string;
  subtitle?: string;
  subject?: string;
  description?: string;
  originalUrl?: string | null;
  coverTemplate?: LibraryCoverTemplateId;
  totalPages?: number | null;
  topics?: LibraryTopic[];
  lastReadPage?: number;
  analysisStatus?: LibraryAnalysisStatus;
  analysisNote?: string | null;
}

export interface InspectUrlResult {
  kind: 'pdf_imported' | 'external_url';
  safeUrl: string;
  suggestedTitle: string;
  suggestedDescription: string;
  note: string;
  resource?: LibraryResource;
}
