import { BadRequestException, Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHmac, randomBytes, randomInt } from 'crypto';

import { PrismaService } from '../prisma/prisma.service';
import { getCookieValue, getRefreshCookieName } from './cookies';
import {
  AccessTokenPayload,
  AuthenticatedUser,
  EmailRegistrationRequestResponse,
  EmailRegistrationVerifyInput,
  LoginResponse,
  MediaTokenPayload,
  RefreshTokenPayload,
  RequestWithAuth,
} from './auth.types';
import { MailService } from './mail.service';

const DEFAULT_ACCESS_TTL = '15m';
const DEFAULT_REFRESH_TTL_DAYS = 30;
const DEFAULT_MEDIA_TTL_MINUTES = 200;
const DEFAULT_EMAIL_AUTH_TTL_MINUTES = 15;
const DEFAULT_PUBLIC_APP_URL = 'http://localhost:5173';

const authUserInclude = {
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
} as const;

type AuthUserWithRole = Prisma.UserGetPayload<{ include: typeof authUserInclude }>;

type RequestWithAudit = RequestWithAuth & {
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  async login(
    email: string,
    password: string,
  ): Promise<LoginResponse & { refreshToken: string; mediaToken: string | null }> {
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
      mediaToken: tokens.mediaToken,
      user: authUser,
    };
  }

  async refresh(
    request: RequestWithAuth,
  ): Promise<LoginResponse & { refreshToken: string; mediaToken: string | null }> {
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
      mediaToken: tokens.mediaToken,
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

  async requestEmailRegistration(
    email: string,
    request: RequestWithAudit,
  ): Promise<EmailRegistrationRequestResponse> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.findOrCreateEmailRegistrationUser(normalizedEmail);

    if (!user || user.status === UserStatus.BLOCKED || user.status === UserStatus.DEACTIVATED) {
      return { ok: true };
    }

    const token = randomBytes(32).toString('base64url');
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresInMinutes = this.getEmailAuthTtlMinutes();
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

    await this.prisma.emailAuthChallenge.create({
      data: {
        email: normalizedEmail,
        tokenHash: this.hashEmailAuthValue(`token:${token}`),
        codeHash: this.hashEmailAuthValue(`code:${normalizedEmail}:${code}`),
        userId: user.id,
        expiresAt,
        ipAddress: this.getRequestIp(request),
        userAgent: this.getRequestUserAgent(request),
      },
    });

    await this.mailService.sendEmailLogin({
      to: normalizedEmail,
      code,
      loginUrl: this.buildEmailLoginUrl(token),
      expiresInMinutes,
    });

    return { ok: true };
  }

  async verifyEmailRegistration(
    input: EmailRegistrationVerifyInput,
  ): Promise<LoginResponse & { refreshToken: string; mediaToken: string | null }> {
    this.assertValidEmailRegistrationPassword(input.password, input.passwordConfirmation);

    const challenge = await this.findValidEmailAuthChallenge(input);

    if (!challenge || challenge.user.deletedAt) {
      throw new UnauthorizedException('Email login link or code is invalid');
    }

    if (challenge.user.status === UserStatus.BLOCKED || challenge.user.status === UserStatus.DEACTIVATED) {
      throw new UnauthorizedException('User is not active');
    }

    await this.prisma.emailAuthChallenge.update({
      where: { id: challenge.id },
      data: {
        consumedAt: new Date(),
      },
    });

    const sessionUser = await this.prisma.user.update({
      where: { id: challenge.user.id },
      data: {
        passwordHash: await argon2.hash(input.password, { type: argon2.argon2id }),
        ...(challenge.user.status === UserStatus.INVITED ? { status: UserStatus.ACTIVE } : {}),
      },
      include: authUserInclude,
    });
    const authUser = this.toAuthenticatedUser(sessionUser);
    const tokens = await this.issueTokens(authUser);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      mediaToken: tokens.mediaToken,
      user: authUser,
    };
  }

  private async findActiveUserByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: {
        email: email.trim().toLowerCase(),
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      include: authUserInclude,
    });
  }

  private async findActiveUserById(id: string) {
    return this.prisma.user.findFirst({
      where: {
        id,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      include: authUserInclude,
    });
  }

  private assertValidEmailRegistrationPassword(password: string, passwordConfirmation: string) {
    if (typeof password !== 'string' || typeof passwordConfirmation !== 'string') {
      throw new BadRequestException('Password and confirmation are required');
    }

    if (password !== passwordConfirmation) {
      throw new BadRequestException('Password confirmation does not match');
    }

    if (
      password.length < 8 ||
      !/^[\x21-\x7E]+$/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/[^A-Za-z0-9]/.test(password)
    ) {
      throw new BadRequestException(
        'Password must be at least 8 ASCII characters and include an uppercase letter and a special character',
      );
    }
  }

  private async findOrCreateEmailRegistrationUser(email: string) {
    const existingUser = await this.prisma.user.findFirst({
      where: {
        email,
        deletedAt: null,
      },
      include: authUserInclude,
    });

    if (existingUser) {
      return existingUser;
    }

    const userRole = await this.prisma.role.findUnique({
      where: {
        name: 'user',
      },
      select: {
        id: true,
      },
    });

    if (!userRole) {
      throw new InternalServerErrorException('Default user role is not configured');
    }

    return this.prisma.user.create({
      data: {
        email,
        passwordHash: await argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id }),
        roleId: userRole.id,
        status: UserStatus.INVITED,
      },
      include: authUserInclude,
    });
  }

  private async findValidEmailAuthChallenge(input: EmailRegistrationVerifyInput) {
    const baseWhere = {
      consumedAt: null,
      expiresAt: {
        gt: new Date(),
      },
    };

    if ('token' in input) {
      return this.prisma.emailAuthChallenge.findFirst({
        where: {
          ...baseWhere,
          tokenHash: this.hashEmailAuthValue(`token:${input.token}`),
        },
        include: {
          user: {
            include: authUserInclude,
          },
        },
      });
    }

    const email = input.email.trim().toLowerCase();

    return this.prisma.emailAuthChallenge.findFirst({
      where: {
        ...baseWhere,
        email,
        codeHash: this.hashEmailAuthValue(`code:${email}:${input.code}`),
      },
      include: {
        user: {
          include: authUserInclude,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  private toAuthenticatedUser(user: AuthUserWithRole) {
    return {
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
    const mediaPayload: MediaTokenPayload = {
      sub: user.id,
      email: user.email,
      type: 'media',
      scope: 'files:read',
      role: user.role.name,
    };
    const shouldIssueMediaToken = user.permissions.includes('objects:read');

    const [accessToken, refreshToken, mediaToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access-secret',
        expiresIn: this.getAccessTokenTtlSeconds(),
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh-secret',
        expiresIn: refreshTtlDays * 24 * 60 * 60,
      }),
      shouldIssueMediaToken
        ? this.jwtService.signAsync(mediaPayload, {
            secret: process.env.JWT_MEDIA_SECRET ?? 'change-me-media-secret',
            expiresIn: this.getMediaTokenTtlSeconds(),
          })
        : Promise.resolve(null),
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
      mediaToken,
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

  private getMediaTokenTtlSeconds() {
    const ttlMinutes = Number(process.env.MEDIA_TOKEN_TTL_MINUTES ?? DEFAULT_MEDIA_TTL_MINUTES);

    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      return DEFAULT_MEDIA_TTL_MINUTES * 60;
    }

    return ttlMinutes * 60;
  }

  private getEmailAuthTtlMinutes() {
    const ttlMinutes = Number(process.env.EMAIL_AUTH_TTL_MINUTES ?? DEFAULT_EMAIL_AUTH_TTL_MINUTES);

    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      return DEFAULT_EMAIL_AUTH_TTL_MINUTES;
    }

    return ttlMinutes;
  }

  private hashEmailAuthValue(value: string) {
    return createHmac('sha256', this.getEmailAuthSecret()).update(value).digest('hex');
  }

  private getEmailAuthSecret() {
    return process.env.EMAIL_AUTH_SECRET ?? process.env.JWT_ACCESS_SECRET ?? 'change-me-email-auth-secret';
  }

  private buildEmailLoginUrl(token: string) {
    const url = new URL('/login', process.env.PUBLIC_APP_URL ?? DEFAULT_PUBLIC_APP_URL);

    url.searchParams.set('auth_token', token);

    return url.toString();
  }

  private getRequestIp(request: RequestWithAudit) {
    const forwardedFor = request.headers['x-forwarded-for'];
    const value = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const ip = value?.split(',')[0]?.trim() || request.ip || request.socket?.remoteAddress || null;

    return ip ? ip.slice(0, 64) : null;
  }

  private getRequestUserAgent(request: RequestWithAudit) {
    const userAgent = request.headers['user-agent'];
    const value = Array.isArray(userAgent) ? userAgent[0] : userAgent;

    return value ? value.slice(0, 512) : null;
  }
}
