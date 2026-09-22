import type { AuthUser } from '@platforma/shared';

const PROJECT_PRESENTATIONS_PERMISSION = 'presentations:projects:manage';

export function canAccessLotPresentations(
  user: Pick<AuthUser, 'id'> | null | undefined,
) {
  return Boolean(user);
}

export function canAccessProjectPresentations(
  user: Pick<AuthUser, 'id' | 'permissions'> | null | undefined,
) {
  return Boolean(user?.permissions?.includes(PROJECT_PRESENTATIONS_PERMISSION));
}
