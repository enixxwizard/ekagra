import type { AppSettings } from '../../types/dayflow';
import { THEME_CACHE_KEY } from '../../utils/theme';
import type { IPreferencesStore, LocalUiPreferences } from './types';

const PREFS_KEY = 'ekagra_ui_prefs_v1';
const MAX_PREFS_BYTES = 2048;

const PREF_KEYS_ALLOWED = new Set<keyof LocalUiPreferences>([
  'theme',
  'timeFormat',
  'weekStart',
  'ekuMuted',
  'preferredResourceLanguage',
  'activePage',
]);

function readPrefsObject(): Partial<LocalUiPreferences> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw || raw.length > MAX_PREFS_BYTES) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Partial<LocalUiPreferences>;
  } catch {
    return {};
  }
}

function writePrefsObject(next: Partial<LocalUiPreferences>): void {
  if (typeof window === 'undefined') return;
  try {
    const sanitized: Partial<LocalUiPreferences> = {};
    for (const [k, v] of Object.entries(next)) {
      if (PREF_KEYS_ALLOWED.has(k as keyof LocalUiPreferences)) {
        (sanitized as Record<string, unknown>)[k] = v;
      }
    }
    const serialized = JSON.stringify(sanitized);
    if (serialized.length > MAX_PREFS_BYTES) return;
    window.localStorage.setItem(PREFS_KEY, serialized);
  } catch {
    // Ignore storage quota/privacy mode failures
  }
}

export const preferencesStore: IPreferencesStore & {
  syncFromSettings: (settings: AppSettings) => void;
  clearAll: () => void;
} = {
  getPreference<K extends keyof LocalUiPreferences>(key: K): LocalUiPreferences[K] | null {
    if (key === 'theme' && typeof window !== 'undefined') {
      try {
        const directTheme = window.localStorage.getItem(THEME_CACHE_KEY);
        if (directTheme) {
          return directTheme as LocalUiPreferences[K];
        }
      } catch {
        // fallback below
      }
    }
    const prefs = readPrefsObject();
    const val = prefs[key];
    return val === undefined ? null : (val as LocalUiPreferences[K]);
  },

  setPreference<K extends keyof LocalUiPreferences>(key: K, value: LocalUiPreferences[K]): void {
    if (!PREF_KEYS_ALLOWED.has(key)) return;
    const current = readPrefsObject();
    current[key] = value;
    writePrefsObject(current);

    if (key === 'theme' && typeof window !== 'undefined' && typeof value === 'string') {
      try {
        window.localStorage.setItem(THEME_CACHE_KEY, value);
      } catch {
        // Ignore storage error
      }
    }
  },

  syncFromSettings(settings: AppSettings): void {
    const current = readPrefsObject();
    writePrefsObject({
      ...current,
      theme: settings.theme,
      timeFormat: settings.timeFormat,
      weekStart: settings.weekStart,
      ekuMuted: Boolean(settings.ekuMuted),
      preferredResourceLanguage: settings.preferredResourceLanguage ?? null,
    });
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(THEME_CACHE_KEY, settings.theme);
      } catch {
        // Ignore storage error
      }
    }
  },

  clearAll(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(PREFS_KEY);
    } catch {
      // Ignore
    }
  },
};
