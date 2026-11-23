import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { fetchAuthenticatedCoverObjectUrl } from '../../services/libraryService';
import type { LibraryCoverTemplateId } from '../../types/library';
import { renderBookCoverToCanvas } from '../../utils/libraryCoverGenerator';

interface BookCoverArtworkProps {
  title: string;
  subtitle?: string;
  subject: string;
  templateId: LibraryCoverTemplateId;
  totalPages?: number | null;
  coverReference?: string | null;
  className?: string;
  alt?: string;
}

export const BookCoverArtwork: React.FC<BookCoverArtworkProps> = ({
  title,
  subtitle,
  subject,
  templateId,
  totalPages,
  coverReference,
  className = '',
  alt,
}) => {
  const { status: authStatus, session } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cachedImgUrl, setCachedImgUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!coverReference) {
      setCachedImgUrl(null);
      return;
    }

    const controller = new AbortController();
    let createdUrl: string | null = null;

    fetchAuthenticatedCoverObjectUrl(
      {
        accessToken: session?.access_token ?? null,
        isGuest: authStatus === 'guest',
      },
      coverReference,
      controller.signal
    )
      .then((url) => {
        createdUrl = url;
        setCachedImgUrl(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCachedImgUrl(null);
        }
      });

    return () => {
      controller.abort();
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [coverReference, session?.access_token, authStatus]);

  useEffect(() => {
    if (cachedImgUrl || !canvasRef.current) return;
    renderBookCoverToCanvas(canvasRef.current, {
      title,
      subtitle,
      subject,
      templateId,
      totalPages,
    });
  }, [cachedImgUrl, title, subtitle, subject, templateId, totalPages]);

  return (
    <div
      className={`relative aspect-[3/4] w-full overflow-hidden rounded-r-xl rounded-l-sm border border-[var(--df-border-strong)] bg-[var(--df-surface-muted)] shadow-md ${className}`}
    >
      {cachedImgUrl ? (
        <img
          src={cachedImgUrl}
          alt={alt ?? `${title} book cover`}
          className="h-full w-full object-cover select-none"
          draggable={false}
        />
      ) : (
        <canvas
          ref={canvasRef}
          aria-label={alt ?? `${title} generated book cover`}
          className="h-full w-full object-cover"
        />
      )}
      {/* Subtle book page edge sheen */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-1.5 bg-gradient-to-l from-black/15 to-transparent"
      />
    </div>
  );
};
