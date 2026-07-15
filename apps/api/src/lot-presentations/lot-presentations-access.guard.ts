import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { RequestWithAuth } from '../auth/auth.types';

const allowedEmail = 'admin@fluffywhite.moscow';

@Injectable()
export class LotPresentationsAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (process.env.NODE_ENV !== 'production') {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const email = request.user ? request.user.email.trim().toLowerCase() : null;

    if (email !== allowedEmail) {
      throw new ForbiddenException('Lot presentations access is restricted');
    }

    return true;
  }
}
