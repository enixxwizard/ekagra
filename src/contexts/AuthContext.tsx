import React, { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  authService,
  isAuthCallbackUrl,
  mapAuthError,
  mapSupabaseUser,
} from '../services/authService';
import {
  clearMigratedGuestData,
  detectGuestData,
  isGuestModePersisted,
  migrateGuestDataToAccount,
  setGuestModePersisted,
} from '../services/migrationService';
import type {
  AuthState,
  GuestMigrationSummary,
  MigrationResult,
  MigrationStatus,
} from '../types/auth';

export interface AuthContextValue extends AuthState {
  isSigningIn: boolean;
  isSubmittingEmailAuth: boolean;
  isSigningOut: boolean;
  pendingConfirmationEmail: string | null;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<{ needsEmailConfirmation: boolean }>;
  resendConfirmationEmail: (email: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  enterPasswordRecoveryMode: () => void;
  cancelPasswordRecovery: () => Promise<void>;
  enterGuestMode: () => void;
  openAuthFromGuest: () => void;
  returnToSignIn: () => void;
  signOut: () => Promise<void>;
  clearAuthError: () => void;
  setAuthError: (message: string) => void;
  // Guest-to-account migration
  migrationStatus: MigrationStatus;
  migrationSummary: GuestMigrationSummary | null;
  migrationError: string | null;
  migrationResult: MigrationResult | null;
  confirmGuestMigration: () => Promise<void>;
  skipGuestMigration: () => void;
  cloudRefreshNonce: number;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

const SKIPPED_MIGRATION_PREFIX = 'dayflow_migration_skipped_v1_';

function isMigrationSkippedForUser(userId: string): boolean {
  try {
    return sessionStorage.getItem(`${SKIPPED_MIGRATION_PREFIX}${userId}`) === 'true';
  } catch {
    return false;
  }
}

function markMigrationSkippedForUser(userId: string): void {
  try {
    sessionStorage.setItem(`${SKIPPED_MIGRATION_PREFIX}${userId}`, 'true');
  } catch {
    // Ignore sessionStorage error
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authState, setAuthState] = useState<AuthState>({
    status: 'initializing',
    user: null,
    session: null,
    error: null,
    isSupabaseConfigured,
  });

  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSubmittingEmailAuth, setIsSubmittingEmailAuth] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [pendingConfirmationEmail, setPendingConfirmationEmail] = useState<string | null>(null);

  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus>('idle');
  const [migrationSummary, setMigrationSummary] = useState<GuestMigrationSummary | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationResult, setMigrationResult] = useState<MigrationResult | null>(null);
  const [cloudRefreshNonce, setCloudRefreshNonce] = useState(0);

  const popupPollRef = useRef<number | null>(null);
  const recoveryFlowRef = useRef(false);
  const emailAuthLockRef = useRef(false);

  const evaluateGuestMigration = useCallback((userId: string) => {
    if (isMigrationSkippedForUser(userId)) return;
    const summary = detectGuestData();
    if (summary.hasData && summary.rawState) {
      setMigrationSummary(summary);
      setMigrationError(null);
      setMigrationResult(null);
      setMigrationStatus('prompting');
    }
  }, []);

  // Initial session restoration (zero flicker while initializing)
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // If currently handling an auth callback URL, let AuthCallback complete code/token verification
      if (isAuthCallbackUrl()) {
        if (!cancelled) {
          setAuthState({
            status: 'unauthenticated',
            user: null,
            session: null,
            error: null,
            isSupabaseConfigured,
          });
        }
        return;
      }

      if (!supabase) {
        if (!cancelled) {
          setAuthState({
            status: isGuestModePersisted() ? 'guest' : 'unauthenticated',
            user: null,
            session: null,
            error: null,
            isSupabaseConfigured: false,
          });
        }
        return;
      }

      const { session, error } = await authService.getCurrentSession();
      if (cancelled) return;

      if (recoveryFlowRef.current) {
        return;
      }

      if (session?.user) {
        const mapped = mapSupabaseUser(session.user);
        setGuestModePersisted(false);
        setAuthState({
          status: 'authenticated',
          user: mapped,
          session,
          error: null,
          isSupabaseConfigured: true,
        });
        void authService.upsertProfile(mapped);
        evaluateGuestMigration(mapped.id);
        return;
      }

      if (error) {
        setAuthState({
          status: isGuestModePersisted() ? 'guest' : 'error',
          user: null,
          session: null,
          error,
          isSupabaseConfigured: true,
        });
        return;
      }

