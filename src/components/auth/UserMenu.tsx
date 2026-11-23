import React, { useEffect, useRef, useState } from 'react';
import { useDayFlow } from '../../context/DayFlowContext';
import { useAuth } from '../../hooks/useAuth';
import { BiIcon } from '../ui/BiIcon';

export const UserMenu: React.FC = () => {
  const {
    status,
    user,
    isSupabaseConfigured,
    isSigningIn,
    isSigningOut,
    signInWithGoogle,
    openAuthFromGuest,
    signOut,
  } = useAuth();
  const { setActivePage, pushToast } = useDayFlow();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleSignOut = async () => {
    try {
      await signOut();
      setOpen(false);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Sign out failed',
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    }
  };

  const handleGuestGoogleSignIn = async () => {
    setOpen(false);
    await signInWithGoogle();
  };

  const displayName = user?.fullName || user?.email?.split('@')[0] || 'Account';
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="relative" ref={containerRef}>
      {status === 'authenticated' && user ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Account menu"
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-2.5 text-xs font-medium text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)]"
        >
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={displayName}
              referrerPolicy="no-referrer"
              className="h-6 w-6 rounded-lg object-cover"
            />
          ) : (
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[var(--df-accent)] text-[11px] font-bold text-[var(--df-accent-fg)]">
              {initials || <BiIcon name="person" className="text-xs" />}
            </span>
          )}
          <span className="hidden max-w-[100px] truncate sm:inline">{displayName}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Guest mode menu"
          className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-[var(--df-border)] bg-[var(--df-surface)] px-3 text-xs font-medium text-[var(--df-text-muted)] transition-colors hover:border-[var(--df-border-strong)] hover:text-[var(--df-text)]"
        >
          <BiIcon name="person" className="text-xs" />
          <span className="hidden sm:inline">Guest</span>
        </button>
      )}

      {open && (
        <div
          role="menu"
          className="animate-sheet-up absolute right-0 mt-2 w-64 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-2 shadow-sm"
        >
          {status === 'authenticated' && user ? (
            <>
              <div className="border-b border-[var(--df-border)] px-2.5 py-2">
                <p className="truncate text-xs font-semibold text-[var(--df-text)]">
                  {displayName}
                </p>
                {user.email && (
                  <p className="truncate text-[11px] text-[var(--df-text-muted)]">
                    {user.email}
                  </p>
                )}
                <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--df-accent-soft-fg)]">
                  <BiIcon name="cloud-check" className="text-xs" />
                  Authenticated cloud account
                </p>
              </div>

              <div className="mt-1 space-y-0.5">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActivePage('settings');
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)]"
                >
                  <BiIcon name="sliders" className="text-xs text-[var(--df-text-muted)]" />
                  Settings &amp; Backups
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={isSigningOut}
                  onClick={() => void handleSignOut()}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
                >
                  <BiIcon name="box-arrow-right" className="text-xs" />
                  {isSigningOut ? 'Signing out...' : 'Sign out'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="border-b border-[var(--df-border)] px-2.5 py-2">
                <p className="text-xs font-semibold text-[var(--df-text)]">
                  Guest Mode
                </p>
                <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-[var(--df-text-muted)]">
                  <BiIcon name="hdd" className="mt-0.5 text-xs shrink-0" />
                  Saved in this browser only. Not backed up online.
                </p>
              </div>

              <div className="mt-1.5 space-y-1">
                {isSupabaseConfigured ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isSigningIn}
                      onClick={() => void handleGuestGoogleSignIn()}
                      className="flex w-full items-center gap-2 rounded-xl bg-[var(--df-accent)] px-3 py-2 text-left text-xs font-semibold text-[var(--df-accent-fg)] transition-all hover:brightness-95 disabled:opacity-50"
                    >
                      <BiIcon name="box-arrow-in-right" className="text-xs" />
                      {isSigningIn ? 'Connecting...' : 'Sign in with Google'}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isSigningIn}
                      onClick={() => {
                        setOpen(false);
                        openAuthFromGuest();
                      }}
                      className="flex w-full items-center gap-2 rounded-xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3 py-2 text-left text-xs font-semibold text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] disabled:opacity-50"
                    >
                      <BiIcon name="box-arrow-in-right" className="text-xs" />
                      Sign in with Email
                    </button>
                  </>
                ) : (
                  <p className="rounded-xl bg-[var(--df-bg)] px-2.5 py-2 text-[11px] text-[var(--df-text-muted)]">
                    Configure Supabase env vars to enable Google &amp; Email sign-in.
                  </p>
                )}

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActivePage('settings');
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs font-medium text-[var(--df-text)] transition-colors hover:bg-[var(--df-surface-hover)]"
                >
                  <BiIcon name="sliders" className="text-xs text-[var(--df-text-muted)]" />
                  Settings &amp; Backups
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
