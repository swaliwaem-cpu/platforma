export type AppTheme = 'minimal-luxury' | 'dark-premium';

type AppThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const defaultAppTheme: AppTheme = 'minimal-luxury';
export const appThemeStorageKey = 'platforma.theme';

const appThemes = [defaultAppTheme, 'dark-premium'] as const satisfies readonly AppTheme[];
const queryThemeMap = {
  c: 'dark-premium',
  d: 'minimal-luxury',
} as const satisfies Record<string, AppTheme>;

function getBrowserSearch() {
  return typeof window === 'undefined' ? '' : window.location.search;
}

function getBrowserStorage(): AppThemeStorage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStoredAppTheme(storage: AppThemeStorage | null): AppTheme | null {
  if (!storage) {
    return null;
  }

  try {
    const theme = storage.getItem(appThemeStorageKey);

    return isAppTheme(theme) ? theme : null;
  } catch {
    return null;
  }
}

function writeStoredAppTheme(theme: AppTheme, storage: AppThemeStorage | null) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(appThemeStorageKey, theme);
  } catch {
    // Theme persistence should never block app initialization.
  }
}

export function isAppTheme(theme: string | null | undefined): theme is AppTheme {
  return appThemes.includes(theme as AppTheme);
}

export function getQueryAppTheme(search: string): AppTheme | null {
  const theme = new URLSearchParams(search).get('theme')?.toLowerCase();

  if (!theme) {
    return null;
  }

  return queryThemeMap[theme as keyof typeof queryThemeMap] ?? null;
}

export function resolveAppTheme(search = getBrowserSearch(), storage = getBrowserStorage()): AppTheme {
  const queryTheme = getQueryAppTheme(search);

  if (queryTheme) {
    writeStoredAppTheme(queryTheme, storage);

    return queryTheme;
  }

  return readStoredAppTheme(storage) ?? defaultAppTheme;
}

export function applyAppTheme(theme: AppTheme, root = document.documentElement) {
  root.dataset.appTheme = theme;
}

export function getAppliedAppTheme(root = document.documentElement): AppTheme {
  return isAppTheme(root.dataset.appTheme) ? root.dataset.appTheme : defaultAppTheme;
}

export function getNextAppTheme(theme: AppTheme): AppTheme {
  return theme === 'dark-premium' ? 'minimal-luxury' : 'dark-premium';
}

export function setAppTheme(theme: AppTheme, storage = getBrowserStorage()) {
  applyAppTheme(theme);
  writeStoredAppTheme(theme, storage);
}

export function initAppTheme() {
  document.documentElement.dataset.appTheme = resolveAppTheme();
}
