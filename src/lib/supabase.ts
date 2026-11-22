import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const rawUrl = (import.meta.env?.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
const rawPublishableKey =
  (import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() ?? '';

function isValidSupabaseUrl(value: string): boolean {
  if (!value || value.includes('your-project-id')) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isValidPublishableKey(value: string): boolean {
  if (!value) return false;
  if (
    value.includes('your-supabase-') ||
    value === 'MY_SUPABASE_PUBLISHABLE_KEY' ||
    value.length < 20
  ) {
    return false;
  }
  return true;
}

export const isSupabaseConfigured =
  isValidSupabaseUrl(rawUrl) && isValidPublishableKey(rawPublishableKey);

export const supabaseConfigReason = !isSupabaseConfigured
  ? 'Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to enable Google and Email sign-in.'
  : null;

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(rawUrl, rawPublishableKey, {
      auth: {
        flowType: 'pkce',
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null;
