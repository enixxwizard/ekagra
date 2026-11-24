import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import {
  createLibraryResourceApi,
  findDuplicateLibraryResource,
  inspectLibraryUrlApi,
  openLocalPdfForReader,
  updateLibraryResourceApi,
  uploadLibraryCoverPngApi,
  uploadLibraryPdfFileApi,
} from '../../services/libraryService';
import {
  checkStorageHeadroom,
  PDF_SOFT_MAX_BYTES,
  StorageOperationAbortedError,
  StorageQuotaError,
  validatePdfFileHeader,
} from '../../services/storage/blobStore';
import type {
  LibraryCoverTemplateId,
  LibraryResource,
} from '../../types/library';
import {
  COVER_TEMPLATES,
  inferSubjectAndTemplate,
  LIBRARY_SUBJECTS,
} from '../../utils/libraryCoverGenerator';
import {
  analyzePdfForLibrary,
  type LibraryPdfAnalysisProgress,
  type LibraryPdfAnalysisResult,
} from '../../utils/libraryPdfAnalyzer';
import { BiIcon } from '../ui/BiIcon';
import { BookCoverArtwork } from './BookCoverArtwork';

interface AddResourceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onResourceAdded: (resource: LibraryResource) => void;
}

type AddMode = 'pdf' | 'url';

