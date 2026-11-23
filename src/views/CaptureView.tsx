import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SmartPdfImportPreview } from '../components/capture/SmartPdfImportPreview';
import { BiIcon } from '../components/ui/BiIcon';
import { useDayFlow } from '../context/DayFlowContext';
import {
  ActivityCategory,
  PdfExtractedQuotation,
  QuickNote,
  StudyQuotation,
} from '../types/dayflow';
import type {
  PdfAutoSyncCommitResult,
  PdfPageImagePayload,
  StructuredPdfPlan,
} from '../types/pdfSchedule';
import {
  getTodayISO,
  minutesToTime24,
  parseTimeToMinutes,
} from '../utils/dateTime';
import {
  ExtractedPdfPage,
  extractPdfPages,
  parsePdfPagesToStructuredPlan,
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
    updateSettings,
    setActivePage,
    openQuickActivitySheet,
    pushToast,
  } = useDayFlow();

  const todayISO = getTodayISO();
  const timeFormat = state.settings.timeFormat;
  const autoSyncEnabled = state.settings.autoSyncPdfSchedule;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cachedPlansRef = useRef<Map<string, StructuredPdfPlan>>(new Map());
  const autoSyncRef = useRef(autoSyncEnabled);
  autoSyncRef.current = autoSyncEnabled;

  const [activeTab, setActiveTab] = useState<CaptureTab>('pdf');
  const [isDraggingPdf, setIsDraggingPdf] = useState(false);

  // PDF extraction & structured plan state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pdfExtracting, setPdfExtracting] = useState(false);
  const [pdfExtraction, setPdfExtraction] = useState<PdfTextExtractionResult | null>(null);
  const [pdfError, setPdfError] = useState('');
  const [structuredPlan, setStructuredPlan] = useState<StructuredPdfPlan | null>(null);
  const [extractedQuotes, setExtractedQuotes] = useState<PdfExtractedQuotation[]>([]);
  const [includeMultimodalSnapshots, setIncludeMultimodalSnapshots] = useState(false);

  // Optional Gemini server-side enhancement state
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [aiError, setAiError] = useState('');

  // Auto-Sync commit state
  const [autoSyncing, setAutoSyncing] = useState(false);
  const [autoSyncResult, setAutoSyncResult] = useState<PdfAutoSyncCommitResult | null>(null);
  const [lastCandidatePlan, setLastCandidatePlan] = useState<StructuredPdfPlan | null>(null);

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
        headers: { 'Content-Type': 'application/json' },
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
    [includeMultimodalSnapshots, todayISO]
  );

  const runAutoSync = useCallback(
    async (planToSync: StructuredPdfPlan) => {
      setAutoSyncing(true);
      setAutoSyncResult(null);
      setLastCandidatePlan(planToSync);

      try {
        const { commit, reviewPlan } = await syncStructuredPdfPlan(planToSync);
        setAutoSyncResult(commit);

        if (commit.reviewItems.length > 0) {
          setStructuredPlan(reviewPlan);
        } else {
          setStructuredPlan(planToSync);
        }

        if (
          commit.status === 'synced' &&
          commit.persisted &&
          commit.activitiesAdded + commit.tasksAdded + commit.notesAdded > 0
        ) {
          pushToast({
            type: commit.reviewItems.length > 0 ? 'warning' : 'success',
            title: 'Schedule synced successfully',
            description: `${commit.activitiesAdded} activities added · ${commit.duplicatesSkipped} duplicates skipped${
              commit.reviewItems.length > 0
                ? ` · ${commit.reviewItems.length} needing review`
                : ''
            }`,
          });
        } else if (commit.status === 'duplicates_only') {
          pushToast({
            type: 'info',
            title: 'Already synced',
            description: `${commit.duplicatesSkipped} duplicate entries skipped.`,
          });
        } else if (commit.status === 'needs_review') {
          pushToast({
            type: 'warning',
            title: 'Review required before syncing',
            description: `${commit.reviewItems.length} entries need confirmation.`,
          });
        } else if (commit.status === 'error') {
          pushToast({
            type: 'error',
            title: 'Sync failed',
            description: commit.error || 'Could not save synced schedule entries.',
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'PDF auto-sync failed.';
        setAutoSyncResult({
          status: 'error',
          persisted: false,
          error: msg,
          activitiesAdded: 0,
          recurringRulesAdded: 0,
          tasksAdded: 0,
          notesAdded: 0,
          duplicatesSkipped: 0,
          conflictsCount: 0,
          reviewItems: [],
          timetableDiff: {
            hasPreviousImportFromFile: false,
            addedTitles: [],
            changedTitles: [],
            removedTitles: [],
          },
        });
      } finally {
        setAutoSyncing(false);
      }
    },
    [syncStructuredPdfPlan, pushToast]
  );

  const handleFilePicked = useCallback(
    async (file: File | null) => {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        setPdfError('Please select or paste a valid .pdf file.');
        return;
      }

      setSelectedFile(file);
      setPdfError('');
      setAiError('');
      setAutoSyncResult(null);
      setLastCandidatePlan(null);
      setPdfExtracting(true);
      setPdfExtraction(null);
      setStructuredPlan(null);
      setExtractedQuotes([]);

      try {
        const result = await extractPdfPages(file);
        setPdfExtraction(result);
        setIncludeMultimodalSnapshots(result.isScannedOrEmpty || result.hasComplexTables);

        const shouldAutoSync = autoSyncRef.current;

        if (result.isScannedOrEmpty) {
          if (shouldAutoSync) {
            setPdfExtracting(false);
            setAiAnalyzing(true);
            try {
              const aiPlan = await requestGeminiPlan(result, file, true);
              setStructuredPlan(aiPlan);
              setExtractedQuotes(aiPlan.quotations ?? []);
              await runAutoSync(aiPlan);
            } catch (err) {
              setAiError(
                err instanceof Error
                  ? err.message
                  : 'Scanned PDF could not be analyzed automatically.'
              );
            } finally {
              setAiAnalyzing(false);
            }
          }
          return;
        }

        let activePlan = parsePdfPagesToStructuredPlan(result.fileName, result.pages, {
          documentHash: result.documentHash,
          referenceDateISO: todayISO,
        });

        setStructuredPlan(activePlan);
        setExtractedQuotes(activePlan.quotations);

        const localScheduleCount =
          activePlan.weeklyPlans.length +
          activePlan.dailyPlans.length +
          activePlan.monthlyGoals.length +
          activePlan.deadlines.length;

        const totalFound = localScheduleCount + activePlan.quotations.length;

        if (shouldAutoSync) {
          if (result.hasComplexTables || localScheduleCount === 0) {
            setAiAnalyzing(true);
            try {
              const aiPlan = await requestGeminiPlan(result, file, result.hasComplexTables);
              activePlan = aiPlan;
              setStructuredPlan(aiPlan);
              setExtractedQuotes(aiPlan.quotations ?? []);
            } catch (err) {
              // Keep local plan if it has items; report AI fallback error only when 0 items
              if (localScheduleCount === 0) {
                setAiError(
                  err instanceof Error
                    ? err.message
                    : 'Unable to reach Gemini analysis endpoint.'
                );
              }
            } finally {
              setAiAnalyzing(false);
            }
          }

          setPdfExtracting(false);
          await runAutoSync(activePlan);
          return;
        }

        if (totalFound === 0) {
          pushToast({
            type: 'info',
            title: 'Text extracted from PDF',
            description:
              'No obvious timetable rows matched locally. Click "Enhance with Gemini AI" for table-preserving interpretation.',
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
    [todayISO, requestGeminiPlan, runAutoSync, pushToast]
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

    try {
      const data = await requestGeminiPlan(pdfExtraction, selectedFile, forceMultimodal);
      setStructuredPlan(data);
      setExtractedQuotes(data.quotations ?? []);

      if (autoSyncEnabled) {
        await runAutoSync(data);
        return;
      }

      const totalItems =
        (data.weeklyPlans?.length ?? 0) +
        (data.dailyPlans?.length ?? 0) +
        (data.monthlyGoals?.length ?? 0) +
        (data.deadlines?.length ?? 0);

      pushToast({
        type: 'success',
        title: data.cached ? 'Loaded cached Gemini schedule' : 'Structured with Gemini AI',
        description: `Detected ${totalItems} schedule items (${data.documentType}) and ${
          data.quotations?.length ?? 0
        } notes/quotes.`,
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Unable to reach Gemini analysis endpoint.');
    } finally {
      setAiAnalyzing(false);
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
          {/* Auto-Sync Preference Strip */}
          <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] px-4 py-3 sm:flex-row sm:items-center">
            <label
              htmlFor="capture-auto-sync-toggle"
              className="flex cursor-pointer items-center gap-2.5 text-xs"
            >
              <input
                id="capture-auto-sync-toggle"
                type="checkbox"
                checked={autoSyncEnabled}
                onChange={(e) => updateSettings({ autoSyncPdfSchedule: e.target.checked })}
                className="h-4 w-4 rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
              />
              <span>
                <span className="font-semibold text-[var(--df-text)]">
                  Automatically sync imported PDF schedules
                </span>
                <span className="block text-[11px] text-[var(--df-text-muted)]">
                  Auto-syncs validated activities &amp; deadlines on upload or paste; sends conflicts or undated rows to review.
                </span>
              </span>
            </label>

            {structuredPlan && !autoSyncing && (
              <button
                type="button"
                onClick={() => void runAutoSync(structuredPlan)}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)] whitespace-nowrap"
              >
                <BiIcon name="arrow-repeat" className="text-xs" />
                Sync to calendar
              </button>
            )}
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
                Upload or paste a timetable PDF
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-[var(--df-text-muted)]">
                Drop, choose, or paste a <span className="font-mono">.pdf</span> file from your clipboard. Local extraction runs first on your device.
              </p>

              <button
                type="button"
                disabled={pdfExtracting || autoSyncing}
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-2xl bg-[var(--df-accent)] px-5 text-sm font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98] disabled:opacity-60"
              >
                <BiIcon name="file-earmark-arrow-up" className="text-base" />
                {pdfExtracting
                  ? 'Reading PDF...'
                  : aiAnalyzing
                  ? 'Analyzing schedule...'
                  : autoSyncing
                  ? 'Syncing schedule...'
                  : 'Choose PDF file'}
              </button>

              {pdfError && (
                <p role="alert" className="mt-3 text-xs font-medium text-rose-600 dark:text-rose-400">
                  {pdfError}
                </p>
              )}
            </div>
          </section>

          {/* Auto-Sync Progress & Honest Persistence Status */}
          {autoSyncing && (
            <section
              role="status"
              aria-live="polite"
              className="flex items-center gap-3 rounded-2xl border border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] px-4 py-3 text-xs font-medium text-[var(--df-accent-soft-fg)]"
            >
              <BiIcon name="arrow-repeat" spin className="text-sm" />
              <span>Validating dates, detecting overlaps &amp; saving schedule to your calendar...</span>
            </section>
          )}

          {autoSyncResult && !autoSyncing && (
            <section
              role={autoSyncResult.status === 'error' ? 'alert' : 'status'}
              className={`space-y-3 rounded-3xl border p-5 ${
                autoSyncResult.status === 'error'
                  ? 'border-rose-300 bg-rose-50/70 dark:border-rose-900/50 dark:bg-rose-950/25'
                  : autoSyncResult.status === 'synced'
                  ? 'border-[var(--df-accent-border)] bg-[var(--df-accent-soft)]/50'
                  : 'border-amber-300 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/25'
              }`}
            >
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <div className="flex items-start gap-2.5">
                  <BiIcon
                    name={
                      autoSyncResult.status === 'synced'
                        ? 'check-circle-fill'
                        : autoSyncResult.status === 'error'
                        ? 'exclamation-circle-fill'
                        : 'exclamation-triangle-fill'
                    }
                    className={`mt-0.5 text-base shrink-0 ${
                      autoSyncResult.status === 'synced'
                        ? 'text-[var(--df-accent-soft-fg)]'
                        : autoSyncResult.status === 'error'
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}
                  />
                  <div>
                    <h3 className="text-sm font-bold text-[var(--df-text)]">
                      {autoSyncResult.status === 'synced' && autoSyncResult.persisted
                        ? 'Schedule synced successfully'
                        : autoSyncResult.status === 'duplicates_only'
                        ? 'Already synced — duplicates skipped'
                        : autoSyncResult.status === 'needs_review'
                        ? 'Entries require your review before adding'
                        : autoSyncResult.status === 'empty'
                        ? 'No schedule activities found in this PDF'
                        : 'Could not sync PDF schedule'}
                    </h3>
                    {autoSyncResult.status === 'error' && autoSyncResult.error && (
                      <p className="mt-0.5 text-xs text-rose-700 dark:text-rose-300">
                        {autoSyncResult.error}
                      </p>
                    )}
                    {autoSyncResult.status !== 'error' && (
                      <p className="mt-1 text-xs text-[var(--df-text-muted)]">
                        <span className="font-mono font-semibold text-[var(--df-text)]">
                          {autoSyncResult.activitiesAdded}
                        </span>{' '}
                        activities added ·{' '}
                        {autoSyncResult.tasksAdded > 0 && (
                          <>
                            <span className="font-mono font-semibold text-[var(--df-text)]">
                              {autoSyncResult.tasksAdded}
                            </span>{' '}
                            deadlines added ·{' '}
                          </>
                        )}
                        {autoSyncResult.notesAdded > 0 && (
                          <>
                            <span className="font-mono font-semibold text-[var(--df-text)]">
                              {autoSyncResult.notesAdded}
                            </span>{' '}
                            roadmaps saved ·{' '}
                          </>
                        )}
                        <span className="font-mono font-semibold text-[var(--df-text)]">
                          {autoSyncResult.duplicatesSkipped}
                        </span>{' '}
                        duplicates skipped ·{' '}
                        <span className="font-mono font-semibold text-[var(--df-text)]">
                          {autoSyncResult.reviewItems.length}
                        </span>{' '}
                        entries requiring review
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {autoSyncResult.status === 'error' && lastCandidatePlan && (
                    <button
                      type="button"
                      onClick={() => void runAutoSync(lastCandidatePlan)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--df-cta)] px-3.5 text-xs font-semibold text-[var(--df-cta-fg)]"
                    >
                      <BiIcon name="arrow-clockwise" className="text-xs" />
                      Retry Sync
                    </button>
                  )}
                  {(autoSyncResult.status === 'synced' ||
                    autoSyncResult.status === 'duplicates_only') && (
                    <button
                      type="button"
                      onClick={() => setActivePage('calendar')}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-3.5 text-xs font-semibold text-[var(--df-accent-fg)]"
                    >
                      <BiIcon name="calendar3" className="text-xs" />
                      View Calendar
                    </button>
                  )}
                </div>
              </div>

              {autoSyncResult.reviewItems.length > 0 && (
                <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-3.5">
                  <p className="text-xs font-semibold text-[var(--df-text)]">
                    Entries requiring review (kept out of your calendar until confirmed below):
                  </p>
                  <ul className="mt-2 space-y-1.5 text-xs text-[var(--df-text-muted)]">
                    {autoSyncResult.reviewItems.slice(0, 6).map((item) => (
                      <li key={item.id} className="flex items-start gap-2">
                        <BiIcon name="dot" className="mt-0.5 text-sm text-amber-500" />
                        <span>
                          <span className="font-semibold text-[var(--df-text)]">{item.title}</span> —{' '}
                          {item.reason}
                        </span>
                      </li>
                    ))}
                    {autoSyncResult.reviewItems.length > 6 && (
                      <li className="pl-5 text-[11px] text-[var(--df-text-subtle)]">
                        +{autoSyncResult.reviewItems.length - 6} more checked in Smart Schedule Review below.
                      </li>
                    )}
                  </ul>
                </div>
              )}

              {autoSyncResult.timetableDiff.hasPreviousImportFromFile &&
                (autoSyncResult.timetableDiff.changedTitles.length > 0 ||
                  autoSyncResult.timetableDiff.removedTitles.length > 0) && (
                  <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-3.5 text-xs text-[var(--df-text-muted)]">
                    <p className="font-semibold text-[var(--df-text)]">
                      Updated timetable comparison (existing calendar blocks preserved):
                    </p>
                    {autoSyncResult.timetableDiff.changedTitles.length > 0 && (
                      <p className="mt-1">
                        Changed times routed for review:{' '}
                        {autoSyncResult.timetableDiff.changedTitles.join('; ')}
                      </p>
                    )}
                    {autoSyncResult.timetableDiff.removedTitles.length > 0 && (
                      <p className="mt-1">
                        Not in updated PDF (kept in calendar):{' '}
                        {autoSyncResult.timetableDiff.removedTitles.join(', ')}
                      </p>
                    )}
                  </div>
                )}
            </section>
          )}

          {/* Scanned PDF Honest OCR Warning + Multimodal Consent Option */}
          {pdfExtraction && pdfExtraction.isScannedOrEmpty && !structuredPlan && (
            <section
              role="alert"
              className="rounded-3xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800/60 dark:bg-amber-950/30"
            >
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div className="flex items-start gap-3">
                  <BiIcon
                    name="exclamation-triangle"
                    className="mt-0.5 text-lg shrink-0 text-amber-600 dark:text-amber-400"
                  />
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-[var(--df-text)]">
                      Scanned or image-based PDF: {pdfExtraction.fileName}
                    </h3>
                    <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
                      {pdfExtraction.scannedReason}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={aiAnalyzing}
                  onClick={() => void handleAnalyzeWithGemini(true)}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[var(--df-cta)] px-4 text-xs font-semibold text-[var(--df-cta-fg)] hover:opacity-90 disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  <BiIcon name="stars" className="text-xs" />
                  {aiAnalyzing ? 'Reading pages...' : 'Read with Gemini Multimodal'}
                </button>
              </div>
              {aiError && (
                <p role="alert" className="mt-3 text-xs font-medium text-rose-600 dark:text-rose-400">
                  {aiError}
                </p>
              )}
            </section>
          )}

          {/* Review Screen for Extracted PDF Content */}
          {pdfExtraction && (!pdfExtraction.isScannedOrEmpty || structuredPlan !== null) && (
            <div className="space-y-6">
              {/* Document Metadata + Optional Explicit-Consent Gemini Analysis */}
              <section className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-[var(--df-text)]">
                      {pdfExtraction.fileName}
                    </p>
                    <p className="text-xs text-[var(--df-text-muted)]">
                      {pdfExtraction.pageCount} {pdfExtraction.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                      {structuredPlan?.analysisSource === 'gemini-multimodal'
                        ? 'Gemini Multimodal'
                        : structuredPlan?.analysisSource === 'gemini'
                        ? 'Gemini AI'
                        : 'Local table-preserving extraction'}{' '}
                      · {structuredPlan?.weeklyPlans.length ?? 0} weekly slots ·{' '}
                      {structuredPlan?.monthlyGoals.length ?? 0} monthly roadmaps ·{' '}
                      {structuredPlan?.deadlines.length ?? 0} deadlines
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={aiAnalyzing || autoSyncing}
                    onClick={() => void handleAnalyzeWithGemini(false)}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 text-xs font-semibold text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] disabled:opacity-60 whitespace-nowrap shrink-0"
                  >
                    <BiIcon name="stars" className="text-xs" />
                    {aiAnalyzing ? 'Analyzing...' : 'Enhance with Gemini AI'}
                  </button>
                </div>

                <div className="mt-3 flex flex-col justify-between gap-2.5 rounded-2xl bg-[var(--df-bg)] px-3.5 py-2.5 sm:flex-row sm:items-center">
                  <p className="text-[11px] leading-relaxed text-[var(--df-text-muted)]">
                    Privacy notice: Local extraction runs on-device first. Gemini AI is invoked only when you click{' '}
                    <span className="font-semibold text-[var(--df-text)]">Enhance with Gemini AI</span>{' '}
                    or when auto-sync encounters complex/scanned PDF tables.
                  </p>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-[var(--df-text)] shrink-0">
                    <input
                      type="checkbox"
                      checked={includeMultimodalSnapshots}
                      onChange={(e) => setIncludeMultimodalSnapshots(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-[var(--df-border-strong)] accent-[var(--df-accent)]"
                    />
                    <span>Multimodal table snapshots</span>
                  </label>
                </div>

                {aiError && (
                  <p role="alert" className="mt-2.5 text-xs font-medium text-rose-600 dark:text-rose-400">
                    {aiError}
                  </p>
                )}
              </section>

              {/* 1. Smart 4-Tab Schedule Review & Weekly Timetable Grid */}
              {structuredPlan && (
                <SmartPdfImportPreview
                  plan={structuredPlan}
                  onUpdatePlan={(updater) =>
                    setStructuredPlan((prev) => (prev ? updater(prev) : prev))
                  }
                  existingActivities={state.activities}
                  timeFormat={timeFormat}
                  onImport={importStructuredPdfPlan}
                  onNotify={pushToast}
                />
              )}

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
