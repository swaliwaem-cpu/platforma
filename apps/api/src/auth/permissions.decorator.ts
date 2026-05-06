import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

export function RequirePermissions(...permissions: string[]) {
  return SetMetadata(PERMISSIONS_KEY, permissions);
}
