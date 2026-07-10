import type { AuthUser } from '@platforma/shared';

export const MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL = 'admin@fluffywhite.moscow';

export function canAccessLotPresentations(user: Pick<AuthUser, 'email'> | null | undefined) {
  return user?.email.trim().toLowerCase() === MAIN_LOT_PRESENTATIONS_ADMIN_EMAIL;
}
