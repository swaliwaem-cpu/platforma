import type { AuthUser } from '@platforma/shared';

export const MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL = 'admin@fluffywhite.moscow';

const localHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function canAccessLotPresentations(
  user: Pick<AuthUser, 'email'> | null | undefined,
  hostname = window.location.hostname,
) {
  if (!user) {
    return false;
  }

  return (
    import.meta.env.DEV ||
    localHostnames.has(hostname.trim().toLowerCase()) ||
    user.email.trim().toLowerCase() === MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL
  );
}

export function canAccessProjectPresentations(
  user: Pick<AuthUser, 'role'> | null | undefined,
  hostname = window.location.hostname,
) {
  if (!user) {
    return false;
  }

  return (
    import.meta.env.DEV ||
    localHostnames.has(hostname.trim().toLowerCase()) ||
    user?.role.name.trim().toLowerCase() === 'admin'
  );
}
