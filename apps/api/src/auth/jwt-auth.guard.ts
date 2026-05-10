import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenPayload, RequestWithAuth } from './auth.types';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = this.extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException('Access token is required');
    }

    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret',
      });

      if (payload.type !== 'access') {
        throw new UnauthorizedException('Invalid token type');
      }

      const user = await this.prisma.user.findFirst({
        where: {
          id: payload.sub,
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true,
                },
              },
            },
          },
          profilePhotoFile: true,
        },
      });

      if (!user) {
        throw new UnauthorizedException('User is not active');
      }

      request.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        role: {
          id: user.role.id,
          name: user.role.name,
        },
        profilePhotoFile: user.profilePhotoFile
          ? {
              id: user.profilePhotoFile.id,
              url: user.profilePhotoFile.url,
              originalName: user.profilePhotoFile.originalName,
              mimeType: user.profilePhotoFile.mimeType,
              updatedAt: user.profilePhotoFile.updatedAt.toISOString(),
            }
          : null,
        permissions: user.role.permissions.map(({ permission }) => permission.key),
      };

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid access token');
    }
  }

  private extractBearerToken(authorizationHeader: string | string[] | undefined) {
    const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;

    if (!header?.startsWith('Bearer ')) {
      return null;
    }

    return header.slice('Bearer '.length).trim();
  }
}
