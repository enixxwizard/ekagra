import type { ResolvedTheme, ThemeMode } from '../types/dayflow';

export const THEME_CACHE_KEY = 'dayflow_theme_v1';

export interface ThemeOptionMeta {
  id: ThemeMode;
  label: string;
  description: string;
  previewBg: string;
  previewSurface: string;
  previewBorder: string;
  previewText: string;
  previewAccent: string;
}

export const THEME_OPTIONS: ThemeOptionMeta[] = [
  {
    id: 'paper',
    label: 'Paper',
    description: 'Warm white & fresh green',
    previewBg: '#FAF9F6',
    previewSurface: '#FFFFFF',
    previewBorder: '#E8E5DC',
    previewText: '#20211F',
    previewAccent: '#B9E769',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Charcoal & crisp lime',
    previewBg: '#141513',
    previewSurface: '#1C1D1A',
    previewBorder: '#2C2D28',
    previewText: '#F5F4EF',
    previewAccent: '#B9E769',
  },
  {
    id: 'slate',
    label: 'Slate',
    description: 'Deep blue-grey & soft blue',
    previewBg: '#12171E',
    previewSurface: '#19202A',
    previewBorder: '#2A3545',
    previewText: '#EDF2F8',
    previewAccent: '#7EB8FA',
  },
  {
    id: 'sand',
    label: 'Sand',
    description: 'Warm neutral & sage',
    previewBg: '#F4EFE6',
    previewSurface: '#FCF9F4',
    previewBorder: '#DFD5C5',
    previewText: '#27221C',
    previewAccent: '#BDD186',
  },
  {
    id: 'system',
    label: 'System',
    description: 'Matches your OS mode',
    previewBg: '#EAE7DE',
    previewSurface: '#20211F',
    previewBorder: '#C7C3B7',
    previewText: '#20211F',
    previewAccent: '#B9E769',
  },
];

export function normalizeThemeMode(raw: unknown): ThemeMode {
  if (raw === 'light') return 'paper';
  if (raw === 'dark') return 'midnight';
  if (
    raw === 'paper' ||
    raw === 'midnight' ||
    raw === 'slate' ||
    raw === 'sand' ||
    raw === 'system'
  ) {
    return raw;
  }
  return 'paper';
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'system') {
    return systemDark ? 'midnight' : 'paper';
  }
  return mode;
}

export function isDarkResolvedTheme(resolved: ResolvedTheme): boolean {
  return resolved === 'midnight' || resolved === 'slate';
}

export function applyThemeToDocument(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  const resolved = resolveTheme(mode, systemDark);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    const isDark = isDarkResolvedTheme(resolved);
    root.dataset.theme = resolved;
    root.classList.toggle('dark', isDark);
    root.style.colorScheme = isDark ? 'dark' : 'light';
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_CACHE_KEY, mode);
    } catch {
      // Ignore storage quota / privacy errors
    }
  }
  return resolved;
}
