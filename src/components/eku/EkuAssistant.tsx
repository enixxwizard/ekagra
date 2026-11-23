import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDayFlow } from '../../context/DayFlowContext';
import { useAuth } from '../../hooks/useAuth';
import { useEkuVoice } from '../../hooks/useEkuVoice';
import type {
  EkuAvatarEmotion,
  EkuChatMessage,
  EkuChatResponseBody,
  EkuPendingProposal,
  EkuResourceItem,
  EkuResourceType,
  EkuWorkspaceSnapshot,
} from '../../types/eku';
import { CATEGORY_DEFAULT_COLORS } from '../../utils/colors';
import {
  formatTimeDisplay,
  generateId,
  getCurrentLocalMinutes,
  getLocalTimeZoneName,
  getTodayISO,
} from '../../utils/dateTime';
import { formatChangeSummaryLine, stripActivitiesAndTasksForEku } from '../../utils/scheduleEngine';
import { BiIcon } from '../ui/BiIcon';
import { EkuAvatar } from './EkuAvatar';

const STARTER_PROMPTS = [
  'Manage my best possible schedule for tomorrow',
  "What's my next task?",
  'Start a 45-minute focus session',
  'Find study resources on DBMS',
];

const RESOURCE_TYPE_LABELS: Record<EkuResourceType, string> = {
  youtube_video: 'YouTube Video',
  direct_pdf: 'Direct PDF',
  pdf_host_page: 'PDF Page',
  official_docs: 'Official Docs',
  university_notes: 'University Notes',
  educational_site: 'Study Guide',
};

