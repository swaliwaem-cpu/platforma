import { CookieOptions } from './auth.types';

export function getCookieValue(cookieHeader: string | string[] | undefined, name: string) {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;

  if (!header) {
    return null;
  }

  const cookies = header.split(';');

  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split('=');

    if (rawKey === name) {
      return decodeURIComponent(rawValue.join('='));
    }
  }

  return null;
}

export function getRefreshCookieName() {
  return process.env.REFRESH_COOKIE_NAME ?? 'platforma_refresh_token';
}

export function getRefreshCookieOptions(maxAge?: number): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}
