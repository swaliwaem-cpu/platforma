import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { MediaTokenPayload, RequestWithAuth } from './auth.types';
import { getCookieValue, getMediaCookieName } from './cookies';

@Injectable()
export class MediaTokenGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = getCookieValue(request.headers.cookie, getMediaCookieName());

    if (!token) {
      throw new UnauthorizedException('Media token is required');
    }

    try {
      const payload = await this.jwtService.verifyAsync<MediaTokenPayload>(token, {
        secret: process.env.JWT_MEDIA_SECRET ?? 'change-me-media-secret',
      });

      if (payload.type !== 'media' || payload.scope !== 'files:read') {
        throw new UnauthorizedException('Invalid media token');
      }

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid media token');
    }
  }
}
