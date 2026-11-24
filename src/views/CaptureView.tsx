import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SmartPdfImportPreview } from '../components/capture/SmartPdfImportPreview';
import { BiIcon } from '../components/ui/BiIcon';
import { useDayFlow } from '../context/DayFlowContext';
import { useAuth } from '../hooks/useAuth';
import { buildAuthHeaders } from '../services/aiBrainService';
import {
  createLibraryResourceApi,
  deleteLibraryResourceApi,
  findDuplicateLibraryResource,
  uploadLibraryCoverPngApi,
  uploadLibraryPdfFileApi,
} from '../services/libraryService';
import {
  checkStorageHeadroom,
  StorageQuotaError,
  validatePdfFileHeader,
} from '../services/storage/blobStore';
import {
  ActivityCategory,
  PdfExtractedQuotation,
  QuickNote,
  StudyQuotation,
} from '../types/dayflow';
import type {
  PdfPageImagePayload,
  StructuredPdfPlan,
} from '../types/pdfSchedule';
import {
  getTodayISO,
  minutesToTime24,
  parseTimeToMinutes,
} from '../utils/dateTime';
import {
  evaluateSchedulePdfPlan,
  extractAndValidateIntelligentSchedule,
  type IntelligentScheduleEvaluation,
} from '../utils/intelligentScheduleValidator';
import { analyzePdfForLibrary } from '../utils/libraryPdfAnalyzer';
import {
  ExtractedPdfPage,
  extractPdfPages,
  PdfTextExtractionResult,
  renderPdfPagesAsImages,
} from '../utils/pdfExtractor';
import { resolveActivitiesForDate } from '../utils/recurrence';
import { findAvailableSlots } from '../utils/scheduler';

const CATEGORIES: ActivityCategory[] = [
  'Study',
  'Work',
  'Deep Focus',
  'Health',
  'Personal',
  'Admin',
];

type CaptureTab = 'pdf' | 'notes';

function extractPdfFileFromClipboard(clipboardData: DataTransfer | null): {
  pdfFile: File | null;
  hasTextOnly: boolean;
} {
  if (!clipboardData) return { pdfFile: null, hasTextOnly: false };

  const files = Array.from(clipboardData.files ?? []);
  for (const file of files) {
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      return { pdfFile: file, hasTextOnly: false };
    }
  }

  const items = Array.from(clipboardData.items ?? []);
  for (const item of items) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f && (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))) {
        return { pdfFile: f, hasTextOnly: false };
      }
    }
  }

  const plainText = clipboardData.getData('text/plain')?.trim() ?? '';
  return { pdfFile: null, hasTextOnly: plainText.length > 0 || files.length > 0 };
}

