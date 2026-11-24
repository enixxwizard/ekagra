import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  downloadLocalLibraryPdf,
  openLocalPdfForReader,
} from '../../services/libraryService';
import type { LibraryResource, LibraryTopic } from '../../types/library';
import { BiIcon } from '../ui/BiIcon';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface PdfBookReaderProps {
  resource: LibraryResource;
  initialPage?: number;
  onBack: () => void;
  onUpdateProgress: (resourceId: string, page: number) => void;
  onUpdateTopics: (resourceId: string, topics: LibraryTopic[]) => Promise<void>;
}

export const PdfBookReader: React.FC<PdfBookReaderProps> = ({
  resource,
  initialPage,
  onBack,
  onUpdateProgress,
  onUpdateTopics,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const lastSavedPageRef = useRef<number>(resource.lastReadPage || 1);

  const [loadingDoc, setLoadingDoc] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [totalPages, setTotalPages] = useState(resource.totalPages ?? 1);
  const [currentPage, setCurrentPage] = useState(
    Math.max(1, initialPage ?? resource.lastReadPage ?? 1)
  );
  const [pageInput, setPageInput] = useState(
    String(Math.max(1, initialPage ?? resource.lastReadPage ?? 1))
  );
  const [zoomMode, setZoomMode] = useState<'fit' | 'custom'>('fit');
  const [customScale, setCustomScale] = useState(1.25);
  const [stageWidth, setStageWidth] = useState(820);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showTopicsDrawer, setShowTopicsDrawer] = useState(true);

  // Quick manual topic marking right inside the reader
  const [newTopicTitle, setNewTopicTitle] = useState('');
  const [newTopicEndPage, setNewTopicEndPage] = useState('');
  const [savingTopic, setSavingTopic] = useState(false);

  // Load original PDF document lazily via range transport (safe for large PDFs)
  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    setLoadingDoc(true);
    setLoadError('');

    const load = async () => {
      try {
        const rangeSource = await openLocalPdfForReader(resource.id);
        if (cancelled) return;
        loadingTask = pdfjsLib.getDocument({
          range: rangeSource.createRangeTransport(),
          rangeChunkSize: 131072,
          disableAutoFetch: rangeSource.totalBytes > 16 * 1024 * 1024,
          disableStream: false,
          useSystemFonts: true,
        });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy().catch(() => undefined);
          return;
        }
        pdfDocRef.current = pdf;
        const count = Math.max(1, pdf.numPages);
        setTotalPages(count);
        const startTarget = Math.min(
          count,
          Math.max(1, initialPage ?? resource.lastReadPage ?? 1)
        );
        setCurrentPage(startTarget);
        setPageInput(String(startTarget));
        setLoadingDoc(false);
      } catch (err) {
        if (!cancelled) {
          setLoadingDoc(false);
          setLoadError(
            err instanceof Error ? err.message : 'Unable to open this PDF on this device.'
          );
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      if (loadingTask) {
        void loadingTask.destroy().catch(() => undefined);
      }
      pdfDocRef.current = null;
    };
  }, [resource.id]);

  // Keep page input synced
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  // Measure reader stage width cleanly for Fit-to-Width zoom
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const updateWidth = () => {
      const w = el.clientWidth;
      if (w > 120) setStageWidth(w - 32);
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showTopicsDrawer, isFullscreen]);

  // Render active page cleanly on Canvas with active renderTask cancellation
  useEffect(() => {
    const pdf = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || loadingDoc || loadError) return;

    let cancelled = false;

    const renderPage = async () => {
      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }
        const safePageNum = Math.max(1, Math.min(currentPage, pdf.numPages));
        const page = await pdf.getPage(safePageNum);
        if (cancelled) return;

        const baseVp = page.getViewport({ scale: 1 });
        const targetScale =
          zoomMode === 'fit'
            ? Math.min(2.2, Math.max(0.6, Math.min(stageWidth, 940) / Math.max(1, baseVp.width)))
            : customScale;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: targetScale });

        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, viewport.width, viewport.height);

        const task = page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        } as never);
        renderTaskRef.current = task;
        await task.promise;
      } catch (err) {
        if ((err as { name?: string })?.name !== 'RenderingCancelledException') {
          // Non-fatal render glitch ignored
        }
      }
    };

    void renderPage();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [currentPage, zoomMode, customScale, stageWidth, loadingDoc, loadError]);

  // Debounced auto-save for lastReadPage + immediate flush on leave
  useEffect(() => {
    if (loadingDoc || loadError) return;
    if (currentPage === lastSavedPageRef.current) return;

    const timer = window.setTimeout(() => {
      lastSavedPageRef.current = currentPage;
      onUpdateProgress(resource.id, currentPage);
    }, 450);

    return () => window.clearTimeout(timer);
  }, [currentPage, loadingDoc, loadError, resource.id, onUpdateProgress]);

  const flushAndBack = useCallback(() => {
    if (currentPage !== lastSavedPageRef.current) {
      lastSavedPageRef.current = currentPage;
      onUpdateProgress(resource.id, currentPage);
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onBack();
  }, [currentPage, resource.id, onUpdateProgress, onBack]);

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        setCurrentPage((p) => Math.min(totalPages, p + 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        setCurrentPage((p) => Math.max(1, p - 1));
      } else if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [totalPages, isFullscreen]);

  const toggleFullscreen = async () => {
    const next = !isFullscreen;
    setIsFullscreen(next);
    if (next) {
      if (containerRef.current && containerRef.current.requestFullscreen) {
        await containerRef.current.requestFullscreen().catch(() => undefined);
      }
    } else if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    }
  };

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) {
        setIsFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const handleJumpSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number.parseInt(pageInput, 10);
    if (!Number.isNaN(parsed)) {
      const clamped = Math.max(1, Math.min(totalPages, parsed));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
    } else {
      setPageInput(String(currentPage));
    }
  };

  const handleMarkTopicAtCurrentPage = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newTopicTitle.trim();
    if (!clean) return;
    const parsedEnd = Number.parseInt(newTopicEndPage, 10);
    const endPage =
      !Number.isNaN(parsedEnd) && parsedEnd >= currentPage
        ? Math.min(totalPages, parsedEnd)
        : currentPage;

    const newTopic: LibraryTopic = {
      id: `top_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title: clean,
      startPage: currentPage,
      endPage,
      verificationStatus: 'manual',
    };

    setSavingTopic(true);
    try {
      const nextTopics = [...resource.topics, newTopic].sort((a, b) => {
        if (a.startPage === null && b.startPage === null) return 0;
        if (a.startPage === null) return 1;
        if (b.startPage === null) return -1;
        return a.startPage - b.startPage;
      });
      await onUpdateTopics(resource.id, nextTopics);
      setNewTopicTitle('');
      setNewTopicEndPage('');
    } finally {
      setSavingTopic(false);
    }
  };

  const handleSetTopicEndHere = async (topicId: string) => {
    setSavingTopic(true);
    try {
      const updated = resource.topics.map((t) => {
        if (t.id !== topicId) return t;
        const start = t.startPage ?? currentPage;
        return {
          ...t,
          startPage: start,
          endPage: Math.max(start, currentPage),
          verificationStatus: 'manual' as const,
        };
      });
      await onUpdateTopics(resource.id, updated);
    } finally {
      setSavingTopic(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 flex flex-col bg-[var(--df-bg)]'
          : 'flex min-h-[78vh] flex-col overflow-hidden rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)]'
      }
    >
      {/* Reader Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--df-border)] bg-[var(--df-surface)] px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={flushAndBack}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-[var(--df-border)] px-3 text-xs font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)] shrink-0"
          >
            <BiIcon name="arrow-left" />
            <span>Back</span>
          </button>
          <span className="truncate font-display text-sm font-semibold text-[var(--df-text)]">
            {resource.title}
          </span>
        </div>

        {/* Page Turn & Jump */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1 || loadingDoc}
            aria-label="Previous page"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--df-border)] text-xs text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)] disabled:opacity-40"
          >
            <BiIcon name="chevron-left" />
          </button>

          <form onSubmit={handleJumpSubmit} className="flex items-center gap-1">
            <input
              type="text"
              inputMode="numeric"
              aria-label="Jump to page"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={handleJumpSubmit}
              className="h-9 w-14 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] text-center font-mono text-xs tabular-nums text-[var(--df-text)] focus:border-[var(--df-accent)] focus:outline-none"
            />
            <span className="font-mono text-xs tabular-nums text-[var(--df-text-muted)]">
              / {totalPages}
            </span>
          </form>

          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages || loadingDoc}
            aria-label="Next page"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--df-border)] text-xs text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)] disabled:opacity-40"
          >
            <BiIcon name="chevron-right" />
          </button>
        </div>

        {/* Zoom, Topics, Download, Fullscreen */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setZoomMode('custom');
              setCustomScale((s) => Math.max(0.6, Number((s - 0.15).toFixed(2))));
            }}
            aria-label="Zoom out"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--df-border)] text-xs text-[var(--df-text)] hover:bg-[var(--df-surface-hover)]"
          >
            <BiIcon name="zoom-out" />
          </button>
          <button
            type="button"
            onClick={() => setZoomMode(zoomMode === 'fit' ? 'custom' : 'fit')}
            className={`hidden h-9 items-center rounded-xl border px-2.5 font-mono text-[11px] font-medium sm:inline-flex ${
              zoomMode === 'fit'
                ? 'border-[var(--df-text)] bg-[var(--df-surface-hover)] text-[var(--df-text)]'
                : 'border-[var(--df-border)] text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
            }`}
          >
            {zoomMode === 'fit' ? 'Fit' : `${Math.round(customScale * 100)}%`}
          </button>
          <button
            type="button"
            onClick={() => {
              setZoomMode('custom');
              setCustomScale((s) => Math.min(2.4, Number((s + 0.15).toFixed(2))));
            }}
            aria-label="Zoom in"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--df-border)] text-xs text-[var(--df-text)] hover:bg-[var(--df-surface-hover)]"
          >
            <BiIcon name="zoom-in" />
          </button>

          <button
            type="button"
            onClick={() => setShowTopicsDrawer((v) => !v)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${
              showTopicsDrawer
                ? 'border-[var(--df-text)] bg-[var(--df-surface-hover)] text-[var(--df-text)]'
                : 'border-[var(--df-border)] text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
            }`}
          >
            <BiIcon name="list-ul" />
            <span className="hidden sm:inline">Topics</span>
          </button>

          <button
            type="button"
            onClick={() =>
              void downloadLocalLibraryPdf(
                resource.id,
                resource.originalFileName || `${resource.title}.pdf`
              )
            }
            aria-label="Download original PDF"
            title="Download original PDF"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--df-border)] text-xs text-[var(--df-text)] hover:bg-[var(--df-surface-hover)]"
          >
            <BiIcon name="download" />
          </button>

          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--df-border)] text-xs text-[var(--df-text)] hover:bg-[var(--df-surface-hover)]"
          >
            <BiIcon name={isFullscreen ? 'fullscreen-exit' : 'arrows-fullscreen'} />
          </button>
        </div>
      </div>

      {/* Main Split: Reader Stage + Optional Topics Drawer */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div
          ref={stageRef}
          className="flex-1 overflow-auto bg-[var(--df-surface-muted)] p-4 text-center"
        >
          {loadingDoc ? (
            <div className="flex h-96 flex-col items-center justify-center gap-2 text-xs text-[var(--df-text-muted)]">
              <BiIcon name="hourglass-split" className="text-xl" />
              <span>Loading original PDF pages…</span>
            </div>
          ) : loadError ? (
            <div className="mx-auto mt-12 max-w-md rounded-2xl border border-red-500/30 bg-red-500/10 p-5 text-xs text-red-500">
              {loadError}
            </div>
          ) : (
            <div className="inline-block rounded-lg border border-[var(--df-border-strong)] bg-white shadow-lg">
              <canvas ref={canvasRef} className="block rounded-lg" />
            </div>
          )}
        </div>

        {/* Topics Sidebar & Quick Page Marker */}
        {showTopicsDrawer && (
          <aside className="w-full border-t border-[var(--df-border)] bg-[var(--df-surface)] p-4 md:w-72 md:border-t-0 md:border-l">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-[var(--df-text-muted)]">
                Topics Index
              </h3>
              <span className="font-mono text-[11px] tabular-nums text-[var(--df-text-subtle)]">
                {resource.topics.length}
              </span>
            </div>

            <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto md:max-h-[46vh]">
              {resource.topics.length === 0 ? (
                <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
                  No topics indexed yet. Mark topics directly below as you read.
                </p>
              ) : (
                resource.topics.map((topic) => {
                  const isCurrentHere =
                    topic.startPage !== null &&
                    currentPage >= topic.startPage &&
                    currentPage <= (topic.endPage ?? topic.startPage);
                  return (
                    <div
                      key={topic.id}
                      className={`rounded-xl border p-2.5 transition-colors ${
                        isCurrentHere
                          ? 'border-[var(--df-accent-border)] bg-[var(--df-accent-soft)]'
                          : 'border-[var(--df-border)] bg-[var(--df-bg)]'
                      }`}
                    >
                      <button
                        type="button"
                        disabled={topic.startPage === null}
                        onClick={() => {
                          if (topic.startPage !== null) {
                            setCurrentPage(Math.min(totalPages, Math.max(1, topic.startPage)));
                          }
                        }}
                        className="w-full text-left disabled:cursor-default"
                      >
                        <p className="text-xs font-medium text-[var(--df-text)]">
                          {topic.title}
                        </p>
                        <p className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--df-text-muted)]">
                          {topic.startPage !== null
                            ? topic.endPage && topic.endPage !== topic.startPage
                              ? `Pages ${topic.startPage}–${topic.endPage}`
                              : `Page ${topic.startPage}`
                            : 'Page not indexed'}
                        </p>
                      </button>

                      {topic.startPage !== null && currentPage > topic.startPage && (
                        <button
                          type="button"
                          disabled={savingTopic}
                          onClick={() => void handleSetTopicEndHere(topic.id)}
                          className="mt-1.5 text-[11px] font-medium text-[var(--df-accent-soft-fg)] hover:underline"
                        >
                          Set end to page {currentPage}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Quick Mark Topic at Current Page */}
            <form
              onSubmit={handleMarkTopicAtCurrentPage}
              className="mt-4 space-y-2 border-t border-[var(--df-border)] pt-3"
            >
              <p className="text-[11px] font-semibold text-[var(--df-text)]">
                Mark Topic at Page {currentPage}
              </p>
              <input
                type="text"
                value={newTopicTitle}
                onChange={(e) => setNewTopicTitle(e.target.value)}
                placeholder="e.g., Operators in Java"
                className="min-h-[36px] w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 text-xs text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-accent)] focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={currentPage}
                  max={totalPages}
                  value={newTopicEndPage}
                  onChange={(e) => setNewTopicEndPage(e.target.value)}
                  placeholder={`End (opt, ${currentPage})`}
                  className="min-h-[36px] flex-1 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 font-mono text-xs text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-accent)] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!newTopicTitle.trim() || savingTopic}
                  className="min-h-[36px] rounded-xl bg-[var(--df-cta)] px-3 text-xs font-semibold text-[var(--df-cta-fg)] disabled:opacity-40"
                >
                  Mark
                </button>
              </div>
            </form>
          </aside>
        )}
      </div>
    </div>
  );
};
