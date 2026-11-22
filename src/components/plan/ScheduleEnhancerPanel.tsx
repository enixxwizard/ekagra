import React, { useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Edit3,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import { useDayFlow } from '../../context/DayFlowContext';
import type {
  EnhancerStatus,
  ScheduleEnhancementChange,
  ScheduleEnhancementResponseBody,
  ScheduleEnhancementSuggestion,
} from '../../types/scheduleEnhancer';
import {
  formatTimeDisplay,
  getCurrentLocalMinutes,
  getLocalTimeZoneName,
  getTodayISO,
} from '../../utils/dateTime';
import {
  buildEnhancerRequestPayload,
  logEnhancerDiagnostic,
  validateSingleChangeCandidate,
} from '../../utils/scheduleEnhancer';

export const ScheduleEnhancerPanel: React.FC = () => {
  const { state, applyScheduleEnhancements, pushToast } = useDayFlow();

  const [status, setStatus] = useState<EnhancerStatus>('idle');
  const [summary, setSummary] = useState<string>('');
  const [emptyMessage, setEmptyMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [suggestions, setSuggestions] = useState<ScheduleEnhancementSuggestion[]>([]);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  // Inline editor state for a single suggestion
  const [editingSuggestionId, setEditingSuggestionId] = useState<string | null>(null);
  const [draftChanges, setDraftChanges] = useState<ScheduleEnhancementChange[]>([]);

  const inFlightRef = useRef(false);
  const timeFormat = state.settings.timeFormat;

  const activityRecurringMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const act of state.activities) {
      map.set(act.id, (act.recurrence?.frequency ?? 'none') !== 'none');
    }
    return map;
  }, [state.activities]);

  const validateChangesLive = (changes: ScheduleEnhancementChange[]): string | null => {
    if (changes.length === 0) return 'No schedule changes selected.';
    const todayISO = getTodayISO();
    const nowMinutes = getCurrentLocalMinutes();

    for (const ch of changes) {
      const result = validateSingleChangeCandidate(ch, {
        activities: state.activities,
        tasks: state.tasks,
        todayISO,
        nowMinutes,
        siblingChanges: changes,
      });
      if (!result.valid) {
        return result.error ?? 'Proposed edit conflicts with your schedule.';
      }
    }
    return null;
  };

  const draftValidationError = useMemo(() => {
    if (!editingSuggestionId) return null;
    return validateChangesLive(draftChanges);
  }, [editingSuggestionId, draftChanges, state.activities, state.tasks]);

  const handleImprovePlan = async () => {
    logEnhancerDiagnostic('button_clicked', {
      currentStatus: status,
      inFlight: inFlightRef.current,
    });

    if (inFlightRef.current) return;

    setEditingSuggestionId(null);
    setDraftChanges([]);
    setCardErrors({});
    setErrorMessage('');
    setEmptyMessage('');

    const todayISO = getTodayISO();
    const nowMinutes = getCurrentLocalMinutes();
    const timeZone = getLocalTimeZoneName();

    logEnhancerDiagnostic('schedule_loaded', {
      activitiesCount: state.activities.length,
      tasksCount: state.tasks.length,
    });

    if (state.activities.length === 0) {
      setSuggestions([]);
      setSummary('');
      setEmptyMessage('Add activities to your schedule before requesting AI suggestions.');
      setStatus('empty');
      return;
    }

    inFlightRef.current = true;
    setStatus('loading');

    try {
      const payload = buildEnhancerRequestPayload({
        activities: state.activities,
        tasks: state.tasks,
        todayISO,
        nowMinutes,
        timeZone,
        dailyCapacityHours: state.settings.dailyCapacityHours,
      });

      const response = await fetch('/api/schedule/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = (await response.json().catch(() => null)) as
        | (ScheduleEnhancementResponseBody & { error?: string })
        | { error?: string }
        | null;

      if (!response.ok) {
        const msg =
          body && typeof body.error === 'string' && body.error.trim()
            ? body.error.trim()
            : `Schedule enhancer request failed (HTTP ${response.status}).`;
        logEnhancerDiagnostic('error_encountered', { status: response.status });
        setErrorMessage(msg);
        setStatus('error');
        return;
      }

      if (!body || !('status' in body)) {
        logEnhancerDiagnostic('error_encountered', { reason: 'malformed_response' });
        setErrorMessage('Received an unexpected response from the server. Please retry.');
        setStatus('error');
        return;
      }

      logEnhancerDiagnostic('suggestions_validated', {
        returnedCount: body.suggestions?.length ?? 0,
        rejectedCount: body.rejectedCount ?? 0,
      });

      if (body.status === 'empty' || !body.suggestions || body.suggestions.length === 0) {
        setSuggestions([]);
        setSummary(body.summary ?? '');
        setEmptyMessage(body.message || 'No meaningful improvements found');
        setStatus('empty');
        return;
      }

      setSuggestions(body.suggestions);
      setSummary(body.summary || 'Reviewed your upcoming week.');
      setStatus('success');
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? `Could not reach the schedule enhancer (${err.message}). Check your connection and retry.`
          : 'Could not reach the schedule enhancer. Please retry.';
      logEnhancerDiagnostic('error_encountered', { networkError: true });
      setErrorMessage(msg);
      setStatus('error');
    } finally {
      inFlightRef.current = false;
    }
  };

  const applyAndFinalizeSuggestion = (
    suggestionId: string,
    changesToApply: ScheduleEnhancementChange[],
    suggestionTitle: string
  ) => {
    const validationError = validateChangesLive(changesToApply);
    if (validationError) {
      setCardErrors((prev) => ({ ...prev, [suggestionId]: validationError }));
      return;
    }

    const { appliedCount } = applyScheduleEnhancements(changesToApply);
    if (appliedCount === 0) {
      setCardErrors((prev) => ({
        ...prev,
        [suggestionId]: 'Target item no longer matches your current schedule. Refresh suggestions to continue.',
      }));
      return;
    }

    setEditingSuggestionId(null);
    setDraftChanges([]);
    setCardErrors((prev) => {
      const next = { ...prev };
      delete next[suggestionId];
      return next;
    });

    setSuggestions((prev) => {
      const remaining = prev.filter((s) => s.id !== suggestionId);
      if (remaining.length === 0) {
        setEmptyMessage('All suggested improvements have been reviewed.');
        setStatus('empty');
      }
      return remaining;
    });

    pushToast({
      type: 'success',
      title: 'Schedule updated',
      description: suggestionTitle,
    });
  };

  const handleDismissSuggestion = (suggestionId: string) => {
    if (editingSuggestionId === suggestionId) {
      setEditingSuggestionId(null);
      setDraftChanges([]);
    }
    setCardErrors((prev) => {
      const next = { ...prev };
      delete next[suggestionId];
      return next;
    });
    setSuggestions((prev) => {
      const remaining = prev.filter((s) => s.id !== suggestionId);
      if (remaining.length === 0) {
        setEmptyMessage('Suggestions dismissed. Re-run anytime your schedule shifts.');
        setStatus('empty');
      }
      return remaining;
    });
  };

  const handleStartEdit = (suggestion: ScheduleEnhancementSuggestion) => {
    setEditingSuggestionId(suggestion.id);
    setDraftChanges(suggestion.changes.map((ch) => ({ ...ch })));
    setCardErrors((prev) => {
      const next = { ...prev };
      delete next[suggestion.id];
      return next;
    });
  };

  const handleCancelEdit = () => {
    setEditingSuggestionId(null);
    setDraftChanges([]);
  };

  const updateDraftChange = (index: number, patch: Record<string, string>) => {
    setDraftChanges((prev) =>
      prev.map((ch, i) => {
        if (i !== index) return ch;
        if (ch.type === 'reschedule_activity') {
          const nextNewDate = patch.newDate ?? ch.newDate;
          const nextScope =
            nextNewDate !== ch.occurrenceDate
              ? 'single'
              : (patch.scope as 'single' | 'series' | undefined) ?? ch.scope;
          return {
            ...ch,
            newDate: nextNewDate,
            newStartTime: patch.newStartTime ?? ch.newStartTime,
            newEndTime: patch.newEndTime ?? ch.newEndTime,
            scope: nextScope,
          };
        }
        if (ch.type === 'schedule_task') {
          return {
            ...ch,
            date: patch.date ?? ch.date,
            startTime: patch.startTime ?? ch.startTime,
            endTime: patch.endTime ?? ch.endTime,
          };
        }
        return {
          ...ch,
          title: patch.title ?? ch.title,
          date: patch.date ?? ch.date,
          startTime: patch.startTime ?? ch.startTime,
          endTime: patch.endTime ?? ch.endTime,
        };
      })
    );
  };

  const formatChangeText = (ch: ScheduleEnhancementChange): string => {
    if (ch.type === 'reschedule_activity') {
      return `Move "${ch.activityTitle}" to ${ch.newDate}, ${formatTimeDisplay(
        ch.newStartTime,
        timeFormat
      )} – ${formatTimeDisplay(ch.newEndTime, timeFormat)}${
        ch.scope === 'series' ? ' (entire series)' : ''
      }`;
    }
    if (ch.type === 'schedule_task') {
      return `Schedule "${ch.taskTitle}" on ${ch.date}, ${formatTimeDisplay(
        ch.startTime,
        timeFormat
      )} – ${formatTimeDisplay(ch.endTime, timeFormat)}`;
    }
    return `Insert "${ch.title}" on ${ch.date}, ${formatTimeDisplay(
      ch.startTime,
      timeFormat
    )} – ${formatTimeDisplay(ch.endTime, timeFormat)}`;
  };

  return (
    <section
      aria-label="AI Schedule Enhancer"
      className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5"
    >
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0 text-[var(--df-accent-soft-fg)]" />
            <h2 className="font-display text-base font-bold text-[var(--df-text)]">
              AI Schedule Coach
            </h2>
          </div>
          <p className="text-xs text-[var(--df-text-muted)]">
            Checks overlaps, capacity load, deadlines, and pacing using schedule blocks only (notes stay private).
          </p>
        </div>

        <button
          type="button"
          onClick={handleImprovePlan}
          disabled={status === 'loading'}
          data-testid="improve-my-plan-btn"
          className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-2xl bg-[var(--df-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap"
        >
          {status === 'loading' ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Analyzing...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Improve My Plan
            </>
          )}
        </button>
      </div>

      {/* Loading state */}
      {status === 'loading' && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-center gap-3 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] px-4 py-3.5 text-sm text-[var(--df-text)]"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--df-accent-soft-fg)]" />
          <span>Analyzing your schedule...</span>
        </div>
      )}

      {/* Empty state */}
      {status === 'empty' && (
        <div
          role="status"
          className="mt-4 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] px-4 py-3.5"
        >
          <p className="text-sm font-semibold text-[var(--df-text)]">{emptyMessage}</p>
          {summary && (
            <p className="mt-1 text-xs text-[var(--df-text-muted)]">{summary}</p>
          )}
        </div>
      )}

      {/* Error state */}
      {status === 'error' && (
        <div
          role="alert"
          className="mt-4 flex flex-col justify-between gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3.5 sm:flex-row sm:items-center"
        >
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
            <p className="text-xs font-medium text-[var(--df-text)]">{errorMessage}</p>
          </div>
          <button
            type="button"
            onClick={handleImprovePlan}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--df-border-strong)] bg-[var(--df-surface)] px-3 text-xs font-semibold text-[var(--df-text)] hover:bg-[var(--df-surface-hover)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      )}

      {/* Success state with validated suggestions */}
      {status === 'success' && suggestions.length > 0 && (
        <div className="mt-5 space-y-3">
          {summary && (
            <p className="text-xs font-medium text-[var(--df-text-muted)]">{summary}</p>
          )}

          {suggestions.map((sug) => {
            const isEditing = editingSuggestionId === sug.id;
            const activeChanges = isEditing ? draftChanges : sug.changes;
            const cardError = cardErrors[sug.id];

            return (
              <article
                key={sug.id}
                className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-4 space-y-3"
              >
                <div className="space-y-1">
                  <h3 className="font-display text-sm font-bold text-[var(--df-text)] sm:text-base">
                    {sug.title}
                  </h3>
                  <p className="text-xs leading-relaxed text-[var(--df-text)]">{sug.reason}</p>
                  <p className="text-[11px] text-[var(--df-text-muted)]">
                    <span className="font-semibold text-[var(--df-text)]">Evidence:</span>{' '}
                    {sug.evidence}
                  </p>
                </div>

                {/* Before / After Comparison */}
                <div className="grid grid-cols-1 gap-2 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] p-3 text-xs sm:grid-cols-2">
                  <div>
                    <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
                      Before
                    </span>
                    <span className="mt-0.5 block text-[var(--df-text)]">{sug.beforePreview}</span>
                  </div>
                  <div>
                    <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--df-accent-soft-fg)]">
                      After
                    </span>
                    <span className="mt-0.5 block font-medium text-[var(--df-text)]">
                      {sug.afterPreview}
                    </span>
                  </div>
                </div>

                {/* Concrete Proposed Changes or Inline Editor */}
                {!isEditing ? (
                  <ul className="space-y-1 text-xs text-[var(--df-text)]">
                    {activeChanges.map((ch, idx) => (
                      <li
                        key={`${sug.id}-ch-${idx}`}
                        className="rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 py-2 font-mono text-[11px]"
                      >
                        {formatChangeText(ch)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="space-y-2.5 rounded-xl border border-[var(--df-border-strong)] bg-[var(--df-surface)] p-3">
                    <p className="text-[11px] font-semibold text-[var(--df-text)]">
                      Edit proposed change before applying
                    </p>
                    {draftChanges.map((ch, idx) => {
                      const isRecurringTarget =
                        ch.type === 'reschedule_activity' &&
                        Boolean(activityRecurringMap.get(ch.activityId));

                      return (
                        <div
                          key={`${sug.id}-edit-${idx}`}
                          className="space-y-2 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] p-2.5"
                        >
                          {ch.type === 'insert_break' ? (
                            <label className="block text-[11px] text-[var(--df-text-muted)]">
                              Break title
                              <input
                                type="text"
                                value={ch.title}
                                maxLength={60}
                                onChange={(e) =>
                                  updateDraftChange(idx, { title: e.target.value })
                                }
                                className="mt-1 w-full rounded-lg border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 py-1.5 text-xs text-[var(--df-text)]"
                              />
                            </label>
                          ) : (
                            <p className="text-xs font-semibold text-[var(--df-text)]">
                              {ch.type === 'reschedule_activity' ? ch.activityTitle : ch.taskTitle}
                            </p>
                          )}

                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            <label className="block text-[11px] text-[var(--df-text-muted)]">
                              Date
                              <input
                                type="date"
                                value={ch.type === 'reschedule_activity' ? ch.newDate : ch.date}
                                onChange={(e) =>
                                  updateDraftChange(
                                    idx,
                                    ch.type === 'reschedule_activity'
                                      ? { newDate: e.target.value }
                                      : { date: e.target.value }
                                  )
                                }
                                className="mt-1 w-full rounded-lg border border-[var(--df-border)] bg-[var(--df-surface)] px-2 py-1.5 font-mono text-xs text-[var(--df-text)]"
                              />
                            </label>
                            <label className="block text-[11px] text-[var(--df-text-muted)]">
                              Start
                              <input
                                type="time"
                                value={
                                  ch.type === 'reschedule_activity'
                                    ? ch.newStartTime
                                    : ch.startTime
                                }
                                onChange={(e) =>
                                  updateDraftChange(
                                    idx,
                                    ch.type === 'reschedule_activity'
                                      ? { newStartTime: e.target.value }
                                      : { startTime: e.target.value }
                                  )
                                }
                                className="mt-1 w-full rounded-lg border border-[var(--df-border)] bg-[var(--df-surface)] px-2 py-1.5 font-mono text-xs text-[var(--df-text)]"
                              />
                            </label>
                            <label className="block text-[11px] text-[var(--df-text-muted)]">
                              End
                              <input
                                type="time"
                                value={
                                  ch.type === 'reschedule_activity' ? ch.newEndTime : ch.endTime
                                }
                                onChange={(e) =>
                                  updateDraftChange(
                                    idx,
                                    ch.type === 'reschedule_activity'
                                      ? { newEndTime: e.target.value }
                                      : { endTime: e.target.value }
                                  )
                                }
                                className="mt-1 w-full rounded-lg border border-[var(--df-border)] bg-[var(--df-surface)] px-2 py-1.5 font-mono text-xs text-[var(--df-text)]"
                              />
                            </label>
                          </div>

                          {ch.type === 'reschedule_activity' &&
                            isRecurringTarget &&
                            ch.newDate === ch.occurrenceDate && (
                              <label className="block text-[11px] text-[var(--df-text-muted)]">
                                Recurring scope
                                <select
                                  value={ch.scope}
                                  onChange={(e) =>
                                    updateDraftChange(idx, { scope: e.target.value })
                                  }
                                  className="mt-1 w-full rounded-lg border border-[var(--df-border)] bg-[var(--df-surface)] px-2 py-1.5 text-xs text-[var(--df-text)]"
                                >
                                  <option value="single">This occurrence only</option>
                                  <option value="series">Entire recurring series</option>
                                </select>
                              </label>
                            )}
                        </div>
                      );
                    })}

                    {draftValidationError && (
                      <p className="text-xs font-medium text-rose-500">{draftValidationError}</p>
                    )}
                  </div>
                )}

                <p className="text-[11px] text-[var(--df-text-muted)]">
                  <span className="font-semibold text-[var(--df-text)]">Trade-off:</span>{' '}
                  {sug.tradeOffs}
                </p>

                {cardError && (
                  <p className="text-xs font-medium text-rose-500">{cardError}</p>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        disabled={Boolean(draftValidationError)}
                        onClick={() =>
                          applyAndFinalizeSuggestion(sug.id, draftChanges, sug.title)
                        }
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-3.5 text-xs font-semibold text-[var(--df-accent-fg)] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Save &amp; Apply
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 text-xs font-semibold text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          applyAndFinalizeSuggestion(sug.id, sug.changes, sug.title)
                        }
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-3.5 text-xs font-semibold text-[var(--df-accent-fg)] hover:brightness-95"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Apply
                      </button>
                      <button
                        type="button"
                        onClick={() => handleStartEdit(sug)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 text-xs font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)]"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDismissSuggestion(sug.id)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-transparent px-2.5 text-xs font-semibold text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
                      >
                        <X className="h-3.5 w-3.5" />
                        Dismiss
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