      setAuthState({
        status: isGuestModePersisted() ? 'guest' : 'unauthenticated',
        user: null,
        session: null,
        error: null,
        isSupabaseConfigured: true,
      });
    };

    void init();

    return () => {
      cancelled = true;
    };
  }, [evaluateGuestMigration]);

  // Listen to official Supabase auth state changes (sign-in, recovery, token refresh, sign-out)
  useEffect(() => {
    if (!supabase) return;

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        recoveryFlowRef.current = true;
        setIsSigningIn(false);
        setIsSubmittingEmailAuth(false);
        setPendingConfirmationEmail(null);
        setGuestModePersisted(false);
        setAuthState({
          status: 'password_recovery',
          user: session?.user ? mapSupabaseUser(session.user) : null,
          session: session ?? null,
          error: null,
          isSupabaseConfigured: true,
        });
        return;
      }

      if (event === 'SIGNED_OUT' || !session?.user) {
        recoveryFlowRef.current = false;
        setIsSigningIn(false);
        setIsSubmittingEmailAuth(false);
        setMigrationStatus('idle');
        setMigrationSummary(null);
        setMigrationError(null);
        setAuthState((prev) => {
          if (prev.status === 'email_confirmation_pending') {
            return prev;
          }
          return {
            status:
              prev.status === 'guest' && isGuestModePersisted() ? 'guest' : 'unauthenticated',
            user: null,
            session: null,
            error: prev.status === 'error' ? prev.error : null,
            isSupabaseConfigured,
          };
        });
        return;
      }

      if (
        event === 'SIGNED_IN' ||
        event === 'TOKEN_REFRESHED' ||
        event === 'USER_UPDATED' ||
        event === 'INITIAL_SESSION'
      ) {
        // Never bypass active password recovery step before the user updates their password
        if (recoveryFlowRef.current) {
          setAuthState((prev) => ({
            ...prev,
            status: 'password_recovery',
            user: mapSupabaseUser(session.user),
            session,
          }));
          return;
        }

        const mapped = mapSupabaseUser(session.user);
        setIsSigningIn(false);
        setIsSubmittingEmailAuth(false);
        setPendingConfirmationEmail(null);
        setGuestModePersisted(false);
        setAuthState({
          status: 'authenticated',
          user: mapped,
          session,
          error: null,
          isSupabaseConfigured: true,
        });

        if (event === 'SIGNED_IN') {
          void authService.upsertProfile(mapped);
          evaluateGuestMigration(mapped.id);
        }
      }
    });

    return () => {
      data.subscription.unsubscribe();
    };
  }, [evaluateGuestMigration]);

  // Listen for postMessage from OAuth popup callback (iframe preview flow)
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const origin = event.origin;
      const isTrustedOrigin =
        origin === window.location.origin ||
        origin.endsWith('.run.app') ||
        origin.startsWith('http://localhost') ||
        origin.startsWith('https://localhost');

      if (!isTrustedOrigin) return;
      if (!event.data || event.data.type !== 'DAYFLOW_SUPABASE_AUTH_CALLBACK') return;

      if (popupPollRef.current) {
        window.clearInterval(popupPollRef.current);
        popupPollRef.current = null;
      }

      const callbackUrl = typeof event.data.callbackUrl === 'string' ? event.data.callbackUrl : '';
      if (!callbackUrl) {
        setIsSigningIn(false);
        return;
      }

      const { session, error, isRecovery } = await authService.completeAuthCallback(callbackUrl);
      setIsSigningIn(false);

      if (error) {
        setAuthState((prev) => ({
          ...prev,
          status: prev.status === 'guest' ? 'guest' : 'error',
          error,
        }));
        return;
      }

      if (isRecovery) {
        recoveryFlowRef.current = true;
        setAuthState({
          status: 'password_recovery',
          user: session?.user ? mapSupabaseUser(session.user) : null,
          session: session ?? null,
          error: null,
          isSupabaseConfigured: true,
        });
        return;
      }

      if (session?.user && !recoveryFlowRef.current) {
        const mapped = mapSupabaseUser(session.user);
        setGuestModePersisted(false);
        setAuthState({
          status: 'authenticated',
          user: mapped,
          session,
          error: null,
          isSupabaseConfigured: true,
        });
        void authService.upsertProfile(mapped);
        evaluateGuestMigration(mapped.id);
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (popupPollRef.current) {
        window.clearInterval(popupPollRef.current);
      }
    };
  }, [evaluateGuestMigration]);

  const signInWithGoogle = useCallback(async () => {
    setIsSigningIn(true);
    setAuthState((prev) => ({ ...prev, error: null }));

    try {
      const result = await authService.startGoogleSignIn();
      if (result.mode === 'popup' && result.popupWindow) {
        if (popupPollRef.current) window.clearInterval(popupPollRef.current);
        popupPollRef.current = window.setInterval(() => {
          if (result.popupWindow && result.popupWindow.closed) {
            if (popupPollRef.current) {
              window.clearInterval(popupPollRef.current);
              popupPollRef.current = null;
            }
            setIsSigningIn(false);
          }
        }, 500);
      }
    } catch (err) {
      setIsSigningIn(false);
      const message = mapAuthError(err, 'Unable to start Google sign-in.');
      setAuthState((prev) => ({
        ...prev,
        status: prev.status === 'guest' ? 'guest' : 'error',
        error: message,
      }));
    }
  }, []);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      if (emailAuthLockRef.current) return;
      emailAuthLockRef.current = true;
      setIsSubmittingEmailAuth(true);
      setAuthState((prev) => ({ ...prev, error: null }));

      try {
        const { session, user } = await authService.signInWithEmail(email, password);
        const mapped = mapSupabaseUser(user);
        recoveryFlowRef.current = false;
        setPendingConfirmationEmail(null);
        setGuestModePersisted(false);
        setAuthState({
          status: 'authenticated',
          user: mapped,
          session,
          error: null,
          isSupabaseConfigured: true,
        });
        void authService.upsertProfile(mapped);
        evaluateGuestMigration(mapped.id);
      } catch (err) {
        const message = mapAuthError(err, 'Unable to sign in. Please check your credentials.');
        throw new Error(message);
      } finally {
        emailAuthLockRef.current = false;
        setIsSubmittingEmailAuth(false);
      }
    },
    [evaluateGuestMigration]
  );

  const signUpWithEmail = useCallback(
    async (email: string, password: string): Promise<{ needsEmailConfirmation: boolean }> => {
      if (emailAuthLockRef.current) {
        return { needsEmailConfirmation: false };
      }
      emailAuthLockRef.current = true;
      setIsSubmittingEmailAuth(true);
      setAuthState((prev) => ({ ...prev, error: null }));

      try {
        const outcome = await authService.signUpWithEmail(email, password);

        if (outcome.needsEmailConfirmation) {
          setPendingConfirmationEmail(email.trim());
          setAuthState((prev) => ({
            ...prev,
            status: 'email_confirmation_pending',
            user: null,
            session: null,
            error: null,
          }));
          return { needsEmailConfirmation: true };
        }

        if (outcome.session && outcome.user) {
          const mapped = mapSupabaseUser(outcome.user);
          recoveryFlowRef.current = false;
          setPendingConfirmationEmail(null);
          setGuestModePersisted(false);
          setAuthState({
            status: 'authenticated',
            user: mapped,
            session: outcome.session,
            error: null,
            isSupabaseConfigured: true,
          });
          void authService.upsertProfile(mapped);
          evaluateGuestMigration(mapped.id);
        }

        return { needsEmailConfirmation: false };
      } catch (err) {
        const message = mapAuthError(err, 'Could not create your account right now.');
        throw new Error(message);
      } finally {
        emailAuthLockRef.current = false;
        setIsSubmittingEmailAuth(false);
      }
    },
    [evaluateGuestMigration]
  );

  const resendConfirmationEmail = useCallback(async (email: string) => {
    if (emailAuthLockRef.current) return;
    emailAuthLockRef.current = true;
    setIsSubmittingEmailAuth(true);
    setAuthState((prev) => ({ ...prev, error: null }));

    try {
      await authService.resendConfirmationEmail(email);
    } catch (err) {
      const message = mapAuthError(err, 'Could not resend confirmation email.');
      throw new Error(message);
    } finally {
      emailAuthLockRef.current = false;
      setIsSubmittingEmailAuth(false);
    }
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    if (emailAuthLockRef.current) return;
    emailAuthLockRef.current = true;
    setIsSubmittingEmailAuth(true);
    setAuthState((prev) => ({ ...prev, error: null }));

    try {
      await authService.sendPasswordResetEmail(email);
    } catch (err) {
      const message = mapAuthError(err, 'Could not send password reset email.');
      throw new Error(message);
    } finally {
      emailAuthLockRef.current = false;
      setIsSubmittingEmailAuth(false);
    }
  }, []);

  const updatePassword = useCallback(
    async (newPassword: string) => {
      if (emailAuthLockRef.current) return;
      emailAuthLockRef.current = true;
      setIsSubmittingEmailAuth(true);
      setAuthState((prev) => ({ ...prev, error: null }));

      try {
        const updatedUser = await authService.updatePassword(newPassword);
        const { session } = await authService.getCurrentSession();
        recoveryFlowRef.current = false;

        if (session?.user) {
          const mapped = mapSupabaseUser(updatedUser ?? session.user);
          setGuestModePersisted(false);
          setAuthState({
            status: 'authenticated',
            user: mapped,
            session,
            error: null,
            isSupabaseConfigured: true,
          });
          void authService.upsertProfile(mapped);
          evaluateGuestMigration(mapped.id);
        } else {
          setAuthState({
            status: 'unauthenticated',
            user: null,
            session: null,
            error: null,
            isSupabaseConfigured: true,
          });
        }
      } catch (err) {
        const message = mapAuthError(err, 'Could not update your password.');
        throw new Error(message);
      } finally {
        emailAuthLockRef.current = false;
        setIsSubmittingEmailAuth(false);
      }
    },
    [evaluateGuestMigration]
  );

  const enterPasswordRecoveryMode = useCallback(() => {
    recoveryFlowRef.current = true;
    setPendingConfirmationEmail(null);
    setAuthState((prev) => ({
      ...prev,
      status: 'password_recovery',
      error: null,
    }));
  }, []);

  const cancelPasswordRecovery = useCallback(async () => {
    recoveryFlowRef.current = false;
    try {
      await authService.signOut();
    } catch {
      // Ignore signOut failure on cancel
    }
    setAuthState({
      status: 'unauthenticated',
      user: null,
      session: null,
      error: null,
      isSupabaseConfigured,
    });
  }, []);

  const enterGuestMode = useCallback(() => {
    recoveryFlowRef.current = false;
    setPendingConfirmationEmail(null);
    setGuestModePersisted(true);
    setAuthState((prev) => ({
      ...prev,
      status: 'guest',
      user: null,
      session: null,
      error: null,
    }));
  }, []);

  // Lets a guest open the AuthScreen without erasing local guest data
  const openAuthFromGuest = useCallback(() => {
    setGuestModePersisted(false);
    setAuthState((prev) => ({
      ...prev,
      status: 'unauthenticated',
      user: null,
      session: null,
      error: null,
    }));
  }, []);

  const returnToSignIn = useCallback(() => {
    recoveryFlowRef.current = false;
    setPendingConfirmationEmail(null);
    setAuthState((prev) => ({
      ...prev,
      status: 'unauthenticated',
      error: null,
    }));
  }, []);

  const signOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await authService.signOut();
      recoveryFlowRef.current = false;
      setPendingConfirmationEmail(null);
      setGuestModePersisted(false);
      setMigrationStatus('idle');
      setMigrationSummary(null);
      setMigrationError(null);
      setAuthState({
        status: 'unauthenticated',
        user: null,
        session: null,
        error: null,
        isSupabaseConfigured,
      });
    } catch (err) {
      const message = mapAuthError(err, 'Could not sign out.');
      setAuthState((prev) => ({ ...prev, error: message }));
      throw err;
    } finally {
      setIsSigningOut(false);
    }
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthState((prev) => ({
      ...prev,
      status:
        prev.status === 'error'
          ? isGuestModePersisted()
            ? 'guest'
            : 'unauthenticated'
          : prev.status,
      error: null,
    }));
  }, []);

  const setAuthError = useCallback((message: string) => {
    setAuthState((prev) => ({
      ...prev,
      status: 'error',
      error: message,
    }));
  }, []);

  const confirmGuestMigration = useCallback(async () => {
    if (!authState.user || !migrationSummary?.rawState) return;
    setMigrationStatus('migrating');
    setMigrationError(null);

    try {
      const result = await migrateGuestDataToAccount(
        authState.user.id,
        migrationSummary.rawState
      );
      clearMigratedGuestData();
      setMigrationResult(result);
      setMigrationStatus('completed');
      setCloudRefreshNonce((n) => n + 1);
    } catch (err) {
      // Preserve local guest data untouched on failure
      setMigrationError(
        err instanceof Error
          ? err.message
          : 'Migration failed. Your local guest data was preserved safely.'
      );
      setMigrationStatus('failed');
    }
  }, [authState.user, migrationSummary]);

  const skipGuestMigration = useCallback(() => {
    if (authState.user) {
      markMigrationSkippedForUser(authState.user.id);
    }
    setMigrationStatus('idle');
    setMigrationSummary(null);
    setMigrationError(null);
  }, [authState.user]);

  return (
    <AuthContext.Provider
      value={{
        ...authState,
        isSigningIn,
        isSubmittingEmailAuth,
        isSigningOut,
        pendingConfirmationEmail,
        signInWithGoogle,
        signInWithEmail,
        signUpWithEmail,
        resendConfirmationEmail,
        sendPasswordReset,
        updatePassword,
        enterPasswordRecoveryMode,
        cancelPasswordRecovery,
        enterGuestMode,
        openAuthFromGuest,
        returnToSignIn,
        signOut,
        clearAuthError,
        setAuthError,
        migrationStatus,
        migrationSummary,
        migrationError,
        migrationResult,
        confirmGuestMigration,
        skipGuestMigration,
        cloudRefreshNonce,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
