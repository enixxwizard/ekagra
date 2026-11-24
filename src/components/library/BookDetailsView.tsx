import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import {
  downloadGeneratedCoverPng,
  downloadLocalLibraryPdf,
  openLocalPdfForReader,
  updateLibraryResourceApi,
  uploadLibraryCoverPngApi,
} from '../../services/libraryService';
import type {
  LibraryCoverTemplateId,
  LibraryResource,
  LibraryTopic,
} from '../../types/library';
import { COVER_TEMPLATES, LIBRARY_SUBJECTS } from '../../utils/libraryCoverGenerator';
import {
  runLocalOcrOnPdf,
  type LibraryPdfAnalysisProgress,
} from '../../utils/libraryPdfAnalyzer';
import { BiIcon } from '../ui/BiIcon';
import { BookCoverArtwork } from './BookCoverArtwork';

interface BookDetailsViewProps {
  resource: LibraryResource;
  onBack: () => void;
  onOpenReader: (resource: LibraryResource, startPage?: number) => void;
  onResourceUpdated: (updated: LibraryResource) => void;
  onDeleteResource: (resourceId: string) => Promise<void>;
}

export const BookDetailsView: React.FC<BookDetailsViewProps> = ({
  resource,
  onBack,
  onOpenReader,
  onResourceUpdated,
  onDeleteResource,
}) => {
  const { status: authStatus, session } = useAuth();
  const isPdf = resource.resourceType === 'pdf';
  const totalPages = resource.totalPages ?? 0;
  const clampedLastPage =
    isPdf && totalPages > 0
      ? Math.max(1, Math.min(resource.lastReadPage || 1, totalPages))
      : resource.lastReadPage || 1;

  // Book metadata edit state
  const [isEditingBook, setIsEditingBook] = useState(false);
  const [editTitle, setEditTitle] = useState(resource.title);
  const [editSubtitle, setEditSubtitle] = useState(resource.subtitle);
  const [editSubject, setEditSubject] = useState(resource.subject);
  const [editDescription, setEditDescription] = useState(resource.description);
  const [editTemplate, setEditTemplate] = useState<LibraryCoverTemplateId>(resource.coverTemplate);
  const [savingBook, setSavingBook] = useState(false);

  // Two-step delete confirmation (no window.confirm)
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletingBook, setDeletingBook] = useState(false);

  // Optional free local OCR state
  const [ocrProgress, setOcrProgress] = useState<LibraryPdfAnalysisProgress | null>(null);
  const [ocrError, setOcrError] = useState('');

  // Manual Topic add/edit state
  const [addingTopic, setAddingTopic] = useState(false);
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [topicTitleInput, setTopicTitleInput] = useState('');
  const [topicStartInput, setTopicStartInput] = useState('');
  const [topicEndInput, setTopicEndInput] = useState('');
  const [savingTopics, setSavingTopics] = useState(false);
  const [actionError, setActionError] = useState('');

  const authCreds = {
    accessToken: session?.access_token ?? null,
    isGuest: authStatus === 'guest',
  };

  const handleSaveBookEdits = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTitle.trim()) return;
    setSavingBook(true);
    setActionError('');
    try {
      const updated = await updateLibraryResourceApi(authCreds, resource.id, {
        title: editTitle.trim(),
        subtitle: editSubtitle.trim(),
        subject: editSubject.trim() || 'General Studies',
        description: editDescription.trim(),
        coverTemplate: editTemplate,
      });

      const withCover = await uploadLibraryCoverPngApi(authCreds, resource.id, {
        title: updated.title,
        subtitle: updated.subtitle,
        subject: updated.subject,
        templateId: updated.coverTemplate,
        totalPages: updated.totalPages,
      }).catch(() => updated);

      onResourceUpdated(withCover);
      setIsEditingBook(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to save book changes.');
    } finally {
      setSavingBook(false);
    }
  };

  const handleRunOcr = async () => {
    if (!isPdf) return;
    setOcrError('');
    setOcrProgress({
      stage: 'ocr',
      currentPage: 0,
      totalPages: Math.min(totalPages || 18, 18),
      percent: 2,
      message: 'Preparing local OCR engine…',
    });

    try {
      const rangeSource = await openLocalPdfForReader(resource.id);
      const ocrResult = await runLocalOcrOnPdf(rangeSource, {
        maxPagesToScan: 18,
        onProgress: (prog) => setOcrProgress(prog),
      });
      setOcrProgress(null);

      const updated = await updateLibraryResourceApi(authCreds, resource.id, {
        topics: ocrResult.topics.length > 0 ? ocrResult.topics : resource.topics,
        analysisStatus: ocrResult.topics.length > 0 ? 'ocr_partial' : 'scanned_needs_ocr',
        analysisNote: ocrResult.note,
      });
      onResourceUpdated(updated);
    } catch (err) {
      setOcrProgress(null);
      setOcrError(err instanceof Error ? err.message : 'Local OCR failed.');
    }
  };

  const startEditTopic = (topic: LibraryTopic) => {
    setAddingTopic(false);
    setEditingTopicId(topic.id);
    setTopicTitleInput(topic.title);
    setTopicStartInput(topic.startPage !== null ? String(topic.startPage) : '');
    setTopicEndInput(topic.endPage !== null ? String(topic.endPage) : '');
  };

  const startAddTopic = () => {
    setEditingTopicId(null);
    setAddingTopic(true);
    setTopicTitleInput('');
    setTopicStartInput('');
    setTopicEndInput('');
  };

  const cancelTopicForm = () => {
    setAddingTopic(false);
    setEditingTopicId(null);
    setTopicTitleInput('');
    setTopicStartInput('');
    setTopicEndInput('');
  };

  const handleSaveTopicForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = topicTitleInput.trim();
    if (!cleanTitle) return;

    const parsedStart = topicStartInput.trim() ? Number.parseInt(topicStartInput, 10) : null;
    const parsedEnd = topicEndInput.trim() ? Number.parseInt(topicEndInput, 10) : null;

    const validStart =
      parsedStart !== null && Number.isFinite(parsedStart) && parsedStart >= 1
        ? totalPages > 0
          ? Math.min(parsedStart, totalPages)
          : parsedStart
        : null;
    let validEnd =
      validStart !== null && parsedEnd !== null && Number.isFinite(parsedEnd) && parsedEnd >= 1
        ? totalPages > 0
          ? Math.min(parsedEnd, totalPages)
          : parsedEnd
        : validStart;
    if (validStart !== null && validEnd !== null && validEnd < validStart) {
      validEnd = validStart;
    }

    let nextTopics: LibraryTopic[];
    if (editingTopicId) {
      nextTopics = resource.topics.map((t) =>
        t.id === editingTopicId
          ? {
              ...t,
              title: cleanTitle,
              startPage: validStart,
              endPage: validEnd,
              verificationStatus: validStart !== null ? 'manual' : 'unverified',
            }
          : t
      );
    } else {
      const createdTopic: LibraryTopic = {
        id: `top_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        title: cleanTitle,
        startPage: validStart,
        endPage: validEnd,
        verificationStatus: validStart !== null ? 'manual' : 'unverified',
      };
      nextTopics = [...resource.topics, createdTopic];
    }

    nextTopics.sort((a, b) => {
      if (a.startPage === null && b.startPage === null) return 0;
      if (a.startPage === null) return 1;
      if (b.startPage === null) return -1;
      return a.startPage - b.startPage;
    });

    setSavingTopics(true);
    try {
      const updated = await updateLibraryResourceApi(authCreds, resource.id, {
        topics: nextTopics,
      });
      onResourceUpdated(updated);
      cancelTopicForm();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to save topic.');
    } finally {
      setSavingTopics(false);
    }
  };

  const handleDeleteTopic = async (topicId: string) => {
    setSavingTopics(true);
    try {
      const nextTopics = resource.topics.filter((t) => t.id !== topicId);
      const updated = await updateLibraryResourceApi(authCreds, resource.id, {
        topics: nextTopics,
      });
      onResourceUpdated(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to remove topic.');
    } finally {
      setSavingTopics(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Breadcrumb Back Link */}
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex min-h-[38px] items-center gap-1.5 text-xs font-medium text-[var(--df-text-muted)] transition-colors hover:text-[var(--df-text)]"
        >
          <BiIcon name="arrow-left" />
          <span>Back to My Library</span>
        </button>
      </div>

      {/* Main Split Details */}
      <div className="grid gap-8 md:grid-cols-[240px_1fr]">
        {/* Left Column: Generated Book Cover & Primary Reading Actions */}
        <div className="space-y-3">
          <div className="mx-auto w-48 md:w-full">
            <BookCoverArtwork
              title={isEditingBook ? editTitle : resource.title}
              subtitle={isEditingBook ? editSubtitle : resource.subtitle}
              subject={isEditingBook ? editSubject : resource.subject}
              templateId={isEditingBook ? editTemplate : resource.coverTemplate}
              totalPages={resource.totalPages}
              coverReference={isEditingBook ? null : resource.generatedCoverReference}
            />
          </div>

          {isPdf ? (
            <button
              type="button"
              onClick={() => onOpenReader(resource, clampedLastPage)}
              className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-[var(--df-cta)] px-4 text-xs font-semibold text-[var(--df-cta-fg)] transition-opacity hover:opacity-90"
            >
              <BiIcon name="book-half" />
              <span>
                {clampedLastPage > 1
                  ? `Continue Reading (p. ${clampedLastPage})`
                  : 'Open Book'}
              </span>
            </button>
          ) : (
            resource.originalUrl && (
              <a
                href={resource.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-[var(--df-cta)] px-4 text-xs font-semibold text-[var(--df-cta-fg)] transition-opacity hover:opacity-90"
              >
                <BiIcon name="box-arrow-up-right" />
                <span>Open Original Website</span>
              </a>
            )
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() =>
                void downloadGeneratedCoverPng(
                  {
                    title: resource.title,
                    subtitle: resource.subtitle,
                    subject: resource.subject,
                    templateId: resource.coverTemplate,
                    totalPages: resource.totalPages,
                  },
                  resource.title
                )
              }
              className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 text-[11px] font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)]"
            >
              <BiIcon name="image" />
              <span>Cover PNG</span>
            </button>

            {isPdf && (
              <button
                type="button"
                onClick={() =>
                  void downloadLocalLibraryPdf(
                    resource.id,
                    resource.originalFileName || `${resource.title}.pdf`
                  )
                }
                className="inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 text-[11px] font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)]"
              >
                <BiIcon name="download" />
                <span>Original PDF</span>
              </button>
            )}
          </div>
        </div>

        {/* Right Column: Title, Honest Metadata, Description & Topics Index */}
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--df-border)] pb-5">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-2xl font-semibold tracking-tight text-[var(--df-text)] sm:text-3xl">
                {resource.title}
              </h1>
              {resource.subtitle && (
                <p className="mt-1 text-sm text-[var(--df-text-muted)]">
                  {resource.subtitle}
                </p>
              )}

              <p className="mt-2.5 text-xs text-[var(--df-text-muted)]">
                <span className="font-medium text-[var(--df-text)]">{resource.subject}</span>
                {isPdf && totalPages > 0 ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="font-mono tabular-nums">{totalPages} pages</span>
                    <span aria-hidden="true"> · </span>
                    <span className="font-mono tabular-nums">
                      Reached page {clampedLastPage} of {totalPages}
                    </span>
                  </>
                ) : (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span>External Resource Link</span>
                  </>
                )}
              </p>

              {resource.description && (
                <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--df-text)]">
                  {resource.description}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setEditTitle(resource.title);
                  setEditSubtitle(resource.subtitle);
                  setEditSubject(resource.subject);
                  setEditDescription(resource.description);
                  setEditTemplate(resource.coverTemplate);
                  setIsEditingBook((v) => !v);
                }}
                className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 text-xs font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)]"
              >
                <BiIcon name="pencil" />
                <span>{isEditingBook ? 'Close Editor' : 'Edit'}</span>
              </button>

              {!confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  aria-label="Delete book"
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 text-xs font-medium text-[var(--df-text-muted)] transition-colors hover:border-red-500/40 hover:text-red-500"
                >
                  <BiIcon name="trash3" />
                  <span>Delete</span>
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={deletingBook}
                    onClick={async () => {
                      setDeletingBook(true);
                      await onDeleteResource(resource.id);
                    }}
                    className="inline-flex min-h-[38px] items-center rounded-xl bg-red-600 px-3 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {deletingBook ? 'Deleting…' : 'Confirm Delete'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="inline-flex min-h-[38px] items-center rounded-xl border border-[var(--df-border)] px-2.5 text-xs text-[var(--df-text-muted)]"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>

          {actionError && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-500">
              {actionError}
            </div>
          )}

          {/* Edit Book Details Panel */}
          {isEditingBook && (
            <form
              onSubmit={handleSaveBookEdits}
              className="space-y-4 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-4 sm:p-5"
            >
              <h2 className="font-display text-sm font-semibold text-[var(--df-text)]">
                Edit Book &amp; Regenerate Cover
              </h2>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                    Title
                  </label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="min-h-[40px] w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-sm text-[var(--df-text)]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                    Subtitle
                  </label>
                  <input
                    type="text"
                    value={editSubtitle}
                    onChange={(e) => setEditSubtitle(e.target.value)}
                    className="min-h-[40px] w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-sm text-[var(--df-text)]"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                    Subject
                  </label>
                  <select
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    className="min-h-[40px] w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-xs text-[var(--df-text)]"
                  >
                    {LIBRARY_SUBJECTS.map((subj) => (
                      <option key={subj} value={subj}>
                        {subj}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                    Cover Template
                  </label>
                  <select
                    value={editTemplate}
                    onChange={(e) => setEditTemplate(e.target.value as LibraryCoverTemplateId)}
                    className="min-h-[40px] w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-xs text-[var(--df-text)]"
                  >
                    {Object.values(COVER_TEMPLATES).map((tpl) => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--df-text-muted)]">
                  Description
                </label>
                <textarea
                  rows={2}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)]"
                />
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditingBook(false)}
                  className="min-h-[38px] rounded-xl border border-[var(--df-border)] px-3.5 text-xs font-medium text-[var(--df-text-muted)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingBook || !editTitle.trim()}
                  className="min-h-[38px] rounded-xl bg-[var(--df-cta)] px-4 text-xs font-semibold text-[var(--df-cta-fg)] disabled:opacity-50"
                >
                  {savingBook ? 'Updating…' : 'Save & Regenerate Cover'}
                </button>
              </div>
            </form>
          )}

          {/* Topics Covered Index */}
          {isPdf && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-display text-base font-semibold text-[var(--df-text)]">
                    Topics Covered
                  </h2>
                  {resource.analysisNote && (
                    <p className="mt-0.5 text-xs text-[var(--df-text-muted)]">
                      {resource.analysisNote}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {(resource.analysisStatus === 'scanned_needs_ocr' ||
                    resource.topics.length === 0) && (
                    <button
                      type="button"
                      onClick={() => void handleRunOcr()}
                      disabled={Boolean(ocrProgress)}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 text-xs font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)] disabled:opacity-50"
                    >
                      <BiIcon name="magic" />
                      <span>{ocrProgress ? 'Scanning…' : 'Run Free Local OCR'}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={startAddTopic}
                    className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 text-xs font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)]"
                  >
                    <BiIcon name="plus-lg" />
                    <span>Add Topic</span>
                  </button>
                </div>
              </div>

              {ocrProgress && (
                <div className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] p-3.5">
                  <div className="flex items-center justify-between text-xs font-medium text-[var(--df-text)]">
                    <span>{ocrProgress.message}</span>
                    <span className="font-mono tabular-nums">{ocrProgress.percent}%</span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--df-border)]">
                    <div
                      className="h-full rounded-full bg-[var(--df-accent)] transition-all"
                      style={{ width: `${ocrProgress.percent}%` }}
                    />
                  </div>
                </div>
              )}

              {ocrError && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-500">
                  {ocrError}
                </div>
              )}

              {/* Add / Edit Topic Form */}
              {(addingTopic || editingTopicId) && (
                <form
                  onSubmit={handleSaveTopicForm}
                  className="grid gap-3 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] p-4 sm:grid-cols-[1fr_96px_96px_auto]"
                >
                  <input
                    type="text"
                    value={topicTitleInput}
                    onChange={(e) => setTopicTitleInput(e.target.value)}
                    placeholder="Topic title (e.g., Operators in Java)"
                    className="min-h-[38px] rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-xs text-[var(--df-text)]"
                  />
                  <input
                    type="number"
                    min={1}
                    max={totalPages || undefined}
                    value={topicStartInput}
                    onChange={(e) => setTopicStartInput(e.target.value)}
                    placeholder="Start pg"
                    className="min-h-[38px] rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 font-mono text-xs text-[var(--df-text)]"
                  />
                  <input
                    type="number"
                    min={1}
                    max={totalPages || undefined}
                    value={topicEndInput}
                    onChange={(e) => setTopicEndInput(e.target.value)}
                    placeholder="End pg"
                    className="min-h-[38px] rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 font-mono text-xs text-[var(--df-text)]"
                  />
                  <div className="flex items-center gap-1.5">
                    <button
                      type="submit"
                      disabled={savingTopics || !topicTitleInput.trim()}
                      className="min-h-[38px] rounded-xl bg-[var(--df-cta)] px-3.5 text-xs font-semibold text-[var(--df-cta-fg)] disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={cancelTopicForm}
                      className="min-h-[38px] rounded-xl border border-[var(--df-border)] px-3 text-xs text-[var(--df-text-muted)]"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {/* Topics Table / List */}
              {resource.topics.length === 0 ? (
                <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5 text-xs leading-relaxed text-[var(--df-text-muted)]">
                  No verified topics have been indexed yet. Open the book to read any page directly, or add topic page ranges manually as you study.
                </div>
              ) : (
                <div className="divide-y divide-[var(--df-border)] overflow-hidden rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)]">
                  {resource.topics.map((topic) => (
                    <div
                      key={topic.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[var(--df-surface-hover)]"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--df-text)]">
                          {topic.title}
                        </p>
                        <p className="mt-0.5 font-mono text-xs tabular-nums text-[var(--df-text-muted)]">
                          {topic.startPage !== null ? (
                            topic.endPage && topic.endPage !== topic.startPage ? (
                              <>Pages {topic.startPage}–{topic.endPage}</>
                            ) : (
                              <>Page {topic.startPage}</>
                            )
                          ) : (
                            <span className="font-sans text-[var(--df-text-subtle)]">
                              Page range not verified yet
                            </span>
                          )}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {topic.startPage !== null && (
                          <button
                            type="button"
                            onClick={() => onOpenReader(resource, topic.startPage ?? 1)}
                            className="inline-flex min-h-[34px] items-center gap-1.5 rounded-xl border border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] px-3 text-xs font-medium text-[var(--df-accent-soft-fg)] transition-opacity hover:opacity-90"
                          >
                            <BiIcon name="book" />
                            <span>Read Topic</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => startEditTopic(topic)}
                          aria-label={`Edit ${topic.title}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs text-[var(--df-text-muted)] hover:bg-[var(--df-bg)] hover:text-[var(--df-text)]"
                        >
                          <BiIcon name="pencil" />
                        </button>
                        <button
                          type="button"
                          disabled={savingTopics}
                          onClick={() => void handleDeleteTopic(topic.id)}
                          aria-label={`Delete ${topic.title}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs text-[var(--df-text-muted)] hover:bg-[var(--df-bg)] hover:text-red-500"
                        >
                          <BiIcon name="x-lg" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
