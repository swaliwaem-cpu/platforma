import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { RequestWithAuth } from '../auth/auth.types';

@Injectable()
export class LotPresentationsAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    return Boolean(request.user);
  }
}
