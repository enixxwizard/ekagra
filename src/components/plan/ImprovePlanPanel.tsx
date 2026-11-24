import React, { useEffect, useMemo, useState } from 'react';
import { useDayFlow } from '../../context/DayFlowContext';
import { useAuth } from '../../hooks/useAuth';
import {
  buildWorkspaceSnapshotForAi,
  requestScheduleEnhancement,
  type ScheduleEnhancementApiResult,
  type ScheduleEnhancementFallbackReason,
} from '../../services/aiBrainService';
import type {
  ScheduleEnhancementChange,
  ScheduleEnhancementSuggestion,
} from '../../types/eku';
import { formatTimeDisplay, getCurrentLocalMinutes, getTodayISO } from '../../utils/dateTime';
import {
  formatChangeSummaryLine,
  validateScheduleSuggestions,
} from '../../utils/scheduleEngine';
import { BiIcon } from '../ui/BiIcon';

type EnhanceUiStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

const LOADING_STEPS: Array<{ label: string; percent: number }> = [
  { label: 'Preparing anonymized schedule snapshot…', percent: 25 },
  { label: 'Sending schedule to Gemini AI coach…', percent: 62 },
  { label: 'Validating conflict-free time slots…', percent: 88 },
];

const FALLBACK_LABELS: Record<ScheduleEnhancementFallbackReason, string> = {
  missing_key: 'Missing Credentials',
  invalid_key: 'Invalid API Key',
  quota_exhausted: 'Quota Exhausted',
  model_unavailable: 'Model Unavailable',
  network_error: 'Network Error',
  upstream_error: 'Upstream Service Error',
};

interface EditingDraft {
  suggestionId: string;
  changes: ScheduleEnhancementChange[];
  error: string;
}

