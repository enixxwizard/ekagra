import React, { useEffect, useRef, useState } from 'react';
import { useDayFlow } from '../../context/DayFlowContext';
import { NavPage } from '../../types/dayflow';
import { formatTimerClock, getTodayISO } from '../../utils/dateTime';
import { UserMenu } from '../auth/UserMenu';
import { BiIcon } from '../ui/BiIcon';
import { EkagraLogo } from '../ui/EkagraBrand';

interface PrimaryNavItem {
  id: NavPage;
  label: string;
  iconName: string;
}

const PRIMARY_NAV: PrimaryNavItem[] = [
  { id: 'plan', label: 'Plan', iconName: 'compass' },
  { id: 'focus', label: 'Focus', iconName: 'stopwatch' },
  { id: 'capture', label: 'Capture', iconName: 'journal-text' },
  { id: 'library', label: 'Library', iconName: 'book' },
];

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    state,
    activePage,
    setActivePage,
    setInsightsTab,
    remainingSeconds,
    openQuickActivitySheet,
  } = useDayFlow();

  const [moreOpen, setMoreOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const timerActive = state.activeTimer.status !== 'idle';
  const isSecondaryPage =
    activePage === 'calendar' || activePage === 'insights' || activePage === 'settings';

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [moreOpen]);

  const navigateSecondary = (page: NavPage, insightsSub?: 'overview' | 'habits' | 'tasks') => {
    if (insightsSub) setInsightsTab(insightsSub);
    setActivePage(page);
    setMoreOpen(false);
  };

  return (
    <div className="min-h-screen bg-[var(--df-bg)] text-[var(--df-text)]">
      {/* Compact Three-Zone Single-Row Top Bar */}
      <header className="sticky top-0 z-30 border-b border-[var(--df-border)] bg-[var(--df-bg)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:h-16 sm:px-6">
          {/* Zone 1: Wordmark (+ live timer clock only when active) */}
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setActivePage('plan')}
              aria-label="Ekagra Home"
              className="flex items-center rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-accent)]"
            >
              <EkagraLogo size="sm" />
            </button>

            {timerActive && (
              <button
                type="button"
                onClick={() => setActivePage('focus')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] px-2.5 py-1 font-mono text-xs font-medium tabular-nums text-[var(--df-accent-soft-fg)] transition-transform active:scale-95"
              >
                <BiIcon name="stopwatch" className="text-xs" />
                {formatTimerClock(remainingSeconds)}
              </button>
            )}
          </div>

          {/* Zone 2: Desktop 3-Destination Navigation (Plan · Focus · Capture) */}
          <nav aria-label="Primary" className="hidden items-center gap-2 md:flex">
            {PRIMARY_NAV.map((item) => {
              const isActive = activePage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActivePage(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`relative rounded-xl px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'bg-[var(--df-text)] text-[var(--df-bg)]'
                      : 'text-[var(--df-text-muted)] hover:bg-[var(--df-surface-hover)] hover:text-[var(--df-text)]'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Account Menu, Progressive Disclosure Menu + Quick Add Action */}
          <div className="flex items-center gap-2 shrink-0">
            <UserMenu />
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-label="More views and settings"
                aria-expanded={moreOpen}
                className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${
                  isSecondaryPage || moreOpen
                    ? 'border-[var(--df-text)] bg-[var(--df-text)] text-[var(--df-bg)]'
                    : 'border-[var(--df-border)] bg-[var(--df-surface)] text-[var(--df-text-muted)] hover:border-[var(--df-border-strong)] hover:text-[var(--df-text)]'
                }`}
              >
                <BiIcon name="three-dots" className="text-base" />
              </button>

              {moreOpen && (
                <div
                  role="menu"
                  className="animate-sheet-up absolute right-0 mt-2 w-52 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-1.5 shadow-sm"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => navigateSecondary('calendar')}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-medium transition-colors ${
                      activePage === 'calendar'
                        ? 'bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]'
                        : 'text-[var(--df-text)] hover:bg-[var(--df-surface-hover)]'
                    }`}
                  >
                    <BiIcon name="calendar3" className="text-sm text-[var(--df-text-muted)]" />
                    Full Calendar
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => navigateSecondary('insights', 'habits')}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)]"
                  >
                    <BiIcon name="fire" className="text-sm text-[var(--df-text-muted)]" />
                    Habits
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => navigateSecondary('insights', 'tasks')}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)]"
                  >
                    <BiIcon name="check2-square" className="text-sm text-[var(--df-text-muted)]" />
                    Tasks Backlog
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => navigateSecondary('insights', 'overview')}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)]"
                  >
                    <BiIcon name="bar-chart-line" className="text-sm text-[var(--df-text-muted)]" />
                    Analytics
                  </button>
                  <div className="my-1 border-t border-[var(--df-border)]" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => navigateSecondary('settings')}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-medium transition-colors ${
                      activePage === 'settings'
                        ? 'bg-[var(--df-accent-soft)] text-[var(--df-accent-soft-fg)]'
                        : 'text-[var(--df-text)] hover:bg-[var(--df-surface-hover)]'
                    }`}
                  >
                    <BiIcon name="sliders" className="text-sm text-[var(--df-text-muted)]" />
                    Settings &amp; Backups
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => openQuickActivitySheet({ initialDate: getTodayISO() })}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-[var(--df-cta)] px-3.5 text-xs font-semibold text-[var(--df-cta-fg)] transition-transform hover:opacity-90 active:scale-[0.98] whitespace-nowrap shrink-0"
            >
              <BiIcon name="plus-lg" className="text-sm" />
              <span>Add</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="mx-auto w-full max-w-5xl px-4 pt-6 pb-24 sm:px-6 sm:pt-8 md:pb-14">
        {isSecondaryPage && (
          <div className="mb-5">
            <button
              type="button"
              onClick={() => setActivePage('plan')}
              className="inline-flex min-h-[36px] items-center gap-1.5 text-xs font-medium text-[var(--df-text-muted)] transition-colors hover:text-[var(--df-text)]"
            >
              <BiIcon name="arrow-left" className="text-xs" />
              Back to Plan
            </button>
          </div>
        )}
        {children}
      </main>

      {/* Mobile Bottom Navigation Bar (4 Primary Destinations) */}
      <nav
        aria-label="Mobile navigation"
        className="fixed right-0 bottom-0 left-0 z-40 border-t border-[var(--df-border)] bg-[var(--df-bg)] md:hidden"
      >
        <div className="mx-auto grid h-16 max-w-md grid-cols-4 items-center px-2">
          {PRIMARY_NAV.map((item) => {
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActivePage(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className="flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-xl px-1 transition-colors"
              >
                <span
                  className={`flex h-7 w-12 items-center justify-center rounded-xl transition-colors ${
                    isActive
                      ? 'bg-[var(--df-accent)] text-[var(--df-accent-fg)]'
                      : 'text-[var(--df-text-muted)]'
                  }`}
                >
                  <BiIcon name={item.iconName} className="text-base" />
                </span>
                <span
                  className={`text-[11px] font-medium tracking-tight ${
                    isActive
                      ? 'text-[var(--df-text)]'
                      : 'text-[var(--df-text-muted)]'
                  }`}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
};
