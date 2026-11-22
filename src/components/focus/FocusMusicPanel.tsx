import React, { useEffect, useMemo, useState } from 'react';
import { Headphones, Link2, Trash2 } from 'lucide-react';
import { useDayFlow } from '../../context/DayFlowContext';
import { validateAndBuildMusicEmbed } from '../../utils/musicUrl';

export const FocusMusicPanel: React.FC = () => {
  const { state, updateSettings, pushToast } = useDayFlow();
  const savedUrl = state.settings.preferredMusicUrl ?? '';

  const [inputUrl, setInputUrl] = useState(savedUrl);
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(!savedUrl);

  useEffect(() => {
    setInputUrl(savedUrl);
    if (!savedUrl) setIsEditing(true);
  }, [savedUrl]);

  const activeEmbed = useMemo(() => {
    if (!savedUrl) return null;
    const res = validateAndBuildMusicEmbed(savedUrl);
    return res.ok ? res : null;
  }, [savedUrl]);

  const handleLoadUrl = (e: React.FormEvent) => {
    e.preventDefault();
    const res = validateAndBuildMusicEmbed(inputUrl);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError('');
    updateSettings({ preferredMusicUrl: res.canonicalUrl });
    setIsEditing(false);
    pushToast({
      type: 'success',
      title: `${res.label} loaded`,
      description: 'Saved as your preferred focus soundtrack.',
    });
  };

  const handleClear = () => {
    setInputUrl('');
    setError('');
    setIsEditing(true);
    updateSettings({ preferredMusicUrl: null });
  };

  return (
    <section
      aria-label="Focus music player"
      className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Headphones className="h-4 w-4 text-[var(--df-text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--df-text)]">
            Focus music
          </h2>
        </div>

        {activeEmbed && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsEditing((v) => !v)}
              className="text-xs font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
            >
              {isEditing ? 'Hide link' : 'Change'}
            </button>
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear music embed"
              className="rounded-lg p-1.5 text-[var(--df-text-subtle)] hover:text-rose-500"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {isEditing && (
        <form onSubmit={handleLoadUrl} className="mt-3 space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Link2 className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[var(--df-text-subtle)]" />
              <input
                type="url"
                value={inputUrl}
                onChange={(e) => {
                  setInputUrl(e.target.value);
                  if (error) setError('');
                }}
                placeholder="Paste Spotify or YouTube link..."
                aria-label="Spotify or YouTube URL"
                className="w-full rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] py-2 pr-3 pl-8 text-xs text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="rounded-xl bg-[var(--df-cta)] px-3.5 py-2 text-xs font-semibold text-[var(--df-cta-fg)] transition-opacity hover:opacity-90 whitespace-nowrap shrink-0"
            >
              Embed
            </button>
          </div>

          {error && (
            <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
              {error}
            </p>
          )}
        </form>
      )}

      {activeEmbed ? (
        <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)]">
          <iframe
            src={activeEmbed.embedUrl}
            title={activeEmbed.label}
            width="100%"
            height={activeEmbed.compactHeight}
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            className="block w-full border-0"
          />
        </div>
      ) : (
        <p className="mt-2.5 text-xs text-[var(--df-text-muted)]">
          Drop in an official Spotify playlist/track or YouTube study stream link to keep it right here while you focus.
        </p>
      )}

      <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--df-text-subtle)]">
        Uses official Spotify &amp; YouTube embeds. Autoplay and background playback follow your browser and account policies.
      </p>
    </section>
  );
};
