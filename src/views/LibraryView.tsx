import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AddResourceModal } from '../components/library/AddResourceModal';
import { BookCoverCard } from '../components/library/BookCoverCard';
import { BookDetailsView } from '../components/library/BookDetailsView';
import { PdfBookReader } from '../components/library/PdfBookReader';
import { BiIcon } from '../components/ui/BiIcon';
import { useDayFlow } from '../context/DayFlowContext';
import { useAuth } from '../hooks/useAuth';
import {
  deleteLibraryResourceApi,
  listLibraryResourcesApi,
  updateLibraryResourceApi,
} from '../services/libraryService';
import { subscribeSyncChannel } from '../services/storage/syncChannel';
import type { LibraryResource, LibraryTopic } from '../types/library';

export const LibraryView: React.FC = () => {
  const { status: authStatus, session } = useAuth();
  const { pushToast } = useDayFlow();

  const [resources, setResources] = useState<LibraryResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSubject, setSelectedSubject] = useState<string>('All');
  const [isAddOpen, setIsAddOpen] = useState(false);

  // Active sub-view routing inside Library
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [readerState, setReaderState] = useState<{
    bookId: string;
    startPage?: number;
  } | null>(null);

  const authCreds = useMemo(
    () => ({
      accessToken: session?.access_token ?? null,
      isGuest: authStatus === 'guest',
    }),
    [session?.access_token, authStatus]
  );

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const items = await listLibraryResourcesApi(authCreds);
      setResources(items);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to load your library right now.'
      );
    } finally {
      setLoading(false);
    }
  }, [authCreds]);

  useEffect(() => {
    void loadLibrary();
    return subscribeSyncChannel(['library', 'storage_reset'], () => {
      void loadLibrary();
    });
  }, [loadLibrary]);

  const subjects = useMemo(() => {
    const unique = new Set<string>();
    for (const item of resources) {
      if (item.subject.trim()) unique.add(item.subject.trim());
    }
    return ['All', ...Array.from(unique).sort()];
  }, [resources]);

  const filteredResources = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return resources.filter((item) => {
      if (selectedSubject !== 'All' && item.subject !== selectedSubject) {
        return false;
      }
      if (!q) return true;
      const inTitle = item.title.toLowerCase().includes(q);
      const inSub = item.subtitle.toLowerCase().includes(q);
      const inSubject = item.subject.toLowerCase().includes(q);
      const inTopics = item.topics.some((t) => t.title.toLowerCase().includes(q));
      return inTitle || inSub || inSubject || inTopics;
    });
  }, [resources, selectedSubject, searchQuery]);

  const selectedBook = useMemo(
    () => resources.find((r) => r.id === selectedBookId) ?? null,
    [resources, selectedBookId]
  );

  const readerBook = useMemo(
    () => (readerState ? resources.find((r) => r.id === readerState.bookId) ?? null : null),
    [resources, readerState]
  );

  const handleResourceAdded = useCallback(
    (created: LibraryResource) => {
      setResources((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
      pushToast({
        type: 'success',
        title: 'Resource saved successfully.',
        description: `${created.title} · Available offline.`,
      });
    },
    [pushToast]
  );

  const handleResourceUpdated = useCallback((updated: LibraryResource) => {
    setResources((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
  }, []);

  const handleDeleteResource = useCallback(
    async (resourceId: string) => {
      await deleteLibraryResourceApi(authCreds, resourceId);
      setResources((prev) => prev.filter((r) => r.id !== resourceId));
      setSelectedBookId(null);
      setReaderState(null);
      pushToast({
        type: 'info',
        title: 'Book removed from Library',
      });
    },
    [authCreds, pushToast]
  );

  const handleUpdateReadingProgress = useCallback(
    (resourceId: string, page: number) => {
      // Optimistically update local shelf immediately so Continue Reading stays accurate
      setResources((prev) =>
        prev.map((r) => (r.id === resourceId ? { ...r, lastReadPage: page } : r))
      );
      void updateLibraryResourceApi(authCreds, resourceId, { lastReadPage: page })
        .then((updated) => {
          setResources((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        })
        .catch(() => {
          // Keep optimistic UI state cleanly
        });
    },
    [authCreds]
  );

  const handleUpdateReaderTopics = useCallback(
    async (resourceId: string, topics: LibraryTopic[]) => {
      const updated = await updateLibraryResourceApi(authCreds, resourceId, { topics });
      setResources((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      pushToast({
        type: 'success',
        title: 'Topic saved',
      });
    },
    [authCreds, pushToast]
  );

  // Active sub-view 1: Built-in PDF Reader
  if (readerBook && readerBook.resourceType === 'pdf') {
    return (
      <PdfBookReader
        resource={readerBook}
        initialPage={readerState?.startPage}
        onBack={() => setReaderState(null)}
        onUpdateProgress={handleUpdateReadingProgress}
        onUpdateTopics={handleUpdateReaderTopics}
      />
    );
  }

  // Active sub-view 2: Book Details Page
  if (selectedBook) {
    return (
      <BookDetailsView
        resource={selectedBook}
        onBack={() => setSelectedBookId(null)}
        onOpenReader={(book, startPage) =>
          setReaderState({ bookId: book.id, startPage: startPage ?? book.lastReadPage ?? 1 })
        }
        onResourceUpdated={handleResourceUpdated}
        onDeleteResource={handleDeleteResource}
      />
    );
  }

  // Main View: My Library Bookshelf
  return (
    <div className="space-y-6">
      {/* Header Row */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[var(--df-text)] sm:text-3xl">
            My Library
          </h1>
          <p className="mt-1 text-xs text-[var(--df-text-muted)]">
            Saved on this device · Available offline · Not automatically backed up to cloud.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setIsAddOpen(true)}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[var(--df-cta)] px-4 text-xs font-semibold text-[var(--df-cta-fg)] transition-opacity hover:opacity-90 whitespace-nowrap shrink-0"
        >
          <BiIcon name="plus-lg" />
          <span>Add Resource</span>
        </button>
      </div>

      {/* Search & Subject Filters */}
      {resources.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 sm:max-w-sm">
            <BiIcon
              name="search"
              className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-xs text-[var(--df-text-subtle)]"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search books, subjects, or topics…"
              aria-label="Search library"
              className="min-h-[42px] w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] pr-3 pl-9 text-xs text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-accent)] focus:outline-none"
            />
          </div>

          {subjects.length > 2 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {subjects.map((subj) => {
                const active = selectedSubject === subj;
                return (
                  <button
                    key={subj}
                    type="button"
                    onClick={() => setSelectedSubject(subj)}
                    className={`min-h-[34px] rounded-xl border px-3 text-xs font-medium transition-colors ${
                      active
                        ? 'border-[var(--df-text)] bg-[var(--df-text)] text-[var(--df-bg)]'
                        : 'border-[var(--df-border)] bg-[var(--df-surface)] text-[var(--df-text-muted)] hover:text-[var(--df-text)]'
                    }`}
                  >
                    {subj}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Content States */}
      {loading ? (
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
          {[1, 2, 3, 4].map((idx) => (
            <div key={idx} className="space-y-3">
              <div className="aspect-[3/4] w-full animate-pulse rounded-r-xl rounded-l-sm bg-[var(--df-surface-muted)]" />
              <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--df-surface-muted)]" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--df-surface-muted)]" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-5 text-xs text-red-500">
          <p>{loadError}</p>
          <button
            type="button"
            onClick={() => void loadLibrary()}
            className="mt-3 rounded-xl border border-red-500/40 px-3 py-1.5 font-medium hover:bg-red-500/10"
          >
            Retry
          </button>
        </div>
      ) : resources.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] text-[var(--df-text)]">
            <BiIcon name="book" className="text-2xl" />
          </div>
          <h2 className="mt-4 font-display text-lg font-semibold text-[var(--df-text)]">
            Your bookshelf is empty
          </h2>
          <p className="mt-1.5 max-w-md text-xs leading-relaxed text-[var(--df-text-muted)]">
            Upload lecture notes, textbooks, or paste study links. Ekagra creates an illustrated front cover, indexes covered topics, and remembers the exact page where you left off.
          </p>
          <button
            type="button"
            onClick={() => setIsAddOpen(true)}
            className="mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[var(--df-cta)] px-5 text-xs font-semibold text-[var(--df-cta-fg)] transition-opacity hover:opacity-90"
          >
            <BiIcon name="plus-lg" />
            <span>Add Your First Resource</span>
          </button>
        </div>
      ) : filteredResources.length === 0 ? (
        <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-8 text-center">
          <p className="text-sm font-medium text-[var(--df-text)]">
            No matching books or topics found
          </p>
          <p className="mt-1 text-xs text-[var(--df-text-muted)]">
            Try clearing your search or switching subject filters.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
          {filteredResources.map((book) => (
            <BookCoverCard
              key={book.id}
              resource={book}
              onOpenDetails={(item) => setSelectedBookId(item.id)}
              onQuickRead={(item) =>
                setReaderState({
                  bookId: item.id,
                  startPage: item.lastReadPage || 1,
                })
              }
            />
          ))}
        </div>
      )}

      <AddResourceModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onResourceAdded={handleResourceAdded}
      />
    </div>
  );
};