function isSafeHttpsLink(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

export const EkuAssistant: React.FC = () => {
  const { status: authStatus, session } = useAuth();
  const {
    state,
    activePage,
    setActivePage,
    remainingSeconds,
    isFocusFullscreen,
    isDeepFocusActive,
    applyScheduleEnhancements,
    saveTask,
    saveActivity,
    startFocusSession,
    pauseTimer,
    updateSettings,
    pushToast,
  } = useDayFlow();

  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [statusEmotion, setStatusEmotion] = useState<EkuAvatarEmotion>('idle');
  const [messages, setMessages] = useState<EkuChatMessage[]>(() => [
    {
      id: 'eku-welcome',
      role: 'assistant',
      text: "Hi, I'm Eku! Ask me to organize tomorrow's schedule, start a focus timer, set a study reminder, or find curated resources in your preferred language.",
      timestamp: new Date().toISOString(),
    },
  ]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const muted = Boolean(state.settings.ekuMuted);
  const preferredLanguage = state.settings.preferredResourceLanguage ?? null;

  const voice = useEkuVoice({
    muted,
    preferredLanguage,
  });

  // Hide or auto-collapse drawer cleanly during Deep Focus Mode
  useEffect(() => {
    if (isDeepFocusActive) {
      setIsOpen(false);
      voice.stopListening();
      voice.stopSpeaking();
    }
  }, [isDeepFocusActive, voice.stopListening, voice.stopSpeaking]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading, isOpen]);

  // Reset transient success/error avatar back to idle after a moment
  useEffect(() => {
    if (statusEmotion !== 'success' && statusEmotion !== 'error') return;
    const t = setTimeout(() => setStatusEmotion('idle'), 3200);
    return () => clearTimeout(t);
  }, [statusEmotion]);

  const visualEmotion: EkuAvatarEmotion = voice.isListening
    ? 'listening'
    : isLoading
    ? 'thinking'
    : voice.isSpeaking
    ? 'speaking'
    : statusEmotion;

  const statusSubtitle = voice.isListening
    ? 'Listening...'
    : isLoading
    ? 'Thinking...'
    : voice.isSpeaking
    ? 'Speaking...'
    : statusEmotion === 'error'
    ? 'Needs attention'
    : preferredLanguage
    ? `Ready · ${preferredLanguage}`
    : 'Ready to help';

  const buildSnapshot = (): EkuWorkspaceSnapshot => {
    const todayISO = getTodayISO();
    const { activities, tasks } = stripActivitiesAndTasksForEku(state.activities, state.tasks);
    const todayFocusMinutes = state.focusSessions
      .filter((s) => s.date === todayISO && s.mode === 'focus')
      .reduce((sum, s) => sum + s.actualMinutes, 0);
    const weeklyFocusMinutes = state.focusSessions
      .filter((s) => s.mode === 'focus')
      .slice(0, 35)
      .reduce((sum, s) => sum + s.actualMinutes, 0);
    const linkedTitle = state.activeTimer.linkedActivityId
      ? state.activities.find((a) => a.id === state.activeTimer.linkedActivityId)?.title ?? null
      : null;

    return {
      todayISO,
      nowMinutes: getCurrentLocalMinutes(),
      timeZone: getLocalTimeZoneName(),
      dailyCapacityHours: state.settings.dailyCapacityHours,
      preferredLanguage,
      activities,
      tasks,
      focusSummary: {
        timerStatus: state.activeTimer.status,
        timerMode: state.activeTimer.mode,
        remainingMinutes: Math.max(0, Math.ceil(remainingSeconds / 60)),
        linkedActivityTitle: linkedTitle,
        todayFocusMinutes,
        weeklyFocusMinutes,
        todayHabitsCompleted: (state.habitLogs[todayISO] ?? []).length,
        totalHabits: state.habits.length,
      },
    };
  };

  const sendMessage = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || isLoading) return;

    voice.clearVoiceError();
    const userMsg: EkuChatMessage = {
      id: generateId(),
      role: 'user',
      text: trimmed,
      timestamp: new Date().toISOString(),
    };

    const historyPayload = messages
      .filter((m) => m.id !== 'eku-welcome' && !m.isError)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.text }));

    setMessages((prev) => [...prev, userMsg]);
    setInputValue('');
    setIsLoading(true);
    setStatusEmotion('thinking');

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authStatus === 'authenticated' && session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`;
      } else {
        headers['X-Ekagra-Mode'] = 'guest';
      }

      const response = await fetch('/api/eku/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: trimmed,
          history: historyPayload,
          snapshot: buildSnapshot(),
        }),
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error('Received an unexpected non-JSON response from the server.');
      }

      const payload = (await response.json()) as Partial<EkuChatResponseBody> & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(
          typeof payload.error === 'string' && payload.error.trim()
            ? payload.error
            : `Request failed (HTTP ${response.status}).`
        );
      }

      const replyText =
        typeof payload.reply === 'string' && payload.reply.trim()
          ? payload.reply.trim()
          : 'Done.';

      if (payload.detectedPreferredLanguage) {
        updateSettings({ preferredResourceLanguage: payload.detectedPreferredLanguage });
      }

      // Apply safe immediate focus timer commands
      const focusActions = Array.isArray(payload.focusActions) ? payload.focusActions : [];
      for (const act of focusActions) {
        if (act.type === 'start_focus') {
          startFocusSession(act.durationMinutes, act.mode, act.activityId ?? undefined);
          pushToast({
            type: 'success',
            title: `${act.durationMinutes}m focus started`,
            description: act.activityTitle
              ? `Linked to ${act.activityTitle}`
              : 'Eku started your timer.',
          });
        } else if (act.type === 'pause_focus') {
          pauseTimer();
          pushToast({
            type: 'info',
            title: 'Focus timer paused',
          });
        }
      }

      const assistantMsg: EkuChatMessage = {
        id: generateId(),
        role: 'assistant',
        text: replyText,
        timestamp: new Date().toISOString(),
        proposals: Array.isArray(payload.proposals) ? payload.proposals : [],
        focusActions,
        resources: Array.isArray(payload.resources) ? payload.resources : [],
        languageNotice: payload.languageNotice ?? null,
      };

      setMessages((prev) => [...prev, assistantMsg]);
      setStatusEmotion(payload.emotion === 'success' ? 'success' : 'idle');

      if (!muted) {
        voice.speak(replyText);
      }
    } catch (err) {
      const errorText =
        err instanceof Error && err.message.trim()
          ? err.message
          : 'Unable to reach Eku right now. Please try again.';
      setStatusEmotion('error');
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: 'assistant',
          text: errorText,
          timestamp: new Date().toISOString(),
          isError: true,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const updateProposalStatus = (
    messageId: string,
    proposalId: string,
    nextStatus: 'approved' | 'dismissed'
  ) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              proposals: m.proposals?.map((p) =>
                p.id === proposalId ? { ...p, status: nextStatus } : p
              ),
            }
          : m
      )
    );
  };

  const handleApproveProposal = async (
    messageId: string,
    proposal: EkuPendingProposal
  ) => {
    if (proposal.status !== 'pending' || applyingId) return;
    setApplyingId(proposal.id);

    try {
      if (proposal.kind === 'schedule_changes') {
        const res = await applyScheduleEnhancements(proposal.changes);
        if (!res.persisted) {
          pushToast({
            type: 'error',
            title: 'Could not apply changes',
            description: res.error || 'Please review your schedule and retry.',
          });
          return;
        }
        updateProposalStatus(messageId, proposal.id, 'approved');
        setStatusEmotion('success');
        pushToast({
          type: 'success',
          title: 'Schedule updated',
          description: `Saved ${res.appliedCount} approved change${res.appliedCount === 1 ? '' : 's'}.`,
        });
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'assistant',
            text: `Applied and saved "${proposal.title}" to your calendar.`,
            timestamp: new Date().toISOString(),
          },
        ]);
      } else if (proposal.kind === 'create_task') {
        saveTask({
          title: proposal.taskTitle,
          description: 'Added via Eku',
          priority: proposal.priority,
          dueDate: proposal.dueDate,
          category: proposal.category,
          estimatedMinutes: proposal.estimatedMinutes,
        });
        updateProposalStatus(messageId, proposal.id, 'approved');
        setStatusEmotion('success');
        pushToast({
          type: 'success',
          title: 'Task saved',
          description: proposal.taskTitle,
        });
      } else if (proposal.kind === 'create_reminder') {
        saveActivity({
          title: proposal.reminderTitle,
          description: 'Reminder created with Eku',
          date: proposal.date,
          startTime: proposal.startTime,
          endTime: proposal.endTime,
          category: proposal.category,
          color: CATEGORY_DEFAULT_COLORS[proposal.category] ?? 'indigo',
          priority: proposal.priority,
          status: 'pending',
          recurrence: { frequency: 'none', endDate: null },
        });
        updateProposalStatus(messageId, proposal.id, 'approved');
        setStatusEmotion('success');
        pushToast({
          type: 'success',
          title: 'Reminder scheduled',
          description: `${proposal.reminderTitle} at ${formatTimeDisplay(
            proposal.startTime,
            state.settings.timeFormat
          )}`,
        });
      }
    } finally {
      setApplyingId(null);
    }
  };

  const handleMicToggle = () => {
    if (voice.isListening) {
      voice.stopListening();
      return;
    }
    void voice.startListening((transcript) => {
      void sendMessage(transcript);
    });
  };

  const handleClearChat = () => {
    voice.stopSpeaking();
    setMessages([
      {
        id: 'eku-welcome',
        role: 'assistant',
        text: "Fresh start! How can I help with your schedule, focus timer, or study resources?",
        timestamp: new Date().toISOString(),
      },
    ]);
    setStatusEmotion('idle');
  };

  const renderProposalCard = (messageId: string, proposal: EkuPendingProposal) => {
    const isApplying = applyingId === proposal.id;
    const isPending = proposal.status === 'pending';

    return (
      <div
        key={proposal.id}
        className="mt-2.5 rounded-2xl border border-[var(--df-border-strong)] bg-[var(--df-bg)] p-3 text-xs"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold text-[var(--df-text)]">{proposal.title}</p>
            {proposal.kind === 'schedule_changes' && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--df-text-muted)]">
                {proposal.reason}
              </p>
            )}
            {proposal.kind === 'create_task' && (
              <p className="mt-0.5 text-[11px] text-[var(--df-text-muted)]">
                {proposal.category} · {proposal.priority} priority · ~{proposal.estimatedMinutes}m
                {proposal.dueDate ? ` · Due ${proposal.dueDate}` : ''}
              </p>
            )}
            {proposal.kind === 'create_reminder' && (
              <p className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--df-text-muted)]">
                {proposal.date} · {formatTimeDisplay(proposal.startTime, state.settings.timeFormat)} –{' '}
                {formatTimeDisplay(proposal.endTime, state.settings.timeFormat)}
              </p>
            )}
          </div>
          {proposal.status === 'approved' && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--df-accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--df-accent-soft-fg)]">
              <BiIcon name="check-circle-fill" className="text-[11px]" />
              Saved
            </span>
          )}
          {proposal.status === 'dismissed' && (
            <span className="shrink-0 text-[10px] font-medium text-[var(--df-text-subtle)]">
              Dismissed
            </span>
          )}
        </div>

        {proposal.kind === 'schedule_changes' && (
          <div className="mt-2 space-y-1.5 border-t border-[var(--df-border)] pt-2">
            {proposal.changes.map((ch, idx) => (
              <p
                key={`${proposal.id}-ch-${idx}`}
                className="font-mono text-[11px] leading-snug text-[var(--df-text)]"
              >
                • {formatChangeSummaryLine(ch)}
              </p>
            ))}
            {proposal.tradeOffs && (
              <p className="text-[11px] text-[var(--df-text-muted)]">
                Trade-off: {proposal.tradeOffs}
              </p>
            )}
          </div>
        )}

        {proposal.kind === 'create_reminder' && proposal.hasConflictWarning && (
          <p className="mt-1.5 rounded-lg bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
            Heads up: {proposal.hasConflictWarning}
          </p>
        )}

        {isPending && (
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={isApplying}
              onClick={() => updateProposalStatus(messageId, proposal.id, 'dismissed')}
              className="rounded-xl border border-[var(--df-border)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--df-text-muted)] hover:border-[var(--df-border-strong)] hover:text-[var(--df-text)]"
            >
              Dismiss
            </button>
            <button
              type="button"
              disabled={isApplying}
              onClick={() => void handleApproveProposal(messageId, proposal)}
              className="inline-flex items-center gap-1 rounded-xl bg-[var(--df-accent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--df-accent-fg)] hover:brightness-95 disabled:opacity-50"
            >
              <BiIcon name="check2" className="text-xs" />
              {isApplying ? 'Saving...' : 'Approve & Apply'}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderResourceCard = (res: EkuResourceItem) => {
    const safeUrl = isSafeHttpsLink(res.url);
    return (
      <div
        key={res.id}
        className="mt-2 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] p-2.5 text-xs"
      >
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--df-text-muted)]">
          <span className="rounded-md bg-[var(--df-surface-muted)] px-1.5 py-0.5 text-[var(--df-text)]">
            {RESOURCE_TYPE_LABELS[res.resourceType] || 'Resource'}
          </span>
          <span className="rounded-md bg-[var(--df-accent-soft)] px-1.5 py-0.5 text-[var(--df-accent-soft-fg)]">
            {res.language}
          </span>
          <span className="truncate font-normal normal-case">{res.sourceName}</span>
        </div>

        {safeUrl ? (
          <a
            href={res.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 flex items-start justify-between gap-2 font-semibold text-[var(--df-text)] hover:underline"
          >
            <span className="line-clamp-2 leading-snug">{res.title}</span>
            <BiIcon name="box-arrow-up-right" className="mt-0.5 shrink-0 text-[11px] text-[var(--df-text-muted)]" />
          </a>
        ) : (
          <p className="mt-1.5 font-semibold text-[var(--df-text)]">{res.title}</p>
        )}

        {res.snippet && (
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--df-text-muted)]">
            {res.snippet}
          </p>
        )}
        {res.disclaimer && (
          <p className="mt-1 text-[10px] italic text-[var(--df-text-subtle)]">
            {res.disclaimer}
          </p>
        )}
      </div>
    );
  };

  const showQuickStarters = useMemo(
    () => messages.length <= 1 && !isLoading,
    [messages.length, isLoading]
  );

  // Completely hide Eku during fullscreen Focus Mode
  if (isFocusFullscreen) {
    return null;
  }

  // Minimized calm corner pill when timer is actively running in Focus view
  if (isDeepFocusActive && !isOpen) {
    return (
      <div className="fixed right-4 bottom-20 z-40 md:right-6 md:bottom-6">
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-label="Restore Eku assistant (minimized during focus)"
          title="Eku is minimized during Deep Focus"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--df-border)] bg-[var(--df-surface)] opacity-45 shadow-sm transition-opacity hover:opacity-95"
        >
          <EkuAvatar emotion="idle" size="sm" />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed right-4 bottom-20 z-40 flex flex-col items-end gap-3 md:right-6 md:bottom-6">
      {isOpen && (
        <section
          aria-label="Eku AI Assistant"
          className="animate-sheet-up flex max-h-[min(74vh,560px)] w-[min(calc(100vw-2rem),390px)] flex-col overflow-hidden rounded-3xl border border-[var(--df-border-strong)] bg-[var(--df-surface)] shadow-xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-[var(--df-border)] bg-[var(--df-surface-muted)] px-3.5 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <EkuAvatar emotion={visualEmotion} size="sm" />
              <div className="min-w-0">
                <h2 className="font-display text-sm font-bold leading-tight text-[var(--df-text)]">
                  Eku
                </h2>
                <p className="truncate text-[11px] text-[var(--df-text-muted)]">
                  {statusSubtitle}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {voice.isSpeaking && (
                <button
                  type="button"
                  onClick={voice.stopSpeaking}
                  aria-label="Stop Eku speaking"
                  title="Stop speaking"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] text-[var(--df-text)] hover:border-[var(--df-border-strong)]"
                >
                  <BiIcon name="stop-fill" className="text-xs" />
                </button>
              )}

              {preferredLanguage && (
                <button
                  type="button"
                  onClick={() => updateSettings({ preferredResourceLanguage: null })}
                  title="Reset saved resource language preference"
                  className="rounded-lg border border-[var(--df-border)] bg-[var(--df-surface)] px-2 py-1 text-[10px] font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
                >
                  {preferredLanguage} ×
                </button>
              )}

              {voice.isTtsSupported && (
                <button
                  type="button"
                  onClick={() => updateSettings({ ekuMuted: !muted })}
                  aria-label={muted ? 'Unmute Eku voice' : 'Mute Eku voice'}
                  title={muted ? 'Unmute voice replies' : 'Mute voice replies'}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-[var(--df-text-muted)] transition-colors hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
                >
                  <BiIcon
                    name={muted ? 'volume-mute' : 'volume-up'}
                    className="text-sm"
                  />
                </button>
              )}

              <button
                type="button"
                onClick={handleClearChat}
                aria-label="Clear Eku conversation"
                title="Clear conversation"
                className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-[var(--df-text-muted)] transition-colors hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
              >
                <BiIcon name="arrow-counterclockwise" className="text-sm" />
              </button>

              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="Minimize Eku"
                title="Minimize"
                className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-[var(--df-text-muted)] transition-colors hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]"
              >
                <BiIcon name="dash-lg" className="text-sm" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3"
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${
                  msg.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-[90%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[var(--df-cta)] text-[var(--df-cta-fg)]'
                      : msg.isError
                      ? 'border border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-900/60 dark:bg-rose-950/35 dark:text-rose-200'
                      : 'border border-[var(--df-border)] bg-[var(--df-surface-muted)] text-[var(--df-text)]'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.text}</p>

                  {/* Focus action quick link */}
                  {msg.focusActions && msg.focusActions.length > 0 && activePage !== 'focus' && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => {
                          setActivePage('focus');
                          setIsOpen(false);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--df-accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--df-accent-fg)]"
                      >
                        <BiIcon name="stopwatch" className="text-xs" />
                        Open Focus Timer
                      </button>
                    </div>
                  )}

                  {/* Interactive Schedule/Task/Reminder Approval Cards */}
                  {msg.proposals?.map((prop) => renderProposalCard(msg.id, prop))}

                  {/* Curated Learning Resources */}
                  {msg.resources && msg.resources.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {msg.resources.map((res) => renderResourceCard(res))}
                    </div>
                  )}

                  {/* Missing PDF alternative-language confirmation */}
                  {msg.languageNotice?.missingPdfInRequestedLanguage &&
                    msg.languageNotice.alternativePdfAvailable && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            void sendMessage(
                              `Yes, please show English PDF notes for ${
                                msg.languageNotice?.topic || 'this topic'
                              } as well.`
                            )
                          }
                          className="rounded-xl bg-[var(--df-accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--df-accent-fg)]"
                        >
                          Show English PDFs
                        </button>
                      </div>
                    )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start">
                <div className="inline-flex items-center gap-2 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface-muted)] px-3.5 py-2 text-xs text-[var(--df-text-muted)]">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--df-accent)]" />
                  Eku is checking your workspace...
                </div>
              </div>
            )}

            {showQuickStarters && (
              <div className="space-y-1.5 pt-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--df-text-subtle)]">
                  Try asking Eku
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {STARTER_PROMPTS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => void sendMessage(prompt)}
                      className="rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-2.5 py-1.5 text-left text-[11px] font-medium text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)]"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Voice status / error banner */}
          {(voice.isListening || voice.interimTranscript || voice.voiceError) && (
            <div className="border-t border-[var(--df-border)] bg-[var(--df-surface-muted)] px-3.5 py-1.5 text-[11px]">
              {voice.voiceError ? (
                <p className="text-amber-700 dark:text-amber-300">{voice.voiceError}</p>
              ) : (
                <p className="flex items-center gap-1.5 text-[var(--df-text-muted)]">
                  <span className="h-2 w-2 animate-ping rounded-full bg-[var(--df-break-accent)]" />
                  {voice.interimTranscript
                    ? `Heard: "${voice.interimTranscript}"`
                    : 'Listening — speak your request...'}
                </p>
              )}
            </div>
          )}

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage(inputValue);
            }}
            className="flex items-center gap-2 border-t border-[var(--df-border)] bg-[var(--df-surface)] p-2.5"
          >
            {voice.isSttSupported && (
              <button
                type="button"
                onClick={handleMicToggle}
                disabled={isLoading}
                aria-label={voice.isListening ? 'Stop listening' : 'Speak to Eku'}
                title={voice.isListening ? 'Stop listening' : 'Voice command'}
                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border transition-colors ${
                  voice.isListening
                    ? 'border-[var(--df-break-accent)] bg-[var(--df-break-accent)] text-white'
                    : 'border-[var(--df-border)] bg-[var(--df-bg)] text-[var(--df-text-muted)] hover:border-[var(--df-border-strong)] hover:text-[var(--df-text)]'
                }`}
              >
                <BiIcon
                  name={voice.isListening ? 'mic-fill' : 'mic'}
                  className="text-sm"
                />
              </button>
            )}

            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Ask Eku anything..."
              aria-label="Message Eku"
              disabled={isLoading}
              className="h-10 min-w-0 flex-1 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3.5 text-xs text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none disabled:opacity-60"
            />

            <button
              type="submit"
              disabled={isLoading || !inputValue.trim()}
              aria-label="Send message to Eku"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--df-accent)] text-[var(--df-accent-fg)] transition-transform hover:brightness-95 active:scale-95 disabled:opacity-45"
            >
              <BiIcon name="send-fill" className="text-xs" />
            </button>
          </form>
        </section>
      )}

      {/* Floating Launcher Robot Button */}
      <button
        type="button"
        onClick={() => {
          setIsOpen((prev) => !prev);
          setTimeout(() => inputRef.current?.focus(), 60);
        }}
        aria-label={isOpen ? 'Close Eku assistant' : 'Open Eku assistant'}
        aria-expanded={isOpen}
        className="group relative flex h-15 w-15 items-center justify-center rounded-full border border-[var(--df-border-strong)] bg-[var(--df-surface)] shadow-lg transition-transform hover:scale-105 active:scale-95 focus-visible:ring-2 focus-visible:ring-[var(--df-accent)]"
      >
        <EkuAvatar emotion={visualEmotion} size="md" />
        <span className="sr-only">Eku Assistant</span>
      </button>
    </div>
  );
};
