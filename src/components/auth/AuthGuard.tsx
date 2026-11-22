import React, { useCallback, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { isAuthCallbackUrl } from '../../services/authService';
import { AuthCallback } from './AuthCallback';
import { AuthScreen } from './AuthScreen';
import { GuestMigrationModal } from './GuestMigrationModal';

export const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status, clearAuthError, setAuthError } = useAuth();
  const [handlingCallback, setHandlingCallback] = useState<boolean>(() => isAuthCallbackUrl());

  const handleCallbackSuccess = useCallback(() => {
    setHandlingCallback(false);
  }, []);

  const handleCallbackFailure = useCallback(
    (errorMessage?: string) => {
      if (errorMessage) {
        setAuthError(errorMessage);
      } else {
        clearAuthError();
      }
      setHandlingCallback(false);
    },
    [clearAuthError, setAuthError]
  );

  if (handlingCallback) {
    return (
      <AuthCallback
        onSuccess={handleCallbackSuccess}
        onBackToSignIn={handleCallbackFailure}
      />
    );
  }

  // Prevent auth screen flicker while restoring existing Supabase session
  if (status === 'initializing') {
    return (
      <div
        aria-busy="true"
        aria-label="Restoring session"
        className="flex min-h-screen items-center justify-center bg-[var(--df-bg)] text-[var(--df-text)]"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--df-accent)] font-display text-xs font-bold text-[var(--df-accent-fg)]">
            df
          </span>
          <span className="font-display text-base font-semibold tracking-tight text-[var(--df-text-muted)]">
            Loading DayFlow...
          </span>
        </div>
      </div>
    );
  }

  if (
    status === 'unauthenticated' ||
    status === 'email_confirmation_pending' ||
    status === 'password_recovery' ||
    status === 'error'
  ) {
    return <AuthScreen />;
  }

  return (
    <>
      {children}
      {status === 'authenticated' && <GuestMigrationModal />}
    </>
  );
};
