import type { EmailOtpType, Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase, supabaseConfigReason } from '../lib/supabase';
import type { AuthProviderType, AuthUser } from '../types/auth';

export const OAUTH_CALLBACK_PATH = '/auth/callback';
export const MIN_PASSWORD_LENGTH = 8;

export interface EmailSignUpOutcome {
  needsEmailConfirmation: boolean;
  session: Session | null;
  user: User | null;
}

export interface AuthCallbackOutcome {
  session: Session | null;
  error: string | null;
  isRecovery: boolean;
  isEmailConfirmation: boolean;
}

export function validateEmailAddress(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) {
    return 'Please enter your email address.';
  }
  // Practical RFC-safe email check without catastrophic backtracking
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!emailRegex.test(trimmed) || trimmed.length > 254) {
    return 'Please enter a valid email address.';
  }
  return null;
}

export function validatePasswordInput(
  password: string,
  confirmPassword?: string
): string | null {
  if (!password) {
    return 'Please enter a password.';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.length > 128) {
    return 'Password must be 128 characters or fewer.';
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return 'Passwords do not match. Please re-enter both fields.';
  }
  return null;
}

export function mapSupabaseUser(user: User): AuthUser {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>;

  const rawName =
    (typeof meta.full_name === 'string' && meta.full_name.trim()) ||
    (typeof meta.name === 'string' && meta.name.trim()) ||
    null;
  const rawAvatar =
    (typeof meta.avatar_url === 'string' && meta.avatar_url.trim()) ||
    (typeof meta.picture === 'string' && meta.picture.trim()) ||
    null;

  const rawProvider = typeof appMeta.provider === 'string' ? appMeta.provider.toLowerCase() : '';
  const provider: AuthProviderType = rawProvider === 'google' ? 'google' : 'email';

  return {
    id: user.id,
    email: user.email ?? null,
    fullName: rawName,
    avatarUrl: rawAvatar,
    provider,
  };
}

export function isUnconfirmedEmailError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : typeof err === 'string' ? err : '').toLowerCase();
  return msg.includes('email not confirmed') || msg.includes('confirm your email');
}

