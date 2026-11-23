import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { authService } from '../../services/authService';
import { BiIcon } from '../ui/BiIcon';
import { EkagraLogo } from '../ui/EkagraBrand';
import { EmailAuthForm, type AuthScreenMode } from './EmailAuthForm';
import { GoogleSignInButton } from './GoogleSignInButton';
import { GuestModeButton } from './GuestModeButton';

export const AuthScreen: React.FC = () => {
  const {
    status,
    isSupabaseConfigured,
    isSigningIn,
    isSubmittingEmailAuth,
    error,
    signInWithGoogle,
    enterGuestMode,
    clearAuthError,
  } = useAuth();

  const [mode, setMode] = useState<AuthScreenMode>('sign_in');
  const configNotice = authService.getConfigNotice();
  const busy = isSigningIn || isSubmittingEmailAuth;

  const isSpecialStatus =
    status === 'email_confirmation_pending' || status === 'password_recovery';

  // Show top-level alert for OAuth/callback/session errors (email form renders its own inline errors)
  const showTopLevelError = Boolean(error) && (status === 'error' || isSpecialStatus || isSigningIn);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--df-bg)] px-4 py-8 text-[var(--df-text)]">
      <div className="w-full max-w-md rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-6 sm:p-8">
        {/* Ekagra Logo */}
        <EkagraLogo size="md" showTagline />

        {/* Tagline */}
        <div className="mt-5 space-y-1">
          <h1 className="font-display text-2xl font-bold tracking-tight text-[var(--df-text)]">
            Plan your day. Own your time.
          </h1>
          {!isSpecialStatus && mode === 'sign_up' && (
            <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
              Create an Ekagra account to sync your schedule and study plans across devices.
            </p>
          )}
        </div>

        {/* Top-level OAuth / session / expired link alert */}
        {showTopLevelError && error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs leading-relaxed text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
          >
            <BiIcon name="exclamation-triangle" className="mt-0.5 text-sm shrink-0" />
            <div className="min-w-0 flex-1">
              <p>{error}</p>
              <button
                type="button"
                onClick={clearAuthError}
                className="mt-1 font-semibold underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Setup-Required State when Supabase env vars are not configured */}
        {!isSupabaseConfigured && configNotice && (
          <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3.5 py-3 text-xs leading-relaxed text-[var(--df-text-muted)]">
            <BiIcon name="info-circle" className="mt-0.5 text-sm shrink-0 text-[var(--df-text-muted)]" />
            <div>
              <p className="font-semibold text-[var(--df-text)]">
                Account sync setup required
              </p>
              <p className="mt-0.5">{configNotice}</p>
            </div>
          </div>
        )}

        {/* Primary Auth Flow */}
        <div className="mt-5 space-y-4">
          {!isSpecialStatus && mode === 'sign_in' && (
            <>
              <GoogleSignInButton
                onClick={() => void signInWithGoogle()}
                disabled={!isSupabaseConfigured || busy}
                loading={isSigningIn}
              />

              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-[var(--df-border)]" />
                <span className="text-[11px] font-semibold tracking-wider text-[var(--df-text-muted)] uppercase">
                  OR
                </span>
                <div className="h-px flex-1 bg-[var(--df-border)]" />
              </div>
            </>
          )}

          <EmailAuthForm mode={mode} onModeChange={setMode} />

          {!isSpecialStatus && mode !== 'forgot_password' && (
            <div className="pt-1">
              <GuestModeButton onClick={enterGuestMode} disabled={busy} />
            </div>
          )}
        </div>

        {/* Honest Guest Storage Distinction */}
        <div className="mt-5 flex items-start gap-2.5 border-t border-[var(--df-border)] pt-4 text-xs leading-relaxed text-[var(--df-text-muted)]">
          <BiIcon name="hdd" className="mt-0.5 text-sm shrink-0" />
          <p>
            Guest mode keeps everything locally in this browser only and is not backed up online. You can connect an account anytime.
          </p>
        </div>
      </div>
    </div>
  );
};
