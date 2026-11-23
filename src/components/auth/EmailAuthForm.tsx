import React, { useEffect, useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { BiIcon } from '../ui/BiIcon';
import {
  isUnconfirmedEmailError,
  MIN_PASSWORD_LENGTH,
  validateEmailAddress,
  validatePasswordInput,
} from '../../services/authService';

export type AuthScreenMode = 'sign_in' | 'sign_up' | 'forgot_password';

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder?: string;
  disabled?: boolean;
  error?: string | null;
  helperText?: string;
  rightSlot?: React.ReactNode;
}

const PasswordField: React.FC<PasswordFieldProps> = ({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder = '••••••••',
  disabled = false,
  error,
  helperText,
  rightSlot,
}) => {
  const [visible, setVisible] = useState(false);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={id}
          className="block text-xs font-semibold text-[var(--df-text)]"
        >
          {label}
        </label>
        {rightSlot}
      </div>

      <div className="relative">
        <input
          id={id}
          name={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : helperText ? `${id}-hint` : undefined}
          className={`min-h-[46px] w-full rounded-2xl border bg-[var(--df-bg)] py-2.5 pr-11 pl-3.5 text-sm text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:outline-none disabled:opacity-60 ${
            error
              ? 'border-rose-400 focus:border-rose-500 dark:border-rose-700'
              : 'border-[var(--df-border)] focus:border-[var(--df-border-strong)]'
          }`}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="absolute top-1/2 right-2.5 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--df-text-muted)] hover:text-[var(--df-text)] disabled:opacity-40"
        >
          {visible ? <BiIcon name="eye-slash" className="text-sm" /> : <BiIcon name="eye" className="text-sm" />}
        </button>
      </div>

      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : helperText ? (
        <p id={`${id}-hint`} className="text-[11px] text-[var(--df-text-muted)]">
          {helperText}
        </p>
      ) : null}
    </div>
  );
};

interface EmailAuthFormProps {
  mode: AuthScreenMode;
  onModeChange: (mode: AuthScreenMode) => void;
}

