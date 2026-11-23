import React, { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { authService } from '../../services/authService';
import { BiIcon } from '../ui/BiIcon';
import { EkagraMark } from '../ui/EkagraBrand';

interface AuthCallbackProps {
  onSuccess: () => void;
  onBackToSignIn: (errorMessage?: string) => void;
}

export const AuthCallback: React.FC<AuthCallbackProps> = ({
  onSuccess,
  onBackToSignIn,
}) => {
  const { enterPasswordRecoveryMode } = useAuth();
  const [statusMessage, setStatusMessage] = useState('Verifying your authentication link...');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const processCallback = async () => {
      const currentUrl = window.location.href;

      // If opened in a popup from inside an iframe (e.g. AI Studio preview), hand callback back to opener
      if (window.opener && window.opener !== window) {
        try {
          window.opener.postMessage(
            {
              type: 'DAYFLOW_SUPABASE_AUTH_CALLBACK',
              callbackUrl: currentUrl,
            },
            '*'
          );
          setStatusMessage('Sign-in verified. Returning to Ekagra...');
          window.setTimeout(() => {
            window.close();
          }, 350);
          return;
        } catch {
          // Fall through to standard same-window handling
        }
      }

      const { session, error, isRecovery } = await authService.completeAuthCallback(currentUrl);
      if (cancelled) return;

      // Remove code/token parameters from browser URL bar immediately
      window.history.replaceState({}, '', '/');

      if (error) {
        setErrorMessage(error);
        return;
      }

      if (isRecovery) {
        enterPasswordRecoveryMode();
        onSuccess();
        return;
      }

      if (session) {
        onSuccess();
      } else {
        setErrorMessage('Verification link did not return an active session. Please sign in or request a new link.');
      }
    };

    void processCallback();

    return () => {
      cancelled = true;
    };
  }, [onSuccess, enterPasswordRecoveryMode]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--df-bg)] px-4 text-[var(--df-text)]">
      <div className="w-full max-w-md rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-7 text-center">
        <div className="flex justify-center">
          <EkagraMark size="lg" />
        </div>

        {errorMessage ? (
          <div className="mt-5 space-y-4">
            <div className="flex items-center justify-center gap-2 text-rose-600 dark:text-rose-400">
              <BiIcon name="exclamation-triangle" className="text-base shrink-0" />
              <h1 className="font-display text-lg font-bold">Verification incomplete</h1>
            </div>
            <p className="text-sm leading-relaxed text-[var(--df-text-muted)]">
              {errorMessage}
            </p>
            <button
              type="button"
              onClick={() => onBackToSignIn(errorMessage)}
              className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-2xl bg-[var(--df-cta)] px-5 text-sm font-semibold text-[var(--df-cta-fg)] transition-opacity hover:opacity-90"
            >
              <BiIcon name="arrow-left" className="text-sm" />
              Back to sign in
            </button>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <div className="flex items-center justify-center gap-2 text-[var(--df-text)]">
              <BiIcon name="arrow-repeat" spin className="text-base" />
              <h1 className="font-display text-lg font-bold">Completing verification</h1>
            </div>
            <p className="text-sm text-[var(--df-text-muted)]">{statusMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
};
