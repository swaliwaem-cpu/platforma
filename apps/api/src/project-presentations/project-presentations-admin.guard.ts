import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { RequestWithAuth } from '../auth/auth.types';

@Injectable()
export class ProjectPresentationsAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (process.env.NODE_ENV !== 'production') {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();

    if (request.user?.role.name !== 'admin') {
      throw new ForbiddenException('Project presentations are available to administrators only');
    }

    return true;
  }
}
