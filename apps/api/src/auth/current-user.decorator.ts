import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { RequestWithAuth } from './auth.types';

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<RequestWithAuth>();

  return request.user;
});