export function mapAuthError(err: unknown, fallback = 'Authentication failed. Please try again.'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const lower = raw.toLowerCase();

  if (!raw) return fallback;

  if (lower.includes('access_denied') && !lower.includes('otp_expired') && !lower.includes('expired')) {
    if (lower.includes('cancel') || lower.includes('denied')) {
      return 'Sign-in was cancelled or denied. You can try again or continue as a guest.';
    }
  }
  if (lower.includes('cancelled') || lower.includes('canceled')) {
    return 'Google sign-in was cancelled. You can try again or continue as a guest.';
  }
  if (lower.includes('popup') && lower.includes('blocked')) {
    return 'Sign-in popup was blocked by your browser. Allow popups for this site or open Ekagra in a new tab.';
  }
  if (
    lower.includes('otp_expired') ||
    lower.includes('token has expired') ||
    lower.includes('flow_state_expired') ||
    lower.includes('email link is invalid or has expired') ||
    lower.includes('invalid token')
  ) {
    return 'This verification or password-reset link has expired or has already been used. Please request a new email link.';
  }
  if (lower.includes('code verifier') || lower.includes('both auth code and code verifier')) {
    return 'This verification link was opened in a different browser session. If your email is now confirmed, please sign in with your email and password.';
  }
  if (
    lower.includes('invalid login credentials') ||
    lower.includes('invalid_credentials') ||
    lower.includes('invalid email or password')
  ) {
    return 'Incorrect email or password. Please check your details and try again.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Please confirm your email address before signing in. Check your inbox for the verification link.';
  }
  if (lower.includes('user already registered') || lower.includes('already been registered')) {
    return 'Unable to create account with this email—an account may already exist. Try signing in or resetting your password.';
  }
  if (lower.includes('invalid email') || lower.includes('unable to validate email address')) {
    return 'Please enter a valid email address.';
  }
  if (lower.includes('weak_password') || lower.includes('password should be at least')) {
    return `Password is too weak. Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (lower.includes('same_password') || lower.includes('new password should be different')) {
    return 'Please choose a new password that is different from your current password.';
  }
  if (
    lower.includes('rate limit') ||
    lower.includes('over_email_send_rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes('429')
  ) {
    return 'Too many email or login requests. Please wait a minute before trying again.';
  }
  if (lower.includes('expired') || lower.includes('invalid refresh token') || lower.includes('jwt')) {
    return 'Your session has expired. Please sign in again.';
  }
  if (lower.includes('network') || lower.includes('failed to fetch') || lower.includes('fetch')) {
    return 'Network connection failed while reaching authentication services. Check your connection and retry.';
  }
  if (lower.includes('signups not allowed') || lower.includes('email signups are disabled')) {
    return 'Email sign-up is currently disabled in your Supabase Authentication settings.';
  }
  if (lower.includes('provider is not enabled')) {
    return 'This sign-in provider is not enabled yet in your Supabase Authentication settings.';
  }
  if (lower.includes('redirect') && lower.includes('mismatch')) {
    return 'Redirect URL mismatch. Verify this app URL is added to your Supabase Authentication Redirect URLs.';
  }
  return raw;
}

export function getAuthRedirectUri(): string {
  return `${window.location.origin}${OAUTH_CALLBACK_PATH}`;
}

export const getOAuthRedirectUri = getAuthRedirectUri;

export function isAuthCallbackUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === OAUTH_CALLBACK_PATH) return true;

  const search = new URLSearchParams(window.location.search);
  if (
    search.has('code') ||
    (search.has('token_hash') && search.has('type')) ||
    search.has('error') ||
    search.has('error_code')
  ) {
    return true;
  }

  const hash = window.location.hash;
  if (
    hash.includes('access_token=') ||
    hash.includes('error=') ||
    hash.includes('error_code=') ||
    hash.includes('type=recovery')
  ) {
    return true;
  }

  return false;
}

function getConfiguredSupabase() {
  if (!supabase) {
    throw new Error(
      supabaseConfigReason ??
        'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY first.'
    );
  }
  return supabase;
}

const callbackPromiseCache = new Map<string, Promise<AuthCallbackOutcome>>();

async function executeAuthCallback(callbackUrl: string): Promise<AuthCallbackOutcome> {
  if (!supabase) {
    return {
      session: null,
      error: supabaseConfigReason ?? 'Supabase is not configured.',
      isRecovery: false,
      isEmailConfirmation: false,
    };
  }

  try {
    const parsed = new URL(callbackUrl);
    const searchError = parsed.searchParams.get('error');
    const searchErrorCode = parsed.searchParams.get('error_code');
    const searchErrorDesc = parsed.searchParams.get('error_description');

    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const hashError = hashParams.get('error');
    const hashErrorCode = hashParams.get('error_code');
    const hashErrorDesc = hashParams.get('error_description');

    const typeParam = (parsed.searchParams.get('type') || hashParams.get('type') || '').toLowerCase();
    const isRecovery = typeParam === 'recovery';
    const isEmailConfirmation =
      typeParam === 'signup' || typeParam === 'email' || typeParam === 'email_change';

    const oauthError = searchErrorCode || hashErrorCode || searchError || hashError;
    const oauthErrorDesc = searchErrorDesc || hashErrorDesc;

    if (oauthError) {
      return {
        session: null,
        error: mapAuthError(
          `${oauthError} ${oauthErrorDesc ?? ''}`.trim(),
          'Authentication link could not be completed.'
        ),
        isRecovery,
        isEmailConfirmation,
      };
    }

    // 1. Handle token_hash OTP confirmation / password recovery links
    const tokenHash = parsed.searchParams.get('token_hash');
    if (tokenHash && typeParam) {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: typeParam as EmailOtpType,
      });
      if (error) {
        return {
          session: null,
          error: mapAuthError(error, 'This verification link is invalid or has expired.'),
          isRecovery,
          isEmailConfirmation,
        };
      }
      return {
        session: data.session ?? null,
        error: null,
        isRecovery,
        isEmailConfirmation,
      };
    }

    // 2. Handle PKCE authorization code (Google OAuth, email confirmation, or recovery)
    const code = parsed.searchParams.get('code');
    if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        // detectSessionInUrl may have already exchanged the code at client initialization
        const { data: existing } = await supabase.auth.getSession();
        if (existing.session) {
          return {
            session: existing.session,
            error: null,
            isRecovery,
            isEmailConfirmation,
          };
        }
        return {
          session: null,
          error: mapAuthError(error, 'Failed to exchange authentication code for a valid session.'),
          isRecovery,
          isEmailConfirmation,
        };
      }
      return {
        session: data.session ?? null,
        error: null,
        isRecovery,
        isEmailConfirmation,
      };
    }

    // 3. Fallback check for hash-hydrated sessions (detectSessionInUrl)
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      return {
        session: null,
        error: mapAuthError(error),
        isRecovery,
        isEmailConfirmation,
      };
    }
    if (!data.session) {
      return {
        session: null,
        error: 'No active session was returned from the authentication callback.',
        isRecovery,
        isEmailConfirmation,
      };
    }
    return {
      session: data.session,
      error: null,
      isRecovery,
      isEmailConfirmation,
    };
  } catch (err) {
    return {
      session: null,
      error: mapAuthError(err, 'Failed to process authentication callback.'),
      isRecovery: false,
      isEmailConfirmation: false,
    };
  }
}

export const authService = {
  isConfigured(): boolean {
    return isSupabaseConfigured && supabase !== null;
  },

  getConfigNotice(): string | null {
    return supabaseConfigReason;
  },

  async getCurrentSession(): Promise<{ session: Session | null; error: string | null }> {
    if (!supabase) {
      return { session: null, error: null };
    }
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        return { session: null, error: mapAuthError(error, 'Could not restore your session.') };
      }
      return { session: data.session ?? null, error: null };
    } catch (err) {
      return { session: null, error: mapAuthError(err, 'Network error while restoring session.') };
    }
  },

  async startGoogleSignIn(): Promise<{ mode: 'redirect' | 'popup'; popupWindow?: Window | null }> {
    const client = getConfiguredSupabase();
    const redirectTo = getAuthRedirectUri();
    const inIframe = typeof window !== 'undefined' && window.self !== window.top;

    if (inIframe) {
      // Google blocks rendering inside iframes via X-Frame-Options; request URL without iframe redirect
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: true,
          queryParams: {
            prompt: 'select_account',
          },
        },
      });

      if (error || !data?.url) {
        throw new Error(mapAuthError(error, 'Unable to start Google sign-in.'));
      }

      const popupWindow = window.open(
        data.url,
        'dayflow_google_oauth',
        'width=520,height=660,noopener=no'
      );

      if (!popupWindow) {
        throw new Error(
          'Sign-in popup was blocked by your browser. Allow popups for this site or open Ekagra in a new tab.'
        );
      }

      return { mode: 'popup', popupWindow };
    }

    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        queryParams: {
          prompt: 'select_account',
        },
      },
    });

    if (error) {
      throw new Error(mapAuthError(error, 'Unable to start Google sign-in.'));
    }

    return { mode: 'redirect' };
  },

  async signUpWithEmail(email: string, password: string): Promise<EmailSignUpOutcome> {
    const client = getConfiguredSupabase();
    const trimmedEmail = email.trim();

    const { data, error } = await client.auth.signUp({
      email: trimmedEmail,
      password,
      options: {
        emailRedirectTo: getAuthRedirectUri(),
      },
    });

    if (error) {
      throw new Error(mapAuthError(error, 'Unable to create your account right now.'));
    }

    return {
      needsEmailConfirmation: !data.session,
      session: data.session ?? null,
      user: data.user ?? null,
    };
  },

  async signInWithEmail(email: string, password: string): Promise<{ session: Session; user: User }> {
    const client = getConfiguredSupabase();
    const trimmedEmail = email.trim();

    const { data, error } = await client.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });

    if (error) {
      throw new Error(mapAuthError(error, 'Unable to sign in. Please check your credentials.'));
    }

    if (!data.session || !data.user) {
      throw new Error('Authentication completed without an active session. Please try again.');
    }

    return { session: data.session, user: data.user };
  },

  async resendConfirmationEmail(email: string): Promise<void> {
    const client = getConfiguredSupabase();
    const trimmedEmail = email.trim();

    const { error } = await client.auth.resend({
      type: 'signup',
      email: trimmedEmail,
      options: {
        emailRedirectTo: getAuthRedirectUri(),
      },
    });

    if (error) {
      throw new Error(mapAuthError(error, 'Could not resend confirmation email.'));
    }
  },

  async sendPasswordResetEmail(email: string): Promise<void> {
    const client = getConfiguredSupabase();
    const trimmedEmail = email.trim();

    const { error } = await client.auth.resetPasswordForEmail(trimmedEmail, {
      redirectTo: getAuthRedirectUri(),
    });

    if (error) {
      throw new Error(mapAuthError(error, 'Could not send password reset email.'));
    }
  },

  async updatePassword(newPassword: string): Promise<User | null> {
    const client = getConfiguredSupabase();

    const { data, error } = await client.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      throw new Error(mapAuthError(error, 'Could not update your password.'));
    }

    return data.user ?? null;
  },

  async completeAuthCallback(callbackUrl: string): Promise<AuthCallbackOutcome> {
    const cached = callbackPromiseCache.get(callbackUrl);
    if (cached) {
      return cached;
    }
    const promise = executeAuthCallback(callbackUrl);
    callbackPromiseCache.set(callbackUrl, promise);
    return promise;
  },

  async completeOAuthCallback(callbackUrl: string) {
    return this.completeAuthCallback(callbackUrl);
  },

  async upsertProfile(authUser: AuthUser): Promise<void> {
    if (!supabase) return;
    try {
      await supabase.from('profiles').upsert(
        {
          id: authUser.id,
          email: authUser.email,
          full_name: authUser.fullName,
          avatar_url: authUser.avatarUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
    } catch {
      // Non-blocking
    }
  },

  async signOut(): Promise<void> {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) {
      throw new Error(mapAuthError(error, 'Failed to sign out cleanly.'));
    }
  },
};