export const EmailAuthForm: React.FC<EmailAuthFormProps> = ({ mode, onModeChange }) => {
  const {
    status,
    isSupabaseConfigured,
    isSigningIn,
    isSubmittingEmailAuth,
    pendingConfirmationEmail,
    signInWithEmail,
    signUpWithEmail,
    resendConfirmationEmail,
    sendPasswordReset,
    updatePassword,
    cancelPasswordRecovery,
    returnToSignIn,
    clearAuthError,
  } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showResendForUnconfirmed, setShowResendForUnconfirmed] = useState(false);
  const [resetLinkSent, setResetLinkSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  const busy = isSigningIn || isSubmittingEmailAuth;
  const disabledAll = !isSupabaseConfigured || busy;

  // Countdown timer for resend confirmation rate-limit cooldown
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = window.setInterval(() => {
      setResendCooldown((prev) => (prev > 1 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [resendCooldown]);

  const switchMode = (nextMode: AuthScreenMode) => {
    clearAuthError();
    setSubmitError(null);
    setShowResendForUnconfirmed(false);
    setResetLinkSent(false);
    setResendMessage(null);
    setPassword('');
    setConfirmPassword('');
    setTouched({});
    onModeChange(nextMode);
  };

  // Inline validations
  const emailError = touched.email ? validateEmailAddress(email) : null;
  const passwordError =
    touched.password && mode === 'sign_up'
      ? validatePasswordInput(password)
      : touched.password && mode === 'sign_in' && !password
      ? 'Please enter your password.'
      : null;
  const confirmPasswordError =
    touched.confirmPassword && (mode === 'sign_up' || status === 'password_recovery')
      ? password !== confirmPassword
        ? 'Passwords do not match.'
        : null
      : null;
  const recoveryPasswordError =
    touched.recoveryPassword && status === 'password_recovery'
      ? validatePasswordInput(password)
      : null;

  // 1. EMAIL CONFIRMATION PENDING STATE ("Check your email")
  if (status === 'email_confirmation_pending') {
    const targetEmail = pendingConfirmationEmail || email.trim();

    const handleResend = async () => {
      if (!targetEmail || resendCooldown > 0 || busy) return;
      setSubmitError(null);
      setResendMessage(null);
      try {
        await resendConfirmationEmail(targetEmail);
        setResendCooldown(60);
        setResendMessage('Confirmation email sent. Please check your inbox and spam folder.');
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Unable to resend email.');
      }
    };

    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] p-4">
          <div className="flex items-start gap-3">
            <BiIcon name="envelope" className="mt-0.5 text-base shrink-0 text-[var(--df-accent-soft-fg)]" />
            <div className="space-y-1.5 text-xs leading-relaxed text-[var(--df-text)]">
              <h2 className="font-display text-base font-bold">Check your email</h2>
              <p className="text-[var(--df-text-muted)]">
                If <span className="font-semibold text-[var(--df-text)]">{targetEmail}</span> is eligible for registration, a confirmation link has been sent. You must verify your email before signing in.
              </p>
            </div>
          </div>
        </div>

        {submitError && (
          <p role="alert" className="text-xs font-medium text-rose-600 dark:text-rose-400">
            {submitError}
          </p>
        )}

        {resendMessage && (
          <p role="status" className="text-xs font-medium text-[var(--df-accent-soft-fg)]">
            {resendMessage}
          </p>
        )}

        <div className="space-y-2.5">
          <button
            type="button"
            disabled={busy || resendCooldown > 0 || !targetEmail}
            onClick={() => void handleResend()}
            className="flex min-h-[46px] w-full items-center justify-center gap-2 rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-4 text-sm font-semibold text-[var(--df-text)] transition-colors hover:border-[var(--df-border-strong)] hover:bg-[var(--df-surface-hover)] disabled:opacity-50"
          >
            {isSubmittingEmailAuth && <BiIcon name="arrow-repeat" spin className="text-sm" />}
            <span>
              {resendCooldown > 0
                ? `Resend confirmation (${resendCooldown}s)`
                : 'Resend confirmation email'}
            </span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => {
              returnToSignIn();
              switchMode('sign_in');
            }}
            className="flex min-h-[46px] w-full items-center justify-center rounded-2xl bg-[var(--df-accent)] px-4 text-sm font-semibold text-[var(--df-accent-fg)] transition-all hover:brightness-95 disabled:opacity-50"
          >
            Back to Sign In
          </button>
        </div>
      </div>
    );
  }

  // 2. PASSWORD RECOVERY STATE (Update password after clicking reset link)
  if (status === 'password_recovery') {
    const handleUpdatePassword = async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setTouched({ recoveryPassword: true, confirmPassword: true });
      setSubmitError(null);

      const pwdErr = validatePasswordInput(password, confirmPassword);
      if (pwdErr) {
        setSubmitError(pwdErr);
        return;
      }

      try {
        await updatePassword(password);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Unable to update password.');
      }
    };

    return (
      <form onSubmit={(e) => void handleUpdatePassword(e)} noValidate className="space-y-4">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-bold text-[var(--df-text)]">
            Set a new password
          </h2>
          <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
            Choose a strong new password of at least {MIN_PASSWORD_LENGTH} characters for your Ekagra account.
          </p>
        </div>

        {submitError && (
          <p
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
          >
            {submitError}
          </p>
        )}

        <PasswordField
          id="recovery-new-password"
          label="New password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            setTouched((t) => ({ ...t, recoveryPassword: true }));
          }}
          autoComplete="new-password"
          disabled={disabledAll}
          error={recoveryPasswordError}
          helperText={`At least ${MIN_PASSWORD_LENGTH} characters`}
        />

        <PasswordField
          id="recovery-confirm-password"
          label="Confirm new password"
          value={confirmPassword}
          onChange={(v) => {
            setConfirmPassword(v);
            setTouched((t) => ({ ...t, confirmPassword: true }));
          }}
          autoComplete="new-password"
          disabled={disabledAll}
          error={confirmPasswordError}
        />

        <button
          type="submit"
          disabled={disabledAll}
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-[var(--df-accent)] px-5 text-sm font-semibold text-[var(--df-accent-fg)] transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmittingEmailAuth && <BiIcon name="arrow-repeat" spin className="text-sm" />}
          <span>{isSubmittingEmailAuth ? 'Updating password...' : 'Update password'}</span>
        </button>

        <div className="text-center">
          <button
            type="button"
            disabled={busy}
            onClick={() => void cancelPasswordRecovery()}
            className="text-xs font-semibold text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
          >
            Cancel &amp; back to Sign In
          </button>
        </div>
      </form>
    );
  }

  // 3. FORGOT PASSWORD VIEW
  if (mode === 'forgot_password') {
    const handleSendReset = async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setTouched({ email: true });
      setSubmitError(null);

      const err = validateEmailAddress(email);
      if (err) {
        setSubmitError(err);
        return;
      }

      try {
        await sendPasswordReset(email);
        setResetLinkSent(true);
      } catch (resetErr) {
        setSubmitError(
          resetErr instanceof Error ? resetErr.message : 'Unable to send reset link.'
        );
      }
    };

    return (
      <form onSubmit={(e) => void handleSendReset(e)} noValidate className="space-y-4">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-bold text-[var(--df-text)]">
            Reset your password
          </h2>
          <p className="text-xs leading-relaxed text-[var(--df-text-muted)]">
            Enter your account email address and we&apos;ll send you a password reset link.
          </p>
        </div>

        {resetLinkSent && (
          <div
            role="status"
            className="flex items-start gap-2.5 rounded-2xl border border-[var(--df-accent-border)] bg-[var(--df-accent-soft)] px-3.5 py-3 text-xs leading-relaxed text-[var(--df-text)]"
          >
            <BiIcon name="check-circle" className="mt-0.5 text-sm shrink-0 text-[var(--df-accent-soft-fg)]" />
            <p>
              If an account exists for <span className="font-semibold">{email.trim()}</span>, a password reset link has been sent. Open the link in this browser to set a new password.
            </p>
          </div>
        )}

        {submitError && (
          <p
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
          >
            {submitError}
          </p>
        )}

        <div className="space-y-1.5">
          <label
            htmlFor="reset-email"
            className="block text-xs font-semibold text-[var(--df-text)]"
          >
            Email address
          </label>
          <input
            id="reset-email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setTouched((t) => ({ ...t, email: true }));
            }}
            autoComplete="email"
            placeholder="you@example.com"
            disabled={disabledAll}
            aria-invalid={Boolean(emailError)}
            className="min-h-[46px] w-full rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3.5 py-2.5 text-sm text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none disabled:opacity-60"
          />
          {emailError && (
            <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
              {emailError}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={disabledAll}
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-[var(--df-accent)] px-5 text-sm font-semibold text-[var(--df-accent-fg)] transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmittingEmailAuth && <BiIcon name="arrow-repeat" spin className="text-sm" />}
          <span>{isSubmittingEmailAuth ? 'Sending reset link...' : 'Send reset link'}</span>
        </button>

        <div className="text-center">
          <button
            type="button"
            disabled={busy}
            onClick={() => switchMode('sign_in')}
            className="text-xs font-semibold text-[var(--df-text-muted)] hover:text-[var(--df-text)]"
          >
            Back to Sign In
          </button>
        </div>
      </form>
    );
  }

  // 4. SIGN UP VIEW
  if (mode === 'sign_up') {
    const handleSignUp = async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setTouched({ email: true, password: true, confirmPassword: true });
      setSubmitError(null);

      const errEmail = validateEmailAddress(email);
      if (errEmail) {
        setSubmitError(errEmail);
        return;
      }

      const errPassword = validatePasswordInput(password, confirmPassword);
      if (errPassword) {
        setSubmitError(errPassword);
        return;
      }

      try {
        await signUpWithEmail(email, password);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Unable to create account.');
      }
    };

    return (
      <form onSubmit={(e) => void handleSignUp(e)} noValidate className="space-y-3.5">
        {submitError && (
          <p
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs leading-relaxed text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
          >
            {submitError}
          </p>
        )}

        <div className="space-y-1.5">
          <label
            htmlFor="signup-email"
            className="block text-xs font-semibold text-[var(--df-text)]"
          >
            Email address
          </label>
          <input
            id="signup-email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setTouched((t) => ({ ...t, email: true }));
            }}
            autoComplete="email"
            placeholder="you@example.com"
            disabled={disabledAll}
            aria-invalid={Boolean(emailError)}
            className="min-h-[46px] w-full rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3.5 py-2.5 text-sm text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none disabled:opacity-60"
          />
          {emailError && (
            <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
              {emailError}
            </p>
          )}
        </div>

        <PasswordField
          id="signup-password"
          label="Password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            setTouched((t) => ({ ...t, password: true }));
          }}
          autoComplete="new-password"
          disabled={disabledAll}
          error={passwordError}
          helperText={`At least ${MIN_PASSWORD_LENGTH} characters`}
        />

        <PasswordField
          id="signup-confirm-password"
          label="Confirm password"
          value={confirmPassword}
          onChange={(v) => {
            setConfirmPassword(v);
            setTouched((t) => ({ ...t, confirmPassword: true }));
          }}
          autoComplete="new-password"
          disabled={disabledAll}
          error={confirmPasswordError}
        />

        <button
          type="submit"
          disabled={disabledAll}
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-[var(--df-accent)] px-5 text-sm font-semibold text-[var(--df-accent-fg)] transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmittingEmailAuth && <BiIcon name="arrow-repeat" spin className="text-sm" />}
          <span>{isSubmittingEmailAuth ? 'Creating account...' : 'Create Account'}</span>
        </button>

        <p className="pt-1 text-center text-xs text-[var(--df-text-muted)]">
          Already have an account?{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => switchMode('sign_in')}
            className="font-semibold text-[var(--df-text)] underline underline-offset-2 hover:opacity-80"
          >
            Sign In
          </button>
        </p>
      </form>
    );
  }

  // 5. SIGN IN VIEW (Default)
  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setTouched({ email: true, password: true });
    setSubmitError(null);
    setShowResendForUnconfirmed(false);
    setResendMessage(null);

    const errEmail = validateEmailAddress(email);
    if (errEmail) {
      setSubmitError(errEmail);
      return;
    }

    if (!password) {
      setSubmitError('Please enter your password.');
      return;
    }

    try {
      await signInWithEmail(email, password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to sign in.';
      setSubmitError(msg);
      if (isUnconfirmedEmailError(msg)) {
        setShowResendForUnconfirmed(true);
      }
    }
  };

  const handleResendFromSignIn = async () => {
    const trimmed = email.trim();
    if (!trimmed || resendCooldown > 0 || busy) return;
    setResendMessage(null);
    try {
      await resendConfirmationEmail(trimmed);
      setResendCooldown(60);
      setResendMessage('Confirmation link resent. Check your inbox before signing in.');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not resend confirmation email.');
    }
  };

  return (
    <form onSubmit={(e) => void handleSignIn(e)} noValidate className="space-y-3.5">
      {submitError && (
        <div
          role="alert"
          className="space-y-2 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs leading-relaxed text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
        >
          <p>{submitError}</p>
          {showResendForUnconfirmed && (
            <button
              type="button"
              disabled={busy || resendCooldown > 0}
              onClick={() => void handleResendFromSignIn()}
              className="font-semibold underline underline-offset-2 disabled:opacity-50"
            >
              {resendCooldown > 0
                ? `Resend confirmation (${resendCooldown}s)`
                : 'Resend confirmation email'}
            </button>
          )}
        </div>
      )}

      {resendMessage && (
        <p role="status" className="text-xs font-medium text-[var(--df-accent-soft-fg)]">
          {resendMessage}
        </p>
      )}

      <div className="space-y-1.5">
        <label
          htmlFor="signin-email"
          className="block text-xs font-semibold text-[var(--df-text)]"
        >
          Email address
        </label>
        <input
          id="signin-email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setTouched((t) => ({ ...t, email: true }));
          }}
          autoComplete="email"
          placeholder="you@example.com"
          disabled={disabledAll}
          aria-invalid={Boolean(emailError)}
          className="min-h-[46px] w-full rounded-2xl border border-[var(--df-border)] bg-[var(--df-bg)] px-3.5 py-2.5 text-sm text-[var(--df-text)] placeholder:text-[var(--df-text-subtle)] focus:border-[var(--df-border-strong)] focus:outline-none disabled:opacity-60"
        />
        {emailError && (
          <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
            {emailError}
          </p>
        )}
      </div>

      <PasswordField
        id="signin-password"
        label="Password"
        value={password}
        onChange={(v) => {
          setPassword(v);
          setTouched((t) => ({ ...t, password: true }));
        }}
        autoComplete="current-password"
        disabled={disabledAll}
        error={passwordError}
        rightSlot={
          <button
            type="button"
            disabled={busy}
            onClick={() => switchMode('forgot_password')}
            className="text-xs font-medium text-[var(--df-text-muted)] hover:text-[var(--df-text)] disabled:opacity-50"
          >
            Forgot password?
          </button>
        }
      />

      <button
        type="submit"
        disabled={disabledAll}
        className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-[var(--df-accent)] px-5 text-sm font-semibold text-[var(--df-accent-fg)] transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSubmittingEmailAuth && <BiIcon name="arrow-repeat" spin className="text-sm" />}
        <span>{isSubmittingEmailAuth ? 'Signing in...' : 'Sign In'}</span>
      </button>

      <p className="pt-1 text-center text-xs text-[var(--df-text-muted)]">
        Don&apos;t have an account?{' '}
        <button
          type="button"
          disabled={busy}
          onClick={() => switchMode('sign_up')}
          className="font-semibold text-[var(--df-text)] underline underline-offset-2 hover:opacity-80"
        >
          Sign Up
        </button>
      </p>
    </form>
  );
};