export const CaptureView: React.FC = () => {
  const { status: authStatus, session } = useAuth();
  const {
    state,
    pendingPdfPickerOpen,
    consumePendingPdfPickerOpen,
    saveNote,
    deleteNote,
    saveQuotation,
    deleteQuotation,
    importStructuredPdfPlan,
    syncStructuredPdfPlan,
    setActivePage,
    openQuickActivitySheet,
    pushToast,
  } = useDayFlow();

  const authCreds = useMemo(
    () => ({
      accessToken: session?.access_token ?? null,
      isGuest: authStatus !== 'authenticated' || !session?.access_token,
    }),
    [session?.access_token, authStatus]
  );

  const todayISO = getTodayISO();
  const timeFormat = state.settings.timeFormat;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cachedPlansRef = useRef<Map<string, StructuredPdfPlan>>(new Map());

  const [activeTab, setActiveTab] = useState<CaptureTab>('pdf');
  const [isDraggingPdf, setIsDraggingPdf] = useState(false);

  // Intelligent PDF extraction, validation & sync state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pdfExtracting, setPdfExtracting] = useState(false);
  const [pdfExtraction, setPdfExtraction] = useState<PdfTextExtractionResult | null>(null);
  const [pdfError, setPdfError] = useState('');
  const [structuredPlan, setStructuredPlan] = useState<StructuredPdfPlan | null>(null);
  const [scheduleEvaluation, setScheduleEvaluation] =
    useState<IntelligentScheduleEvaluation | null>(null);
  const [extractedQuotes, setExtractedQuotes] = useState<PdfExtractedQuotation[]>([]);
  const [includeMultimodalSnapshots, setIncludeMultimodalSnapshots] = useState(false);
  const [autoSyncedSummary, setAutoSyncedSummary] = useState<string | null>(null);

  // Optional Gemini server-side scan state
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [aiError, setAiError] = useState('');

  // Rejection -> Save to EKAGRA Library bridge state
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [savedToLibraryId, setSavedToLibraryId] = useState<string | null>(null);
  const [librarySaveError, setLibrarySaveError] = useState('');

  // Quick notes & quotations library state
  const [searchQuery, setSearchQuery] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [noteCategory, setNoteCategory] = useState<ActivityCategory>('Study');
  const [noteLink, setNoteLink] = useState('');
  const [noteSaveFeedback, setNoteSaveFeedback] = useState('');

  // Handle "Import PDF" shortcut coming from Plan screen
  useEffect(() => {
    if (pendingPdfPickerOpen) {
      setActiveTab('pdf');
      consumePendingPdfPickerOpen();
      window.setTimeout(() => {
        fileInputRef.current?.click();
      }, 60);
    }
  }, [pendingPdfPickerOpen, consumePendingPdfPickerOpen]);

  const requestGeminiPlan = useCallback(
    async (
      extraction: PdfTextExtractionResult,
      sourceFile: File | null,
      forceMultimodal: boolean
    ): Promise<StructuredPdfPlan> => {
      const useMultimodal =
        forceMultimodal || includeMultimodalSnapshots || extraction.isScannedOrEmpty;
      const cacheKey = `${extraction.documentHash}::${useMultimodal ? 'mm' : 'txt'}`;
      const clientCached = cachedPlansRef.current.get(cacheKey);
      if (clientCached) {
        return { ...clientCached, cached: true };
      }

      let pageImages: PdfPageImagePayload[] = [];
      if (useMultimodal && sourceFile) {
        pageImages = await renderPdfPagesAsImages(sourceFile, 4);
      }

      if (extraction.isScannedOrEmpty && pageImages.length === 0) {
        throw new Error('Could not render page snapshots from this scanned PDF.');
      }

      const res = await fetch('/api/pdf/analyze', {
        method: 'POST',
        headers: buildAuthHeaders(authCreds),
        body: JSON.stringify({
          fileName: extraction.fileName,
          documentHash: extraction.documentHash,
          referenceDate: todayISO,
          pages: extraction.pages as ExtractedPdfPage[],
          pageImages,
        }),
      });

      const contentType = res.headers.get('content-type') ?? '';
      const rawText = await res.text().catch(() => '');
      const trimmed = rawText.trim();
      const isHtml =
        contentType.includes('text/html') || /^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);

      let data: (StructuredPdfPlan & { error?: string }) | null = null;
      if (trimmed && !isHtml) {
        try {
          data = JSON.parse(trimmed) as StructuredPdfPlan & { error?: string };
        } catch {
          data = null;
        }
      }

      if (!res.ok) {
        throw new Error(
          data?.error ||
            (res.status === 503 || res.status === 502 || res.status === 504
              ? 'AI service temporarily unavailable. Please retry in a moment.'
              : `Gemini analysis failed (HTTP ${res.status}).`)
        );
      }

      if (!data || isHtml) {
        throw new Error('AI analysis received an unexpected non-JSON response. Please retry.');
      }

      cachedPlansRef.current.set(cacheKey, data);
      return data;
    },
    [authCreds, includeMultimodalSnapshots, todayISO]
  );

  const maybeAutoSyncPlan = useCallback(
    async (
      plan: StructuredPdfPlan,
      evaluation: IntelligentScheduleEvaluation
    ): Promise<boolean> => {
      if (!state.settings.autoSyncPdfSchedule || !evaluation.canAutoSync) {
        return false;
      }

      const { commit } = await syncStructuredPdfPlan(plan);
      if (commit.status === 'synced' && commit.persisted) {
        const parts = [
          commit.activitiesAdded > 0
            ? `${commit.activitiesAdded} ${
                commit.recurringRulesAdded > 0 ? 'recurring/scheduled' : 'scheduled'
              } ${commit.activitiesAdded === 1 ? 'activity' : 'activities'}`
            : null,
          commit.notesAdded > 0
            ? `${commit.notesAdded} roadmap ${commit.notesAdded === 1 ? 'note' : 'notes'}`
            : null,
          commit.tasksAdded > 0
            ? `${commit.tasksAdded} ${commit.tasksAdded === 1 ? 'deadline' : 'deadlines'}`
            : null,
        ].filter(Boolean);
        const summary =
          parts.length > 0
            ? `Auto-synced ${parts.join(', ')}${
                commit.duplicatesSkipped > 0 ? ` · ${commit.duplicatesSkipped} duplicates skipped` : ''
              }.`
            : 'Schedule synced automatically.';
        setAutoSyncedSummary(summary);
        pushToast({
          type: commit.conflictsCount > 0 ? 'warning' : 'success',
          title: evaluation.statusMessage,
          description: summary,
        });
        return true;
      }

      if (commit.status === 'duplicates_only') {
        const dupMsg = `All entries from "${plan.fileName}" already exist in your schedule.`;
        setAutoSyncedSummary(dupMsg);
        pushToast({
          type: 'info',
          title: 'Schedule already synced',
          description: dupMsg,
        });
        return true;
      }

      if (commit.status === 'error') {
        pushToast({
          type: 'error',
          title: 'Auto-sync failed',
          description: commit.error || 'Review and confirm manually below.',
        });
      }

      return false;
    },
    [state.settings.autoSyncPdfSchedule, syncStructuredPdfPlan, pushToast]
  );

  const handleFilePicked = useCallback(
    async (file: File | null) => {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        setPdfError('Please select or paste a valid .pdf file.');
        return;
      }

      const validPdfHeader = await validatePdfFileHeader(file).catch(() => false);
      if (!validPdfHeader) {
        setPdfError('This file does not appear to be a valid PDF document.');
        return;
      }

      setSelectedFile(file);
      setPdfError('');
      setAiError('');
      setPdfExtracting(true);
      setPdfExtraction(null);
      setStructuredPlan(null);
      setScheduleEvaluation(null);
      setAutoSyncedSummary(null);
      setSavedToLibraryId(null);
      setLibrarySaveError('');
      setExtractedQuotes([]);

      try {
        const result = await extractPdfPages(file);
        setPdfExtraction(result);
        setIncludeMultimodalSnapshots(result.isScannedOrEmpty || result.hasComplexTables);

        if (result.isScannedOrEmpty) {
          const emptyEval: IntelligentScheduleEvaluation = {
            accepted: false,
            statusCode: 'rejected_unusable',
            statusMessage: 'Study resource detected — save to Library.',
            scheduleTypeLabel: 'Scanned or Unreadable PDF',
            startDate: null,
            endDate: null,
            dateRangeProvenance: null,
            hasInferredDates: false,
            recurringWeekdays: [],
            weeklyStudyMinutes: 0,
            optionalWeeklyMinutes: 0,
            weeklyStudyHoursLabel: '0h',
            missingInformation: [
              'No selectable schedule text was found in this PDF. Try Gemini Multimodal Scan or save it to EKAGRA Library.',
            ],
            clarificationReasons: [],
            conflictsCount: 0,
            conflictSummaries: [],
            conflictMessages: [],
            canAutoSync: false,
          };
          setScheduleEvaluation(emptyEval);
          pushToast({
            type: 'warning',
            title: 'No readable schedule text found',
            description: 'Try Gemini Multimodal Scan below or save this PDF to EKAGRA Library.',
          });
          return;
        }

        const { plan, evaluation } = extractAndValidateIntelligentSchedule(
          result,
          state.activities,
          todayISO
        );
        setScheduleEvaluation(evaluation);

        if (evaluation.accepted) {
          setStructuredPlan(plan);
          setExtractedQuotes(plan.quotations ?? []);
          const didAutoSync = await maybeAutoSyncPlan(plan, evaluation);
          if (!didAutoSync) {
            pushToast({
              type:
                evaluation.statusCode === 'start_date_required' ||
                evaluation.statusCode === 'conflicts_detected'
                  ? 'warning'
                  : 'info',
              title: evaluation.statusMessage,
              description:
                evaluation.clarificationReasons[0] ??
                evaluation.missingInformation[0] ??
                evaluation.conflictMessages[0] ??
                `${evaluation.scheduleTypeLabel} ready to review and confirm.`,
            });
          }
        } else {
          setStructuredPlan(null);
          pushToast({
            type: 'warning',
            title: evaluation.statusMessage,
            description:
              evaluation.missingInformation[0] ??
              'This PDF looks like study notes or reference material rather than a schedule.',
          });
        }
      } catch (err) {
        setPdfError(
          err instanceof Error
            ? err.message
            : 'Could not read this PDF file. Please verify it is not password-protected or corrupted.'
        );
      } finally {
        setPdfExtracting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [state.activities, todayISO, maybeAutoSyncPlan, pushToast]
  );

  // Support clipboard paste of .pdf files when PDF tab is active; reject pasted plain text as non-PDF
  useEffect(() => {
    if (activeTab !== 'pdf') return;

    const handleWindowPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      const { pdfFile, hasTextOnly } = extractPdfFileFromClipboard(e.clipboardData);

      if (pdfFile) {
        e.preventDefault();
        void handleFilePicked(pdfFile);
        return;
      }

      if (!isEditable && hasTextOnly) {
        e.preventDefault();
        setPdfError(
          'Pasted text is not a PDF file. Paste or upload a .pdf file to import a schedule.'
        );
      }
    };

    window.addEventListener('paste', handleWindowPaste);
    return () => window.removeEventListener('paste', handleWindowPaste);
  }, [activeTab, handleFilePicked]);

  const handleDropzonePaste = (e: React.ClipboardEvent<HTMLElement>) => {
    const { pdfFile, hasTextOnly } = extractPdfFileFromClipboard(e.clipboardData);
    if (pdfFile) {
      e.preventDefault();
      e.stopPropagation();
      void handleFilePicked(pdfFile);
      return;
    }
    if (hasTextOnly) {
      e.preventDefault();
      e.stopPropagation();
      setPdfError(
        'Pasted text is not a PDF file. Paste or upload a .pdf file to import a schedule.'
      );
    }
  };

  const handleAnalyzeWithGemini = async (forceMultimodal = false) => {
    if (!pdfExtraction) return;
    setAiAnalyzing(true);
    setAiError('');
    setAutoSyncedSummary(null);

    try {
      const data = await requestGeminiPlan(pdfExtraction, selectedFile, forceMultimodal);
      const evaluation = evaluateSchedulePdfPlan(data, {
        existingActivities: state.activities,
        referenceDateISO: todayISO,
      });
      setScheduleEvaluation(evaluation);

      if (evaluation.accepted) {
        setStructuredPlan(data);
        setExtractedQuotes(data.quotations ?? []);
        const didAutoSync = await maybeAutoSyncPlan(data, evaluation);
        if (!didAutoSync) {
          pushToast({
            type:
              evaluation.statusCode === 'start_date_required' ||
              evaluation.statusCode === 'conflicts_detected'
                ? 'warning'
                : 'info',
            title: evaluation.statusMessage,
            description:
              evaluation.clarificationReasons[0] ??
              evaluation.missingInformation[0] ??
              `${evaluation.scheduleTypeLabel} analyzed via Gemini AI.`,
          });
        }
      } else {
        setStructuredPlan(null);
        pushToast({
          type: 'warning',
          title: evaluation.statusMessage,
          description:
            evaluation.missingInformation[0] ??
            'Gemini classified this document as study material rather than a schedule.',
        });
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unable to reach Gemini analysis endpoint.');
    } finally {
      setAiAnalyzing(false);
    }
  };

  const handleSaveRejectedPdfToLibrary = async () => {
    if (!selectedFile || savingToLibrary || savedToLibraryId) return;
    setSavingToLibrary(true);
    setLibrarySaveError('');

    let createdId: string | null = null;
    try {
      const hasValidHeader = await validatePdfFileHeader(selectedFile).catch(() => false);
      if (!hasValidHeader) {
        throw new Error('This file does not appear to be a valid PDF document.');
      }

      const headroom = await checkStorageHeadroom(selectedFile.size);
      if (!headroom.ok) {
        throw new StorageQuotaError('Storage space is insufficient.');
      }

      const { duplicate, fileHash } = await findDuplicateLibraryResource(selectedFile);
      if (duplicate) {
        setSavedToLibraryId(duplicate.id);
        pushToast({
          type: 'info',
          title: 'Already in Library',
          description: `"${duplicate.title}" is already saved on your bookshelf.`,
        });
        return;
      }

      const analyzed = await analyzePdfForLibrary(selectedFile, selectedFile.name);
      const created = await createLibraryResourceApi(authCreds, {
        title: analyzed.title,
        subtitle: analyzed.subtitle,
        subject: analyzed.subject || 'General Studies',
        description: analyzed.description,
        resourceType: 'pdf',
        originalFileName: selectedFile.name,
        originalFileSize: selectedFile.size,
        fileHash,
        coverTemplate: analyzed.coverTemplate,
        totalPages: analyzed.totalPages,
        topics: analyzed.topics,
        lastReadPage: 1,
        analysisStatus: analyzed.analysisStatus,
        analysisNote: analyzed.analysisNote,
      });
      createdId = created.id;

      const withPdf = await uploadLibraryPdfFileApi(
        authCreds,
        created.id,
        selectedFile,
        selectedFile.name
      );

      await uploadLibraryCoverPngApi(authCreds, created.id, {
        title: analyzed.title,
        subtitle: analyzed.subtitle,
        subject: analyzed.subject || 'General Studies',
        templateId: analyzed.coverTemplate,
        totalPages: analyzed.totalPages,
      }).catch(() => withPdf);

      setSavedToLibraryId(created.id);
      pushToast({
        type: 'success',
        title: 'Saved to EKAGRA Library',
        description: `"${analyzed.title}" is now on your bookshelf.`,
      });
    } catch (err) {
      if (createdId) {
        await deleteLibraryResourceApi(authCreds, createdId).catch(() => undefined);
      }
      const msg =
        err instanceof StorageQuotaError
          ? 'Storage space is insufficient.'
          : err instanceof Error
          ? err.message
          : 'Could not save this PDF to your Library.';
      setLibrarySaveError(msg);
      pushToast({
        type: 'error',
        title: 'Could not save to Library',
        description: msg,
      });
    } finally {
      setSavingToLibrary(false);
    }
  };

  const handleSaveExtractedQuote = (q: PdfExtractedQuotation) => {
    saveQuotation({
      text: q.text,
      sourceFile: q.sourceFile,
      pageNumber: q.pageNumber,
      category: q.category,
      fingerprint: q.fingerprint,
    });
    setExtractedQuotes((prev) =>
      prev.map((item) => (item.id === q.id ? { ...item, saved: true } : item))
    );
    pushToast({
      type: 'success',
      title: 'Quotation saved',
      description: `From ${q.sourceFile} · p. ${q.pageNumber}`,
    });
  };

  const handleSaveExtractedQuoteAsNote = (q: PdfExtractedQuotation) => {
    saveNote({
      title: `${q.sourceFile} (p. ${q.pageNumber})`,
      content: q.text,
      category: q.category,
    });
    pushToast({
      type: 'success',
      title: 'Saved as Quick Note',
      description: 'Added to your searchable Capture notes.',
    });
  };

  const handleScheduleQuotation = (
    text: string,
    sourceLabel: string,
    category: ActivityCategory = 'Study'
  ) => {
    const existingToday = resolveActivitiesForDate(state.activities, todayISO);
    const slots = findAvailableSlots(existingToday, todayISO, 30, 8, 22);
    const firstSlot = slots[0];
    const start = firstSlot ? firstSlot.startTime : '16:00';
    const end = minutesToTime24(Math.min(23 * 60 + 45, parseTimeToMinutes(start) + 45));
    const snippet = text.trim().slice(0, 56);

    openQuickActivitySheet({
      initialDate: todayISO,
      initialStartTime: start,
      initialEndTime: end,
      initialTitle: `Review: ${snippet}${text.trim().length > 56 ? '...' : ''}`,
      initialDescription: `"${text.trim()}" — ${sourceLabel}`,
      initialCategory: category,
    });
  };

  // Auto-save note edits when editing an existing note in Capture library
  const parseNoteLink = (val: string) => {
    if (val.startsWith('activity:')) {
      return { linkedActivityId: val.slice(9), linkedTaskId: null, linkedFocusSessionId: null };
    }
    if (val.startsWith('task:')) {
      return { linkedActivityId: null, linkedTaskId: val.slice(5), linkedFocusSessionId: null };
    }
    if (val.startsWith('session:')) {
      return { linkedActivityId: null, linkedTaskId: null, linkedFocusSessionId: val.slice(8) };
    }
    return { linkedActivityId: null, linkedTaskId: null, linkedFocusSessionId: null };
  };

  useEffect(() => {
    if (!editingNoteId) return;
    if (!noteTitle.trim() && !noteContent.trim()) return;
    setNoteSaveFeedback('Saving...');
    const t = window.setTimeout(() => {
      saveNote({
        id: editingNoteId,
        title: noteTitle || 'Untitled note',
        content: noteContent,
        category: noteCategory,
        ...parseNoteLink(noteLink),
      });
      setNoteSaveFeedback('Saved locally');
    }, 350);
    return () => window.clearTimeout(t);
  }, [editingNoteId, noteTitle, noteContent, noteCategory, noteLink, saveNote]);

  const handleSubmitNewNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteTitle.trim() && !noteContent.trim()) return;
    const saved = saveNote({
      id: editingNoteId ?? undefined,
      title: noteTitle || 'Quick note',
      content: noteContent,
      category: noteCategory,
      ...parseNoteLink(noteLink),
    });
    setEditingNoteId(null);
    setNoteTitle('');
    setNoteContent('');
    setNoteLink('');
    setNoteSaveFeedback('');
    pushToast({
      type: 'success',
      title: editingNoteId ? 'Note updated' : 'Note saved',
      description: saved.title || 'Saved to Capture',
    });
  };

  const handleLoadNoteForEdit = (note: QuickNote) => {
    setEditingNoteId(note.id);
    setNoteTitle(note.title);
    setNoteContent(note.content);
    setNoteCategory(note.category);
    if (note.linkedActivityId) setNoteLink(`activity:${note.linkedActivityId}`);
    else if (note.linkedTaskId) setNoteLink(`task:${note.linkedTaskId}`);
    else if (note.linkedFocusSessionId) setNoteLink(`session:${note.linkedFocusSessionId}`);
    else setNoteLink('');
    setNoteSaveFeedback('Editing (auto-saves)');
  };

  const resolveLinkLabel = (note: QuickNote): string | null => {
    if (note.linkedActivityId) {
      const act = state.activities.find((a) => a.id === note.linkedActivityId);
      return act ? `Activity: ${act.title}` : null;
    }
    if (note.linkedTaskId) {
      const t = state.tasks.find((task) => task.id === note.linkedTaskId);
      return t ? `Task: ${t.title}` : null;
    }
    if (note.linkedFocusSessionId) {
      const s = state.focusSessions.find((sess) => sess.id === note.linkedFocusSessionId);
      return s ? `Session: ${s.activityTitle || 'Deep Focus'} (${s.date})` : null;
    }
    return null;
  };

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return state.notes;
    return state.notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.category.toLowerCase().includes(q)
    );
  }, [state.notes, searchQuery]);

  const filteredQuotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return state.quotations;
    return state.quotations.filter(
      (quote) =>
        quote.text.toLowerCase().includes(q) ||
        quote.sourceFile.toLowerCase().includes(q) ||
        quote.category.toLowerCase().includes(q)
    );
  }, [state.quotations, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header + Clean Section Switch */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[var(--df-text)] sm:text-3xl">
            Capture
          </h1>
          <p className="mt-0.5 text-xs text-[var(--df-text-muted)]">
            Turn PDFs into scheduled blocks, or jot down notes &amp; study quotes.
          </p>
        </div>

        <div className="inline-flex items-center rounded-xl bg-[var(--df-surface-subtle)] p-1 self-start">
          <button
            type="button"
            onClick={() => setActiveTab('pdf')}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-4 text-xs font-semibold transition-colors whitespace-nowrap ${
              activeTab === 'pdf'
                ? 'bg-[var(--df-surface)] text-[var(--df-text)]'
                : 'text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
            }`}
          >
            <BiIcon name="file-earmark-arrow-up" className="text-sm" />
            PDF to Schedule
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('notes')}
            className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-4 text-xs font-semibold transition-colors whitespace-nowrap ${
              activeTab === 'notes'
                ? 'bg-[var(--df-surface)] text-[var(--df-text)]'
                : 'text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
            }`}
          >
            <BiIcon name="journal-text" className="text-sm" />
            Notes &amp; Quotes ({state.notes.length + state.quotations.length})
          </button>
        </div>
      </div>

      {/* SECTION A: PDF TO SCHEDULE */}
      {activeTab === 'pdf' && (
        <div className="space-y-6">
          {/* Intelligent Schedule Import Rules Notice */}
          <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] px-4 py-3 sm:flex-row sm:items-center">
            <div className="flex items-start gap-2.5 text-xs">
              <BiIcon
                name="calendar-check"
                className="mt-0.5 text-sm shrink-0 text-[var(--df-accent-soft-fg)]"
              />
              <span>
                <span className="font-semibold text-[var(--df-text)]">
                  Intelligent Schedule Importer
                </span>
                <span className="block text-[11px] text-[var(--df-text-muted)]">
                  Supports dated schedules, daily routines, recurring weekly timetables, hybrid multi-month plans, and learning roadmaps. Lecture notes, textbooks, and question papers can be saved directly to EKAGRA Library.
                </span>
              </span>
            </div>
          </div>

          {/* Upload Dropzone + Clipboard PDF Paste */}
          <section
            tabIndex={0}
            onPaste={handleDropzonePaste}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingPdf(true);
            }}
            onDragLeave={() => setIsDraggingPdf(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingPdf(false);
              handleFilePicked(e.dataTransfer.files?.[0] ?? null);
            }}
            className={`rounded-3xl border border-dashed p-6 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-accent)] ${
              isDraggingPdf
                ? 'border-[var(--df-accent)] bg-[var(--df-accent-soft)]'
                : 'border-[var(--df-border-strong)] bg-[var(--df-surface)]'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => handleFilePicked(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            <div className="mx-auto flex max-w-md flex-col items-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]">
                <BiIcon name="file-earmark-text" className="text-xl" />
              </div>
              <h2 className="mt-3 font-display text-lg font-bold text-[var(--df-text)]">
                Upload or paste a study schedule or roadmap PDF
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--df-text-muted)]">
                Drop, choose, or paste a <span className="font-mono">.pdf</span> timetable, weekly plan, daily routine, or roadmap. Complete schedules auto-sync; ambiguous ranges or conflicts wait for your confirmation.
              </p>

              <button
                type="button"
                disabled={pdfExtracting || aiAnalyzing}
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-2xl bg-[var(--df-accent)] px-5 text-sm font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98] disabled:opacity-60"
              >
                <BiIcon name="file-earmark-arrow-up" className="text-base" />
                {pdfExtracting
                  ? 'Reading & Analyzing PDF...'
                  : aiAnalyzing
                  ? 'Analyzing schedule...'
                  : 'Choose PDF file'}
              </button>

              {pdfError && (
                <p role="alert" className="mt-3 text-xs font-medium text-rose-600 dark:text-rose-400">
                  {pdfError}
                </p>
              )}
            </div>
          </section>

          {/* REJECTED STUDY RESOURCE CARD + SAVE TO EKAGRA LIBRARY BRIDGE */}
          {pdfExtraction && scheduleEvaluation && !scheduleEvaluation.accepted && (
            <section
              role="alert"
              className="space-y-4 rounded-3xl border border-amber-300 bg-amber-50/70 p-5 sm:p-6 dark:border-amber-900/50 dark:bg-amber-950/25"
            >
              <div className="flex items-start gap-3">
                <BiIcon
                  name="book-half"
                  className="mt-0.5 text-lg shrink-0 text-amber-700 dark:text-amber-300"
                />
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-[var(--df-text-muted)]">
                    {pdfExtraction.fileName}
                  </p>
                  <h3 className="text-sm font-bold leading-relaxed text-[var(--df-text)]">
                    {scheduleEvaluation.statusMessage}
                  </h3>
                  <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
                    {scheduleEvaluation.missingInformation[0] ??
                      'No recurring timetable, dated schedule, or learning roadmap milestones were found. Save this resource to EKAGRA Library instead.'}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                {selectedFile && !savedToLibraryId && (
                  <button
                    type="button"
                    disabled={savingToLibrary}
                    onClick={() => void handleSaveRejectedPdfToLibrary()}
                    className="inline-flex min-h-[42px] items-center gap-2 rounded-2xl bg-[var(--df-accent)] px-4 text-xs font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98] disabled:opacity-60"
                  >
                    <BiIcon
                      name={savingToLibrary ? 'arrow-repeat' : 'book'}
                      spin={savingToLibrary}
                      className="text-sm"
                    />
                    {savingToLibrary ? 'Saving to Library...' : 'Save to Library'}
                  </button>
                )}

                {savedToLibraryId && (
                  <button
                    type="button"
                    onClick={() => setActivePage('library')}
                    className="inline-flex min-h-[42px] items-center gap-2 rounded-2xl bg-[var(--df-accent)] px-4 text-xs font-semibold text-[var(--df-accent-fg)]"
                  >
                    <BiIcon name="journals" className="text-sm" />
                    Open in Library
                  </button>
                )}

                {(pdfExtraction.isScannedOrEmpty ||
                  scheduleEvaluation.statusCode === 'rejected_unusable') && (
                  <button
                    type="button"
                    disabled={aiAnalyzing}
                    onClick={() => void handleAnalyzeWithGemini(true)}
                    className="inline-flex min-h-[42px] items-center gap-1.5 rounded-2xl border border-[var(--df-border-strong)] bg-[var(--df-surface)] px-4 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-accent)] disabled:opacity-60"
                  >
                    <BiIcon name="stars" className="text-xs" />
                    {aiAnalyzing ? 'Scanning pages...' : 'Try Gemini Multimodal Scan'}
                  </button>
                )}
              </div>

              {savedToLibraryId && (
                <p className="text-xs font-semibold text-[var(--df-accent-soft-fg)]">
                  Saved to your EKAGRA Library bookshelf without modifying your calendar.
                </p>
              )}
              {librarySaveError && (
                <p className="text-xs font-medium text-rose-600 dark:text-rose-400">
                  {librarySaveError}
                </p>
              )}
              {aiError && (
                <p className="text-xs font-medium text-rose-600 dark:text-rose-400">
                  {aiError}
                </p>
              )}
            </section>
          )}

          {/* ACCEPTED SCHEDULE PREVIEW + CONFIRMATION */}
          {pdfExtraction && scheduleEvaluation && scheduleEvaluation.accepted && structuredPlan && (
            <div className="space-y-6">
              <SmartPdfImportPreview
                plan={structuredPlan}
                onUpdatePlan={(updater) =>
                  setStructuredPlan((prev) => (prev ? updater(prev) : prev))
                }
                existingActivities={state.activities}
                timeFormat={timeFormat}
                onImport={importStructuredPdfPlan}
                onNotify={pushToast}
                onOpenCalendar={() => setActivePage('calendar')}
                autoSyncedSummary={autoSyncedSummary}
              />

              {/* Optional Gemini Verification for Multi-Column Timetable PDFs */}
              <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div className="space-y-1">
                    <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
                      Need deeper parsing for a complex multi-column table or handwritten scan? Run optional{' '}
                      <span className="font-semibold text-[var(--df-text)]">Gemini AI</span>{' '}
                      extraction. Deterministic validation still verifies weekdays, breaks, and date ranges.
                    </p>
                    <p className="text-[11px] text-[var(--df-text-subtle)]">
                      Free-tier AI notice: sends extracted pages from this PDF to Gemini only when you click Analyze.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 shrink-0">
                    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-[var(--df-text)]">
                      <input
                        type="checkbox"
                        checked={includeMultimodalSnapshots}
                        onChange={(e) => setIncludeMultimodalSnapshots(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                      />
                      <span>Multimodal snapshots</span>
                    </label>
                    <button
                      type="button"
                      disabled={aiAnalyzing}
                      onClick={() => void handleAnalyzeWithGemini(false)}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3.5 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)] disabled:opacity-60 whitespace-nowrap"
                    >
                      <BiIcon name="stars" className="text-xs" />
                      {aiAnalyzing ? 'Analyzing...' : 'Analyze with Gemini AI'}
                    </button>
                  </div>
                </div>
                {aiError && (
                  <p role="alert" className="mt-2.5 text-xs font-medium text-rose-600 dark:text-rose-400">
                    {aiError}
                  </p>
                )}
              </section>

              {/* 2. Separate Quotations & Study Notes Review */}
              <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
                <div className="border-b border-[var(--df-border)] pb-3">
                  <h3 className="font-display text-lg font-bold text-[var(--df-text)]">
                    Quotations &amp; study notes
                  </h3>
                  <p className="text-xs text-[var(--df-text-muted)]">
                    Kept separate from your calendar. Save key ideas or convert one into a study block.
                  </p>
                </div>

                {extractedQuotes.length === 0 ? (
                  <p className="py-6 text-center text-xs text-[var(--df-text-muted)]">
                    No distinct quotations or highlight notes detected in this PDF.
                  </p>
                ) : (
                  <div className="mt-4 space-y-3">
                    {extractedQuotes.map((q) => (
                      <div
                        key={q.id}
                        className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-4"
                      >
                        <textarea
                          rows={2}
                          value={q.text}
                          onChange={(e) =>
                            setExtractedQuotes((prev) =>
                              prev.map((item) =>
                                item.id === q.id ? { ...item, text: e.target.value } : item
                              )
                            )
                          }
                          className="w-full resize-none rounded-lg border border-transparent bg-transparent text-sm leading-relaxed text-[var(--df-text)] focus:border-[var(--df-border-strong)] focus:bg-[var(--df-surface)] focus:p-2 focus:outline-none"
                        />
                        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs text-[var(--df-text-muted)]">
                            {q.sourceFile} · p. {q.pageNumber} · {q.category}
                          </span>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={q.saved}
                              onClick={() => handleSaveExtractedQuote(q)}
                              className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)] disabled:opacity-50"
                            >
                              <BiIcon name="quote" className="text-xs" />
                              {q.saved ? 'Saved' : 'Save quote'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSaveExtractedQuoteAsNote(q)}
                              className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)]"
                            >
                              <BiIcon name="journal-text" className="text-xs" />
                              To note
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                handleScheduleQuotation(
                                  q.text,
                                  `${q.sourceFile} p.${q.pageNumber}`,
                                  q.category
                                )
                              }
                              className="inline-flex h-8 items-center gap-1 rounded-lg bg-[var(--df-accent)] px-2.5 text-xs font-semibold text-[var(--df-accent-fg)]"
                            >
                              <BiIcon name="calendar-plus" className="text-xs" />
                              Schedule study
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      )}

      {/* SECTION B: QUICK NOTES & SAVED QUOTATIONS */}
      {activeTab === 'notes' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
          {/* Quick Note Composer */}
          <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5 lg:col-span-5">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-base font-bold text-[var(--df-text)]">
                {editingNoteId ? 'Editing note' : 'New quick note'}
              </h2>
              {noteSaveFeedback && (
                <span className="text-[11px] font-medium text-[var(--df-text-muted)]">
                  {noteSaveFeedback}
                </span>
              )}
            </div>

            <form onSubmit={handleSubmitNewNote} className="mt-4 space-y-3">
              <input
                type="text"
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="Note title"
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm font-medium text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none"
              />

              <textarea
                rows={6}
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                placeholder="Write clearly without clutter..."
                className="w-full resize-y rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2.5 text-sm leading-relaxed text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none"
              />

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <select
                  value={noteCategory}
                  onChange={(e) => setNoteCategory(e.target.value as ActivityCategory)}
                  aria-label="Note category"
                  className="rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)]"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>

                <select
                  value={noteLink}
                  onChange={(e) => setNoteLink(e.target.value)}
                  aria-label="Link note"
                  className="rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-xs text-[var(--df-text)]"
                >
                  <option value="">No link</option>
                  {state.activities.slice(0, 12).map((a) => (
                    <option key={a.id} value={`activity:${a.id}`}>
                      Activity: {a.title}
                    </option>
                  ))}
                  {state.tasks.slice(0, 12).map((t) => (
                    <option key={t.id} value={`task:${t.id}`}>
                      Task: {t.title}
                    </option>
                  ))}
                  {state.focusSessions.slice(0, 8).map((s) => (
                    <option key={s.id} value={`session:${s.id}`}>
                      Session: {s.activityTitle || 'Deep Focus'} ({s.date})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                {editingNoteId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingNoteId(null);
                      setNoteTitle('');
                      setNoteContent('');
                      setNoteLink('');
                      setNoteSaveFeedback('');
                    }}
                    className="rounded-xl border border-[var(--df-border)] px-3.5 py-2 text-xs font-medium text-[var(--df-text-muted)]"
                  >
                    Done editing
                  </button>
                )}
                <button
                  type="submit"
                  className="rounded-xl bg-[var(--df-accent)] px-4 py-2 text-xs font-semibold text-[var(--df-accent-fg)]"
                >
                  {editingNoteId ? 'Save & close' : 'Save note'}
                </button>
              </div>
            </form>
          </section>

          {/* Searchable Notes & Quotations Feed */}
          <div className="space-y-5 lg:col-span-7">
            <div className="relative">
              <BiIcon
                name="search"
                className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-sm text-[var(--df-text-subtle)]"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search notes and saved PDF quotations..."
                aria-label="Search saved notes and quotations"
                className="w-full rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] py-3 pr-4 pl-10 text-sm text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none"
              />
            </div>

            {/* Saved Quick Notes */}
            <section className="space-y-2.5">
              <h3 className="text-xs font-semibold text-[var(--df-text-muted)]">
                Quick notes ({filteredNotes.length})
              </h3>
              {filteredNotes.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--df-border-strong)] p-6 text-center text-xs text-[var(--df-text-muted)]">
                  {searchQuery ? 'No matching notes.' : 'No quick notes yet. Jot something down on the left or during Focus Mode.'}
                </div>
              ) : (
                filteredNotes.map((note) => {
                  const linkText = resolveLinkLabel(note);
                  return (
                    <div
                      key={note.id}
                      className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => handleLoadNoteForEdit(note)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="truncate text-sm font-semibold text-[var(--df-text)]">
                            {note.title || 'Untitled note'}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[var(--df-text-muted)]">
                            {note.content}
                          </p>
                          <p className="mt-2 text-[11px] text-[var(--df-text-subtle)]">
                            {note.category}
                            {linkText ? ` · ${linkText}` : ''}
                            {' · '}
                            {note.updatedAt.slice(0, 10)}
                          </p>
                        </button>

                        <button
                          type="button"
                          onClick={() => deleteNote(note.id)}
                          aria-label={`Delete ${note.title || 'note'}`}
                          className="rounded-lg p-1.5 text-[var(--df-text-subtle)] hover:text-rose-600"
                        >
                          <BiIcon name="trash3" className="text-xs" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </section>

            {/* Saved PDF Quotations */}
            <section className="space-y-2.5">
              <h3 className="text-xs font-semibold text-[var(--df-text-muted)]">
                Saved quotations ({filteredQuotes.length})
              </h3>
              {filteredQuotes.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--df-border-strong)] p-6 text-center text-xs text-[var(--df-text-muted)]">
                  {searchQuery ? 'No matching quotations.' : 'Import a PDF to extract and save study quotes here.'}
                </div>
              ) : (
                filteredQuotes.map((q: StudyQuotation) => (
                  <div
                    key={q.id}
                    className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-4"
                  >
                    <p className="text-sm italic leading-relaxed text-[var(--df-text)]">
                      &ldquo;{q.text}&rdquo;
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-[var(--df-text-muted)]">
                        {q.sourceFile}
                        {q.pageNumber ? ` · p. ${q.pageNumber}` : ''} · {q.category}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            handleScheduleQuotation(
                              q.text,
                              q.pageNumber ? `${q.sourceFile} p.${q.pageNumber}` : q.sourceFile,
                              q.category
                            )
                          }
                          className="inline-flex h-8 items-center gap-1 rounded-lg bg-[var(--df-accent-soft)] px-2.5 text-xs font-semibold text-[var(--df-accent-soft-fg)]"
                        >
                          <BiIcon name="calendar-plus" className="text-xs" />
                          Schedule review
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteQuotation(q.id)}
                          aria-label="Delete quotation"
                          className="rounded-lg p-1.5 text-[var(--df-text-subtle)] hover:text-rose-600"
                        >
                          <BiIcon name="trash3" className="text-xs" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