export const ImprovePlanPanel: React.FC = () => {
  const { status: authStatus, session } = useAuth();
  const { state, remainingSeconds, applyScheduleEnhancements, pushToast } = useDayFlow();

  const [uiStatus, setUiStatus] = useState<EnhanceUiStatus>('idle');
  const [loadingStepIdx, setLoadingStepIdx] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState<ScheduleEnhancementApiResult | null>(null);
  const [appliedIds, setAppliedIds] = useState<Record<string, boolean>>({});
  const [dismissedIds, setDismissedIds] = useState<Record<string, boolean>>({});
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<EditingDraft | null>(null);

  useEffect(() => {
    if (uiStatus !== 'loading') {
      setLoadingStepIdx(0);
      return;
    }
    const t1 = window.setTimeout(() => setLoadingStepIdx(1), 350);
    const t2 = window.setTimeout(() => setLoadingStepIdx(2), 1800);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [uiStatus]);

  const authCreds = useMemo(
    () => ({
      accessToken: session?.access_token ?? null,
      isGuest: authStatus === 'guest',
    }),
    [session?.access_token, authStatus]
  );

  const handleAnalyzePlan = async (forceRefresh = false) => {
    if (uiStatus === 'loading') return;

    setLoadingStepIdx(0);
    setUiStatus('loading');
    setErrorMessage('');
    setEditingDraft(null);

    try {
      const snapshot = buildWorkspaceSnapshotForAi(state, remainingSeconds);
      const data = await requestScheduleEnhancement(authCreds, snapshot, forceRefresh);
      setResult(data);
      setAppliedIds({});
      setDismissedIds({});
      setUiStatus(data.suggestions.length > 0 ? 'success' : 'empty');
    } catch (err) {
      setErrorMessage(
        err instanceof Error && err.message.trim()
          ? err.message
          : 'Unable to analyze your schedule right now. Please retry.'
      );
      setUiStatus('error');
    }
  };

  const applyChangeset = async (
    suggestionId: string,
    title: string,
    changes: ScheduleEnhancementChange[]
  ): Promise<boolean> => {
    if (applyingId) return false;
    setApplyingId(suggestionId);
    try {
      const res = await applyScheduleEnhancements(changes);
      if (!res.persisted) {
        pushToast({
          type: 'error',
          title: 'Could not apply plan update',
          description: res.error || 'Please review your schedule and retry.',
        });
        return false;
      }

      setAppliedIds((prev) => ({ ...prev, [suggestionId]: true }));
      setEditingDraft((curr) => (curr?.suggestionId === suggestionId ? null : curr));
      pushToast({
        type: 'success',
        title: 'Schedule updated',
        description: `Applied "${title}" (${res.appliedCount} change${
          res.appliedCount === 1 ? '' : 's'
        }).`,
      });
      return true;
    } finally {
      setApplyingId(null);
    }
  };

  const handleStartEdit = (suggestion: ScheduleEnhancementSuggestion) => {
    setEditingDraft({
      suggestionId: suggestion.id,
      changes: suggestion.changes.map((c) => ({ ...c })),
      error: '',
    });
  };

  const handleSaveEditedSuggestion = async (suggestion: ScheduleEnhancementSuggestion) => {
    if (!editingDraft || editingDraft.suggestionId !== suggestion.id) return;

    const candidateSuggestion: ScheduleEnhancementSuggestion = {
      ...suggestion,
      changes: editingDraft.changes,
    };
    const validation = validateScheduleSuggestions([candidateSuggestion], {
      activities: state.activities,
      tasks: state.tasks,
      todayISO: getTodayISO(),
      nowMinutes: getCurrentLocalMinutes(),
    });

    if (validation.validSuggestions.length === 0) {
      setEditingDraft({
        ...editingDraft,
        error:
          validation.rejectedReasons[0] ||
          'Edited time conflicts with an existing block or falls in the past.',
      });
      return;
    }

    await applyChangeset(suggestion.id, suggestion.title, validation.validSuggestions[0].changes);
  };

  const updateDraftChangeField = (
    index: number,
    field: 'date' | 'startTime' | 'endTime',
    value: string
  ) => {
    setEditingDraft((curr) => {
      if (!curr) return null;
      const nextChanges = curr.changes.map((ch, idx) => {
        if (idx !== index) return ch;
        if (ch.type === 'reschedule_activity') {
          if (field === 'date') return { ...ch, newDate: value };
          if (field === 'startTime') return { ...ch, newStartTime: value };
          return { ...ch, newEndTime: value };
        }
        return { ...ch, [field]: value };
      });
      return { ...curr, changes: nextChanges, error: '' };
    });
  };

  const visibleSuggestions = useMemo(
    () => (result?.suggestions ?? []).filter((s) => !dismissedIds[s.id]),
    [result?.suggestions, dismissedIds]
  );

  return (
    <section
      aria-label="Ekagra AI Schedule Enhancer"
      data-testid="improve-plan-section"
      className="rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-5 sm:p-6"
    >
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-base font-bold text-[var(--df-text)] sm:text-lg">
              AI Schedule Coach
            </h2>
            {result && uiStatus !== 'loading' && (
              <span
                data-testid="ai-coach-status-badge"
                className={`rounded-lg px-2 py-0.5 text-[10px] font-semibold ${
                  result.source === 'gemini'
                    ? 'bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]'
                    : 'bg-[var(--df-surface-muted)] text-[var(--df-text-muted)]'
                }`}
              >
                {result.source === 'gemini' ? 'Gemini AI Active' : 'Local Algorithmic Fallback'}
                {result.source === 'gemini' && result.cached ? ' · Cached' : ''}
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
            Detect conflicts, balance daily study capacity, schedule backlog tasks, and add recovery breaks.
          </p>
        </div>

        <button
          type="button"
          data-testid="improve-plan-btn"
          disabled={uiStatus === 'loading'}
          onClick={() => void handleAnalyzePlan(uiStatus === 'success' || uiStatus === 'empty')}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-2xl bg-[var(--df-accent)] px-4 py-2.5 text-xs font-semibold text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap shrink-0"
        >
          <BiIcon
            name={uiStatus === 'loading' ? 'arrow-repeat' : 'stars'}
            spin={uiStatus === 'loading'}
            className="text-sm"
          />
          {uiStatus === 'loading'
            ? 'Analyzing your schedule...'
            : uiStatus === 'success' || uiStatus === 'empty'
            ? 'Re-analyze Plan'
            : 'Improve My Plan'}
        </button>
      </div>

      {/* Privacy & Free-Tier Transparency Note */}
      <p className="mt-2.5 text-[11px] text-[var(--df-text-subtle)]">
        Free-tier AI notice: sends anonymized schedule titles, times, and task durations to Gemini (private notes omitted).
      </p>

      {/* Loading Progress State */}
      {uiStatus === 'loading' && (
        <div
          role="status"
          data-testid="improve-plan-loading"
          className="mt-4 space-y-2 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 py-3 text-xs text-[var(--df-text-muted)]"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-medium text-[var(--df-text)]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--df-accent)]" />
              {LOADING_STEPS[loadingStepIdx]?.label ?? 'Analyzing your schedule…'}
            </span>
            <span className="font-mono text-[11px] tabular-nums">
              {LOADING_STEPS[loadingStepIdx]?.percent ?? 60}%
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--df-surface-muted)]">
            <div
              className="h-full rounded-full bg-[var(--df-accent)] transition-all duration-300"
              style={{ width: `${LOADING_STEPS[loadingStepIdx]?.percent ?? 60}%` }}
            />
          </div>
        </div>
      )}

      {/* Error State */}
      {uiStatus === 'error' && (
        <div
          role="alert"
          data-testid="improve-plan-error"
          className="mt-4 flex flex-col justify-between gap-3 rounded-2xl border border-rose-300 bg-rose-50/70 p-4 text-xs text-rose-950 sm:flex-row sm:items-center dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200"
        >
          <p className="font-medium">{errorMessage}</p>
          <button
            type="button"
            onClick={() => void handleAnalyzePlan(true)}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-xl border border-rose-300 bg-[var(--df-surface)] px-3 text-xs font-semibold text-[var(--df-text)] hover:border-rose-400"
          >
            Retry
          </button>
        </div>
      )}

      {/* Result State (Success or Empty) */}
      {(uiStatus === 'success' || uiStatus === 'empty') && result && (
        <div className="mt-4 space-y-4">
          {result.notice && (
            <div
              data-testid="ai-coach-fallback-notice"
              className="rounded-2xl border border-amber-300/80 bg-amber-50/70 px-3.5 py-2.5 text-xs text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200"
            >
              {result.fallbackReason && FALLBACK_LABELS[result.fallbackReason] && (
                <span className="mr-1.5 font-semibold">
                  [{FALLBACK_LABELS[result.fallbackReason]}]
                </span>
              )}
              {result.notice}
            </div>
          )}

          <div className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-4">
            <p className="text-sm font-semibold text-[var(--df-text)]">{result.summary}</p>
            {result.coachTips.length > 0 && (
              <ul className="mt-2.5 space-y-1.5 text-xs text-[var(--df-text-muted)]">
                {result.coachTips.map((tip, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <BiIcon
                      name="lightbulb"
                      className="mt-0.5 shrink-0 text-[11px] text-[var(--df-accent-soft-fg)]"
                    />
                    <span>{tip}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {visibleSuggestions.length === 0 ? (
            <div
              data-testid="improve-plan-empty"
              className="rounded-2xl border border-dashed border-[var(--df-border-strong)] p-4 text-center text-xs text-[var(--df-text-muted)]"
            >
              No pending schedule edits right now. Everything looks clean.
            </div>
          ) : (
            <div className="space-y-3" data-testid="improve-plan-suggestions">
              {visibleSuggestions.map((s) => {
                const isApplied = Boolean(appliedIds[s.id]);
                const isEditing = editingDraft?.suggestionId === s.id;
                const isBusy = applyingId === s.id;

                return (
                  <article
                    key={s.id}
                    className="rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-4 text-xs"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <h3 className="text-sm font-bold text-[var(--df-text)]">{s.title}</h3>
                        <p className="leading-relaxed text-[var(--df-text-muted)]">{s.reason}</p>
                      </div>
                      {isApplied && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--df-accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--df-accent-soft-fg)]">
                          <BiIcon name="check-circle-fill" className="text-[11px]" />
                          Applied
                        </span>
                      )}
                    </div>

                    <div className="mt-2.5 grid grid-cols-1 gap-2 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] p-2.5 text-[11px] sm:grid-cols-2">
                      <div>
                        <span className="font-semibold text-[var(--df-text-subtle)]">Before: </span>
                        <span className="text-[var(--df-text-muted)]">{s.beforePreview}</span>
                      </div>
                      <div>
                        <span className="font-semibold text-[var(--df-accent-soft-fg)]">After: </span>
                        <span className="text-[var(--df-text)]">{s.afterPreview}</span>
                      </div>
                    </div>

                    {!isEditing ? (
                      <div className="mt-2.5 space-y-1">
                        {s.changes.map((ch, idx) => (
                          <p key={idx} className="font-mono text-[11px] text-[var(--df-text)]">
                            • {formatChangeSummaryLine(ch)} (
                            {formatTimeDisplay(
                              ch.type === 'reschedule_activity' ? ch.newStartTime : ch.startTime,
                              state.settings.timeFormat
                            )}
                            )
                          </p>
                        ))}
                        {s.tradeOffs && (
                          <p className="text-[11px] text-[var(--df-text-subtle)]">
                            Trade-off: {s.tradeOffs}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2.5 rounded-xl border border-[var(--df-border-strong)] bg-[var(--df-surface)] p-3">
                        {editingDraft.changes.map((ch, idx) => {
                          const dateVal = ch.type === 'reschedule_activity' ? ch.newDate : ch.date;
                          const startVal =
                            ch.type === 'reschedule_activity' ? ch.newStartTime : ch.startTime;
                          const endVal =
                            ch.type === 'reschedule_activity' ? ch.newEndTime : ch.endTime;
                          const label =
                            ch.type === 'reschedule_activity'
                              ? ch.activityTitle
                              : ch.type === 'schedule_task'
                              ? ch.taskTitle
                              : ch.title;

                          return (
                            <div key={idx} className="space-y-1.5">
                              <p className="font-semibold text-[var(--df-text)]">{label}</p>
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                <input
                                  type="date"
                                  aria-label={`Edit date for ${label}`}
                                  value={dateVal}
                                  onChange={(e) =>
                                    updateDraftChangeField(idx, 'date', e.target.value)
                                  }
                                  className="rounded-lg border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-1.5 font-mono text-xs text-[var(--df-text)]"
                                />
                                <input
                                  type="time"
                                  aria-label={`Edit start time for ${label}`}
                                  value={startVal}
                                  onChange={(e) =>
                                    updateDraftChangeField(idx, 'startTime', e.target.value)
                                  }
                                  className="rounded-lg border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-1.5 font-mono text-xs text-[var(--df-text)]"
                                />
                                <input
                                  type="time"
                                  aria-label={`Edit end time for ${label}`}
                                  value={endVal}
                                  onChange={(e) =>
                                    updateDraftChangeField(idx, 'endTime', e.target.value)
                                  }
                                  className="rounded-lg border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-1.5 font-mono text-xs text-[var(--df-text)]"
                                />
                              </div>
                            </div>
                          );
                        })}

                        {editingDraft.error && (
                          <p className="text-[11px] font-medium text-rose-600 dark:text-rose-400">
                            {editingDraft.error}
                          </p>
                        )}

                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => setEditingDraft(null)}
                            className="rounded-xl border border-[var(--df-border)] px-3 py-1.5 text-[11px] font-medium text-[var(--df-text-muted)]"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleSaveEditedSuggestion(s)}
                            className="rounded-xl bg-[var(--df-accent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--df-accent-fg)] disabled:opacity-50"
                          >
                            {isBusy ? 'Applying...' : 'Save & Apply'}
                          </button>
                        </div>
                      </div>
                    )}

                    {!isApplied && !isEditing && (
                      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            setDismissedIds((prev) => ({ ...prev, [s.id]: true }))
                          }
                          className="rounded-xl border border-[var(--df-border)] px-3 py-1.5 text-[11px] font-medium text-[var(--df-text-muted)] hover:border-[var(--df-border-strong)] hover:text-[var(--df-text)]"
                        >
                          Dismiss
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleStartEdit(s)}
                          className="rounded-xl border border-[var(--df-border)] px-3 py-1.5 text-[11px] font-semibold text-[var(--df-text)] hover:border-[var(--df-border-strong)]"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void applyChangeset(s.id, s.title, s.changes)}
                          className="inline-flex items-center gap-1 rounded-xl bg-[var(--df-accent)] px-3.5 py-1.5 text-[11px] font-semibold text-[var(--df-accent-fg)] hover:brightness-95 disabled:opacity-50"
                        >
                          <BiIcon name="check2" className="text-xs" />
                          {isBusy ? 'Applying...' : 'Apply'}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
