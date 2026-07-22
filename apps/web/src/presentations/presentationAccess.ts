import type { AuthUser } from '@platforma/shared';

export function canAccessLotPresentations(
  user: Pick<AuthUser, 'id'> | null | undefined,
) {
  return Boolean(user);
}

export function canAccessProjectPresentations(
  user: Pick<AuthUser, 'id'> | null | undefined,
) {
  return Boolean(user);
}