export const AddResourceModal: React.FC<AddResourceModalProps> = ({
  isOpen,
  onClose,
  onResourceAdded,
}) => {
  const { status: authStatus, session } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [mode, setMode] = useState<AddMode>('pdf');
  const [isDragging, setIsDragging] = useState(false);

  // Selected PDF state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFileHash, setSelectedFileHash] = useState<string | null>(null);
  const [duplicateNotice, setDuplicateNotice] = useState<LibraryResource | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState<LibraryPdfAnalysisProgress | null>(
    null
  );
  const [saveProgressMessage, setSaveProgressMessage] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<LibraryPdfAnalysisResult | null>(null);
  const [importedUrlResourceId, setImportedUrlResourceId] = useState<string | null>(null);

  // URL mode state
  const [urlInput, setUrlInput] = useState('');
  const [inspectingUrl, setInspectingUrl] = useState(false);
  const [urlNotice, setUrlNotice] = useState<string | null>(null);
  const [safeExternalUrl, setSafeExternalUrl] = useState<string | null>(null);

  // Editable metadata preview before saving
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [subject, setSubject] = useState<string>('General Studies');
  const [description, setDescription] = useState('');
  const [coverTemplate, setCoverTemplate] = useState<LibraryCoverTemplateId>('charcoal_tech');

  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const authCreds = {
    accessToken: session?.access_token ?? null,
    isGuest: authStatus === 'guest',
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving && !analysisProgress && !inspectingUrl) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, isSaving, analysisProgress, inspectingUrl, onClose]);

  const resetForm = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setSelectedFile(null);
    setSelectedFileHash(null);
    setDuplicateNotice(null);
    setAnalysisProgress(null);
    setSaveProgressMessage(null);
    setAnalysisResult(null);
    setImportedUrlResourceId(null);
    setUrlInput('');
    setInspectingUrl(false);
    setUrlNotice(null);
    setSafeExternalUrl(null);
    setTitle('');
    setSubtitle('');
    setSubject('General Studies');
    setDescription('');
    setCoverTemplate('charcoal_tech');
    setErrorMessage('');
    setIsSaving(false);
  };

  const handleClose = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    resetForm();
    onClose();
  };

  const processLocalPdfFile = async (file: File) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setErrorMessage('');
    setUrlNotice(null);
    setSafeExternalUrl(null);
    setImportedUrlResourceId(null);
    setDuplicateNotice(null);
    setSelectedFileHash(null);

    if (
      file.type !== 'application/pdf' &&
      !file.name.toLowerCase().endsWith('.pdf')
    ) {
      setErrorMessage('Please choose a valid .pdf file.');
      return;
    }

    if (file.size === 0) {
      setErrorMessage('This file appears to be empty.');
      return;
    }

    if (file.size > PDF_SOFT_MAX_BYTES) {
      setErrorMessage('This file exceeds the 1 GB per-document limit.');
      return;
    }

    try {
      const headerValid = await validatePdfFileHeader(file);
      if (!headerValid) {
        setErrorMessage('This file does not contain a valid PDF header.');
        return;
      }

      const headroom = await checkStorageHeadroom(file.size);
      if (!headroom.ok) {
        setErrorMessage('Storage space is insufficient.');
        return;
      }

      setSelectedFile(file);
      setAnalysisProgress({
        stage: 'loading',
        currentPage: 0,
        totalPages: 0,
        percent: 3,
        message: 'Preparing your document…',
      });

      const { duplicate, fileHash } = await findDuplicateLibraryResource(file);
      if (controller.signal.aborted) return;
      setSelectedFileHash(fileHash);
      if (duplicate) {
        setDuplicateNotice(duplicate);
      }

      const analyzed = await analyzePdfForLibrary(
        file,
        file.name,
        (prog) => setAnalysisProgress(prog),
        controller.signal
      );
      if (controller.signal.aborted) return;

      setAnalysisProgress(null);
      setAnalysisResult(analyzed);
      setTitle(analyzed.title);
      setSubtitle(analyzed.subtitle);
      setSubject(analyzed.subject);
      setDescription(analyzed.description);
      setCoverTemplate(analyzed.coverTemplate);
    } catch (err) {
      if (err instanceof StorageOperationAbortedError || controller.signal.aborted) {
        setAnalysisProgress(null);
        return;
      }
      setAnalysisProgress(null);
      setSelectedFile(null);
      setAnalysisResult(null);
      setErrorMessage(
        err instanceof StorageQuotaError
          ? 'Storage space is insufficient.'
          : err instanceof Error
          ? err.message
          : 'Unable to analyze this PDF document.'
      );
    }
  };

  const handleInspectUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setUrlNotice(null);
    setSafeExternalUrl(null);
    setAnalysisResult(null);
    setImportedUrlResourceId(null);

    const trimmed = urlInput.trim();
    if (!trimmed) {
      setErrorMessage('Please paste a resource URL.');
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http:// and https:// URLs are supported.');
      }
    } catch {
      setErrorMessage('Please enter a valid URL starting with https:// or http://.');
      return;
    }

    setInspectingUrl(true);
    try {
      const result = await inspectLibraryUrlApi(authCreds, parsed.toString());

      if (result.kind === 'pdf_imported' && result.resource) {
        setImportedUrlResourceId(result.resource.id);
        setSafeExternalUrl(result.safeUrl);
        setUrlNotice('Preparing your document…');
        const rangeSource = await openLocalPdfForReader(result.resource.id);
        const analyzed = await analyzePdfForLibrary(
          rangeSource,
          result.resource.originalFileName || `${result.suggestedTitle}.pdf`,
          (prog) => setAnalysisProgress(prog)
        );
        setAnalysisProgress(null);
        setAnalysisResult(analyzed);
        setTitle(analyzed.title);
        setSubtitle(analyzed.subtitle);
        setSubject(analyzed.subject);
        setDescription(analyzed.description);
        setCoverTemplate(analyzed.coverTemplate);
        setUrlNotice('Resource ready to save. Review the details below and click Save to Library.');
      } else {
        setSafeExternalUrl(result.safeUrl);
        setUrlNotice(result.note);
        const inferred = inferSubjectAndTemplate(
          `${result.suggestedTitle} ${result.suggestedDescription}`
        );
        setTitle(result.suggestedTitle || parsed.hostname);
        setSubtitle(parsed.hostname.replace(/^www\./, ''));
        setSubject(inferred.subject);
        setCoverTemplate(inferred.coverTemplate);
        setDescription(result.suggestedDescription);
      }
    } catch (err) {
      setAnalysisProgress(null);
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to inspect that URL.'
      );
    } finally {
      setInspectingUrl(false);
    }
  };

  const handleSaveResource = async () => {
    setErrorMessage('');
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setErrorMessage('Please enter a book title.');
      return;
    }

    const saveController = new AbortController();
    abortControllerRef.current = saveController;
    setIsSaving(true);
    setSaveProgressMessage('Saving resource...');

    try {
      // Case 1: PDF uploaded from device
      if (mode === 'pdf' && selectedFile && analysisResult) {
        const created = await createLibraryResourceApi(authCreds, {
          title: cleanTitle,
          subtitle: subtitle.trim(),
          subject: subject.trim() || 'General Studies',
          description: description.trim(),
          resourceType: 'pdf',
          originalFileName: selectedFile.name,
          originalFileSize: selectedFile.size,
          fileHash: selectedFileHash,
          coverTemplate,
          totalPages: analysisResult.totalPages,
          topics: analysisResult.topics,
          lastReadPage: 1,
          analysisStatus: analysisResult.analysisStatus,
          analysisNote: analysisResult.analysisNote,
        });

        const withPdf = await uploadLibraryPdfFileApi(
          authCreds,
          created.id,
          selectedFile,
          selectedFile.name,
          {
            signal: saveController.signal,
            onProgress: (written, total) => {
              const pct = total > 0 ? Math.round((written / total) * 100) : 100;
              setSaveProgressMessage(`Saving resource... ${pct}%`);
            },
          }
        );

        const withCover = await uploadLibraryCoverPngApi(authCreds, created.id, {
          title: cleanTitle,
          subtitle: subtitle.trim(),
          subject: subject.trim() || 'General Studies',
          templateId: coverTemplate,
          totalPages: analysisResult.totalPages,
        }).catch(() => withPdf);

        onResourceAdded(withCover);
        resetForm();
        onClose();
        return;
      }

      // Case 2: PDF already downloaded on server from safe public URL
      if (mode === 'url' && importedUrlResourceId && analysisResult) {
        const updated = await updateLibraryResourceApi(authCreds, importedUrlResourceId, {
          title: cleanTitle,
          subtitle: subtitle.trim(),
          subject: subject.trim() || 'General Studies',
          description: description.trim(),
          coverTemplate,
          totalPages: analysisResult.totalPages,
          topics: analysisResult.topics,
          lastReadPage: 1,
          analysisStatus: analysisResult.analysisStatus,
          analysisNote: analysisResult.analysisNote,
        });

        const withCover = await uploadLibraryCoverPngApi(authCreds, updated.id, {
          title: cleanTitle,
          subtitle: subtitle.trim(),
          subject: subject.trim() || 'General Studies',
          templateId: coverTemplate,
          totalPages: analysisResult.totalPages,
        }).catch(() => updated);

        onResourceAdded(withCover);
        resetForm();
        onClose();
        return;
      }

      // Case 3: External URL resource
      if (mode === 'url' && safeExternalUrl) {
        const created = await createLibraryResourceApi(authCreds, {
          title: cleanTitle,
          subtitle: subtitle.trim(),
          subject: subject.trim() || 'General Studies',
          description: description.trim(),
          resourceType: 'external_url',
          originalUrl: safeExternalUrl,
          coverTemplate,
          totalPages: null,
          topics: [],
          lastReadPage: 0,
          analysisStatus: 'external_link',
          analysisNote: urlNotice,
        });

        const withCover = await uploadLibraryCoverPngApi(authCreds, created.id, {
          title: cleanTitle,
          subtitle: subtitle.trim(),
          subject: subject.trim() || 'General Studies',
          templateId: coverTemplate,
          totalPages: null,
        }).catch(() => created);

        onResourceAdded(withCover);
        resetForm();
        onClose();
        return;
      }

      setErrorMessage('Please select a PDF file or inspect a resource URL first.');
    } catch (err) {
      if (err instanceof StorageOperationAbortedError) {
        setErrorMessage('Save cancelled.');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Unable to save resource to your library.'
        );
      }
    } finally {
      setSaveProgressMessage(null);
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  const isReadyToSave = Boolean(
    (mode === 'pdf' && selectedFile && analysisResult) ||
      (mode === 'url' && (importedUrlResourceId || safeExternalUrl) && title.trim())
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--df-backdrop)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-resource-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="animate-sheet-up max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5 shadow-xl sm:p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[var(--df-border)] pb-4">
          <div>
            <h2
              id="add-resource-title"
              className="font-display text-lg font-semibold text-[var(--df-text)]"
            >
              Add Resource
            </h2>
            <p className="mt-0.5 text-xs text-[var(--df-text-muted)]">
              Upload a study PDF for automatic cover &amp; topic indexing, or save a resource link.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close modal"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--df-text-muted)] transition-colors hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
          >
            <BiIcon name="x-lg" className="text-sm" />
          </button>
        </div>

        {/* Source Switch */}
        <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-[var(--df-surface-muted)] p-1">
          <button
            type="button"
            onClick={() => {
              setMode('pdf');
              setErrorMessage('');
            }}
            className={`min-h-[40px] rounded-lg px-3 text-xs font-semibold transition-colors ${
              mode === 'pdf'
                ? 'bg-[var(--df-surface)] text-[var(--df-text)] shadow-sm'
                : 'text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <BiIcon name="file-earmark-pdf" />
              Upload PDF
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('url');
              setErrorMessage('');
            }}
            className={`min-h-[40px] rounded-lg px-3 text-xs font-semibold transition-colors ${
              mode === 'url'
                ? 'bg-[var(--df-surface)] text-[var(--df-text)] shadow-sm'
                : 'text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              <BiIcon name="link-45deg" />
              Paste Resource URL
            </span>
          </button>
        </div>

        {/* Input Zone */}
        {mode === 'pdf' ? (
          <div className="mt-4">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void processLocalPdfFile(file);
                e.target.value = '';
              }}
            />

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) void processLocalPdfFile(dropped);
              }}
              className={`flex flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-7 text-center transition-colors ${
                isDragging
                  ? 'border-[var(--df-accent)] bg-[var(--df-accent-soft)]'
                  : 'border-[var(--df-border-strong)] bg-[var(--df-surface-muted)]'
              }`}
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--df-surface)] text-[var(--df-text)] shadow-sm">
                <BiIcon name="cloud-arrow-up" className="text-lg" />
              </div>
              <p className="mt-3 text-sm font-medium text-[var(--df-text)]">
                {selectedFile ? selectedFile.name : 'Drop a textbook, notes, or syllabus PDF'}
              </p>
              <p className="mt-1 text-xs text-[var(--df-text-muted)]">
                Supports PDFs up to 1 GB depending on available device storage. Saved on this device for offline reading.
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={Boolean(analysisProgress) || isSaving}
                className="mt-4 inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[var(--df-cta)] px-4 text-xs font-semibold text-[var(--df-cta-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <BiIcon name="folder2-open" />
                <span>{selectedFile ? 'Choose Different PDF' : 'Select PDF from Device'}</span>
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleInspectUrl} className="mt-4 space-y-3">
            <label className="block text-xs font-medium text-[var(--df-text-muted)]">
              Paste a direct PDF link or educational webpage URL
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.edu/notes/data-structures.pdf"
                className="min-h-[44px] flex-1 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3.5 text-sm text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-accent)] focus:outline-none"
              />
              <button
                type="submit"
                disabled={inspectingUrl || isSaving}
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-[var(--df-cta)] px-4 text-xs font-semibold text-[var(--df-cta-fg)] transition-opacity hover:opacity-90 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <BiIcon name="search" />
                <span>{inspectingUrl ? 'Inspecting…' : 'Check Link'}</span>
              </button>
            </div>
            {urlNotice && (
              <p className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--df-text-muted)]">
                {urlNotice}
              </p>
            )}
          </form>
        )}

        {/* Duplicate File Notice */}
        {duplicateNotice && !errorMessage && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-400/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200">
            <BiIcon name="exclamation-triangle" className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">
                Duplicate file detected: &ldquo;{duplicateNotice.title}&rdquo; is already in your Library.
              </p>
              <p className="mt-0.5 opacity-90">
                You can cancel to keep the existing copy, or save another copy below.
              </p>
            </div>
          </div>
        )}

        {/* Analysis Progress Bar */}
        {(analysisProgress || saveProgressMessage) && (
          <div className="mt-4 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] p-3.5">
            <div className="flex items-center justify-between text-xs font-medium text-[var(--df-text)]">
              <span>{saveProgressMessage || analysisProgress?.message}</span>
              {analysisProgress && !saveProgressMessage && (
                <span className="font-mono tabular-nums">{analysisProgress.percent}%</span>
              )}
            </div>
            {analysisProgress && !saveProgressMessage && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--df-border)]">
                <div
                  className="h-full rounded-full bg-[var(--df-accent)] transition-all duration-200"
                  style={{ width: `${analysisProgress.percent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {errorMessage && (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-500"
          >
            {errorMessage}
          </div>
        )}

        {/* Generated Cover + Metadata Customization Preview */}
        {isReadyToSave && !analysisProgress && (
          <div className="mt-5 grid gap-5 border-t border-[var(--df-border)] pt-5 sm:grid-cols-[176px_1fr]">
            <div className="mx-auto w-40 sm:mx-0 sm:w-full">
              <BookCoverArtwork
                title={title || 'Study Resource'}
                subtitle={subtitle}
                subject={subject || 'General Studies'}
                templateId={coverTemplate}
                totalPages={analysisResult?.totalPages ?? null}
              />
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                  Book Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="min-h-[40px] w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-sm text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                    Subtitle
                  </label>
                  <input
                    type="text"
                    value={subtitle}
                    onChange={(e) => setSubtitle(e.target.value)}
                    placeholder="Optional focus or edition"
                    className="min-h-[40px] w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-xs text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                    Subject
                  </label>
                  <select
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="min-h-[40px] w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-xs text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
                  >
                    {LIBRARY_SUBJECTS.map((subj) => (
                      <option key={subj} value={subj}>
                        {subj}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                  Cover Style
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {Object.values(COVER_TEMPLATES).map((tpl) => {
                    const active = coverTemplate === tpl.id;
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => setCoverTemplate(tpl.id)}
                        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-[11px] font-medium transition-colors ${
                          active
                            ? 'border-[var(--df-text)] bg-[var(--df-surface-hover)] text-[var(--df-text)]'
                            : 'border-[var(--df-border)] bg-[var(--df-bg)] text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
                        }`}
                      >
                        <span
                          className="h-3 w-3 shrink-0 rounded-sm border border-black/20"
                          style={{ backgroundColor: tpl.bgPrimary }}
                        />
                        <span className="truncate">{tpl.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                  Short Description
                </label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
                />
              </div>

              {analysisResult && (
                <p className="text-xs text-[var(--df-text-muted)]">
                  <span className="font-mono tabular-nums font-medium text-[var(--df-text)]">
                    {analysisResult.totalPages} pages
                  </span>
                  <span aria-hidden="true"> · </span>
                  <span className="font-mono tabular-nums font-medium text-[var(--df-text)]">
                    {analysisResult.topics.length} topics indexed
                  </span>
                  {analysisResult.analysisNote && (
                    <span className="mt-1 block text-[11px] text-[var(--df-text-subtle)]">
                      {analysisResult.analysisNote}
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Footer Actions */}
        <div className="mt-6 flex items-center justify-end gap-2 border-t border-[var(--df-border)] pt-4">
          <button
            type="button"
            onClick={handleClose}
            className="min-h-[40px] rounded-xl border border-[var(--df-border)] px-4 text-xs font-medium text-[var(--df-text-muted)] transition-colors hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSaveResource}
            disabled={!isReadyToSave || isSaving || Boolean(analysisProgress)}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[var(--df-cta)] px-5 text-xs font-semibold text-[var(--df-cta-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <BiIcon name="check2-circle" />
            <span>{isSaving ? 'Saving resource…' : 'Save to Library'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
