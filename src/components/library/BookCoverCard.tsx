import React from 'react';
import type { LibraryResource } from '../../types/library';
import { BiIcon } from '../ui/BiIcon';
import { BookCoverArtwork } from './BookCoverArtwork';

interface BookCoverCardProps {
  resource: LibraryResource;
  onOpenDetails: (resource: LibraryResource) => void;
  onQuickRead: (resource: LibraryResource) => void;
}

export const BookCoverCard: React.FC<BookCoverCardProps> = ({
  resource,
  onOpenDetails,
  onQuickRead,
}) => {
  const isPdf = resource.resourceType === 'pdf';
  const totalPages = resource.totalPages ?? 0;
  const clampedLastPage =
    isPdf && totalPages > 0
      ? Math.max(1, Math.min(resource.lastReadPage || 1, totalPages))
      : resource.lastReadPage || 1;
  const progressPercent =
    isPdf && totalPages > 0
      ? clampedLastPage <= 1
        ? 0
        : Math.round((clampedLastPage / totalPages) * 100)
      : 0;

  return (
    <article className="group flex flex-col">
      {/* Clickable 3:4 Book Cover */}
      <button
        type="button"
        onClick={() => onOpenDetails(resource)}
        className="relative block w-full text-left rounded-r-xl rounded-l-sm transition-transform duration-200 group-hover:-translate-y-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-accent)]"
        aria-label={`Open details for ${resource.title}`}
      >
        <BookCoverArtwork
          title={resource.title}
          subtitle={resource.subtitle}
          subject={resource.subject}
          templateId={resource.coverTemplate}
          totalPages={resource.totalPages}
          coverReference={resource.generatedCoverReference}
        />
      </button>

      {/* Book Title & Dot-Separated Metadata (zero-pill discipline) */}
      <div className="mt-3 flex flex-1 flex-col justify-between gap-2">
        <div>
          <button
            type="button"
            onClick={() => onOpenDetails(resource)}
            className="line-clamp-2 text-left font-display text-sm font-semibold leading-snug text-[var(--df-text)] transition-colors hover:text-[var(--df-accent-soft-fg)]"
          >
            {resource.title}
          </button>

          <p className="mt-1 text-xs text-[var(--df-text-muted)]">
            <span>{resource.subject}</span>
            {isPdf && totalPages > 0 ? (
              <>
                <span aria-hidden="true"> · </span>
                <span className="font-mono tabular-nums">{totalPages} pp.</span>
              </>
            ) : (
              <>
                <span aria-hidden="true"> · </span>
                <span>Web link</span>
              </>
            )}
          </p>
        </div>

        {/* Reading Progress & Direct Open Action */}
        <div className="space-y-2 pt-1">
          {isPdf && totalPages > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-[var(--df-text-subtle)]">
                <span className="font-mono tabular-nums">
                  {clampedLastPage > 1
                    ? `Page ${clampedLastPage} of ${totalPages}`
                    : 'Ready to read'}
                </span>
                {progressPercent > 0 && (
                  <span className="font-mono tabular-nums">{progressPercent}%</span>
                )}
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--df-surface-muted)]">
                <div
                  className="h-full rounded-full bg-[var(--df-accent)] transition-all"
                  style={{ width: `${Math.max(progressPercent, clampedLastPage > 1 ? 3 : 0)}%` }}
                />
              </div>
            </div>
          )}

          {isPdf ? (
            <button
              type="button"
              onClick={() => onQuickRead(resource)}
              className="inline-flex min-h-[38px] w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 py-1.5 text-xs font-medium text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)]"
            >
              <BiIcon name="book-half" className="text-xs" />
              <span>{clampedLastPage > 1 ? 'Continue Reading' : 'Open Book'}</span>
            </button>
          ) : (
            resource.originalUrl && (
              <a
                href={resource.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[38px] w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 py-1.5 text-xs font-medium text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)]"
              >
                <BiIcon name="box-arrow-up-right" className="text-xs" />
                <span>Open Resource</span>
              </a>
            )
          )}
        </div>
      </div>
    </article>
  );
};
