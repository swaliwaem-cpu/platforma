import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';

import { PrismaService } from '../prisma/prisma.service';
import { getCookieValue, getRefreshCookieName } from './cookies';
import {
  AccessTokenPayload,
  AuthenticatedUser,
  LoginResponse,
  RefreshTokenPayload,
  RequestWithAuth,
} from './auth.types';

const DEFAULT_ACCESS_TTL = '15m';
const DEFAULT_REFRESH_TTL_DAYS = 30;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(email: string, password: string): Promise<LoginResponse & { refreshToken: string }> {
    const user = await this.findActiveUserByEmail(email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const passwordMatches = await argon2.verify(user.passwordHash, password);

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const authUser = this.toAuthenticatedUser(user);
    const tokens = await this.issueTokens(authUser);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: authUser,
    };
  }

  async refresh(request: RequestWithAuth): Promise<LoginResponse & { refreshToken: string }> {
    const refreshToken = getCookieValue(request.headers.cookie, getRefreshCookieName());

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const payload = await this.verifyRefreshToken(refreshToken);
    const user = await this.findActiveUserById(payload.sub);

    if (!user?.refreshTokenHash || !user.refreshTokenExpiresAt) {
      throw new UnauthorizedException('Refresh session is not active');
    }

    if (user.refreshTokenExpiresAt.getTime() <= Date.now()) {
      await this.clearRefreshSession(user.id);
      throw new UnauthorizedException('Refresh session expired');
    }

    const refreshTokenMatches = await argon2.verify(user.refreshTokenHash, refreshToken);

    if (!refreshTokenMatches) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const authUser = this.toAuthenticatedUser(user);
    const tokens = await this.issueTokens(authUser);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: authUser,
    };
  }

  async logout(request: RequestWithAuth) {
    const refreshToken = getCookieValue(request.headers.cookie, getRefreshCookieName());

    if (!refreshToken) {
      return;
    }

    try {
      const payload = await this.verifyRefreshToken(refreshToken);
      await this.clearRefreshSession(payload.sub);
    } catch {
      return;
    }
  }

  async getMe(user: AuthenticatedUser) {
    return { user };
  }

  private async findActiveUserByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: {
        email: email.trim().toLowerCase(),
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      include: this.userInclude(),
    });
  }

  private async findActiveUserById(id: string) {
    return this.prisma.user.findFirst({
      where: {
        id,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      include: this.userInclude(),
    });
  }

  private userInclude() {
    return {
      role: {
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    } as const;
  }

  private toAuthenticatedUser(user: NonNullable<Awaited<ReturnType<AuthService['findActiveUserById']>>>) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      role: {
        id: user.role.id,
        name: user.role.name,
      },
      permissions: user.role.permissions.map(({ permission }) => permission.key),
    };
  }

  private async issueTokens(user: AuthenticatedUser) {
    const refreshTtlDays = Number(process.env.JWT_REFRESH_TTL_DAYS ?? DEFAULT_REFRESH_TTL_DAYS);
    const refreshExpiresAt = new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000);
    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      type: 'access',
    };
    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      email: user.email,
      type: 'refresh',
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret',
        expiresIn: this.getAccessTokenTtlSeconds(),
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh-secret',
        expiresIn: refreshTtlDays * 24 * 60 * 60,
      }),
    ]);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        refreshTokenHash: await argon2.hash(refreshToken, { type: argon2.argon2id }),
        refreshTokenExpiresAt: refreshExpiresAt,
      },
    });

    return {
      accessToken,
      refreshToken,
      refreshExpiresAt,
    };
  }

  private async verifyRefreshToken(refreshToken: string) {
    try {
      const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh-secret',
      });

      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid token type');
      }

      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private async clearRefreshSession(userId: string) {
    await this.prisma.user.updateMany({
      where: { id: userId },
      data: {
        refreshTokenHash: null,
        refreshTokenExpiresAt: null,
      },
    });
  }

  private getAccessTokenTtlSeconds() {
    const value = process.env.JWT_ACCESS_TTL ?? DEFAULT_ACCESS_TTL;
    const match = /^(\d+)([smhd])?$/.exec(value);

    if (!match) {
      return 15 * 60;
    }

    const amount = Number(match[1]);
    const unit = match[2] ?? 's';
    const multiplierByUnit = {
      s: 1,
      m: 60,
      h: 60 * 60,
      d: 24 * 60 * 60,
    };

    return amount * multiplierByUnit[unit as keyof typeof multiplierByUnit];
  }
}
