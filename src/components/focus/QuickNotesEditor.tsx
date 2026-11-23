import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BiIcon } from '../ui/BiIcon';
import { useDayFlow } from '../../context/DayFlowContext';
import { ActivityCategory, QuickNote } from '../../types/dayflow';
import { generateId } from '../../utils/dateTime';

interface QuickNotesEditorProps {
  linkedActivityId?: string | null;
  linkedTaskId?: string | null;
  linkedFocusSessionId?: string | null;
  defaultCategory?: ActivityCategory;
}

export const QuickNotesEditor: React.FC<QuickNotesEditorProps> = ({
  linkedActivityId = null,
  linkedTaskId = null,
  linkedFocusSessionId = null,
  defaultCategory = 'Deep Focus',
}) => {
  const { state, saveNote, setActivePage } = useDayFlow();

  const matchingNotes = useMemo(() => {
    return state.notes.filter((n) => {
      if (linkedActivityId && n.linkedActivityId === linkedActivityId) return true;
      if (linkedTaskId && n.linkedTaskId === linkedTaskId) return true;
      if (linkedFocusSessionId && n.linkedFocusSessionId === linkedFocusSessionId) return true;
      return false;
    });
  }, [state.notes, linkedActivityId, linkedTaskId, linkedFocusSessionId]);

  const [activeNoteId, setActiveNoteId] = useState<string>(() => matchingNotes[0]?.id ?? generateId());
  const [title, setTitle] = useState<string>(() => matchingNotes[0]?.title ?? '');
  const [content, setContent] = useState<string>(() => matchingNotes[0]?.content ?? '');
  const [selectedLink, setSelectedLink] = useState<string>(() => {
    if (linkedActivityId) return `activity:${linkedActivityId}`;
    if (linkedTaskId) return `task:${linkedTaskId}`;
    if (linkedFocusSessionId) return `session:${linkedFocusSessionId}`;
    return '';
  });
  const [saveLabel, setSaveLabel] = useState<string>('Auto-saves locally');
  const [showRefs, setShowRefs] = useState(false);

  const timerRef = useRef<number | null>(null);
  const lastSavedSignatureRef = useRef<string>('');

  useEffect(() => {
    if (linkedActivityId) {
      setSelectedLink(`activity:${linkedActivityId}`);
    } else if (linkedTaskId) {
      setSelectedLink(`task:${linkedTaskId}`);
    } else if (linkedFocusSessionId) {
      setSelectedLink(`session:${linkedFocusSessionId}`);
    }
  }, [linkedActivityId, linkedTaskId, linkedFocusSessionId]);

  const parseLinkSelection = (val: string) => {
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

  const commitSave = (nextTitle: string, nextContent: string, nextLink: string) => {
    if (!nextTitle.trim() && !nextContent.trim()) return;
    const links = parseLinkSelection(nextLink);
    const sig = `${activeNoteId}::${nextTitle}::${nextContent}::${nextLink}`;
    if (sig === lastSavedSignatureRef.current) return;

    saveNote({
      id: activeNoteId,
      title: nextTitle || 'Focus note',
      content: nextContent,
      category: defaultCategory,
      ...links,
    });
    lastSavedSignatureRef.current = sig;
    setSaveLabel('Saved');
  };

  useEffect(() => {
    if (!title.trim() && !content.trim()) return;
    setSaveLabel('Saving...');
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      commitSave(title, content, selectedLink);
    }, 350);

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [title, content, selectedLink, activeNoteId]);

  const startFreshNote = () => {
    if (title.trim() || content.trim()) {
      commitSave(title, content, selectedLink);
    }
    const freshId = generateId();
    setActiveNoteId(freshId);
    setTitle('');
    setContent('');
    lastSavedSignatureRef.current = '';
    setSaveLabel('New note');
  };

  const loadExistingNote = (note: QuickNote) => {
    setActiveNoteId(note.id);
    setTitle(note.title);
    setContent(note.content);
    if (note.linkedActivityId) setSelectedLink(`activity:${note.linkedActivityId}`);
    else if (note.linkedTaskId) setSelectedLink(`task:${note.linkedTaskId}`);
    else if (note.linkedFocusSessionId) setSelectedLink(`session:${note.linkedFocusSessionId}`);
    else setSelectedLink('');
    lastSavedSignatureRef.current = `${note.id}::${note.title}::${note.content}`;
    setSaveLabel('Saved');
  };

  const recentQuotesAndNotes = useMemo(() => {
    return {
      notes: state.notes.filter((n) => n.id !== activeNoteId).slice(0, 4),
      quotes: state.quotations.slice(0, 4),
    };
  }, [state.notes, state.quotations, activeNoteId]);

  return (
    <section
      aria-label="Quick notes"
      className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BiIcon name="sticky" className="text-[15px] text-[var(--df-text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--df-text)]">
            Quick notes
          </h2>
        </div>

        <div className="flex items-center gap-2.5">
          <span className="text-[11px] font-medium text-[var(--df-text-subtle)]">
            {saveLabel}
          </span>
          <button
            type="button"
            onClick={startFreshNote}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--df-border)] px-2 py-1 text-[11px] font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)]"
          >
            <BiIcon name="plus-lg" className="text-[12px]" />
            New
          </button>
        </div>
      </div>

      {/* Distraction-free note surface */}
      <div className="mt-3 space-y-2.5">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => commitSave(title, content, selectedLink)}
          placeholder="Note title (optional)"
          aria-label="Quick note title"
          className="w-full rounded-xl border border-transparent bg-[var(--df-bg)] px-3 py-2 text-sm font-semibold text-[var(--df-text)] placeholder:font-normal placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border)] focus:outline-none"
        />

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onBlur={() => commitSave(title, content, selectedLink)}
          rows={5}
          placeholder="Jot down thoughts, formulas, blockers, or study takeaways..."
          aria-label="Quick note content"
          className="w-full resize-y rounded-xl border border-transparent bg-[var(--df-bg)] px-3 py-2.5 text-sm leading-relaxed text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border)] focus:outline-none"
        />

        <div className="flex items-center justify-between gap-2">
          <select
            value={selectedLink}
            onChange={(e) => setSelectedLink(e.target.value)}
            aria-label="Link note to item"
            className="min-w-0 flex-1 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-2 text-xs text-[var(--df-text-muted)] focus:border-[var(--df-border-strong)] focus:outline-none"
          >
            <option value="">Unlinked note</option>
            {state.activities.slice(0, 12).map((a) => (
              <option key={a.id} value={`activity:${a.id}`}>
                Activity: {a.title}
              </option>
            ))}
            {state.tasks
              .filter((t) => !t.completed)
              .slice(0, 10)
              .map((t) => (
                <option key={t.id} value={`task:${t.id}`}>
                  Task: {t.title}
                </option>
              ))}
            {state.focusSessions.slice(0, 6).map((s) => (
              <option key={s.id} value={`session:${s.id}`}>
                Session: {s.activityTitle || 'Deep Focus'} ({s.date})
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setActivePage('capture')}
            className="text-xs font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)] whitespace-nowrap shrink-0"
          >
            All notes →
          </button>
        </div>
      </div>

      {/* Collapsible recent notes & PDF quotations */}
      {(recentQuotesAndNotes.notes.length > 0 || recentQuotesAndNotes.quotes.length > 0) && (
        <div className="mt-4 border-t border-[var(--df-border)] pt-3">
          <button
            type="button"
            onClick={() => setShowRefs((v) => !v)}
            className="flex w-full items-center justify-between text-left text-xs font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
          >
            <span className="inline-flex items-center gap-1.5">
              <BiIcon name="book" className="text-[13px]" />
              Saved notes &amp; PDF quotes
            </span>
            <BiIcon name={showRefs ? 'chevron-up' : 'chevron-down'} className="text-[13px]" />
          </button>

          {showRefs && (
            <div className="mt-2.5 space-y-2 max-h-48 overflow-y-auto">
              {recentQuotesAndNotes.notes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => loadExistingNote(note)}
                  className="block w-full rounded-xl bg-[var(--df-bg)] px-3 py-2 text-left transition-colors hover:bg-[var(--df-surface-hover)]"
                >
                  <p className="truncate text-xs font-semibold text-[var(--df-text)]">
                    {note.title || 'Untitled note'}
                  </p>
                  <p className="line-clamp-1 text-[11px] text-[var(--df-text-muted)]">
                    {note.content}
                  </p>
                </button>
              ))}

              {recentQuotesAndNotes.quotes.map((q) => (
                <div
                  key={q.id}
                  className="rounded-xl bg-[var(--df-bg)] px-3 py-2"
                >
                  <p className="line-clamp-2 text-xs italic text-[var(--df-text)]">
                    &ldquo;{q.text}&rdquo;
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--df-text-muted)]">
                    {q.sourceFile}
                    {q.pageNumber ? ` · p. ${q.pageNumber}` : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
