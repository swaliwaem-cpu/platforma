import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { AuthService } from './auth.service';
import { CookieResponse, EmailRegistrationVerifyInput, RequestWithAuth } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import {
  getMediaCookieName,
  getMediaCookieOptions,
  getRefreshCookieName,
  getRefreshCookieOptions,
} from './cookies';
import { JwtAuthGuard } from './jwt-auth.guard';

type LoginBody = {
  email?: string;
  password?: string;
};

type EmailRegistrationRequestBody = {
  email?: unknown;
};

type EmailRegistrationVerifyBody = {
  email?: unknown;
  code?: unknown;
  token?: unknown;
  password?: unknown;
  passwordConfirmation?: unknown;
};

const DEFAULT_MEDIA_TTL_MINUTES = 200;

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginBody, @Res({ passthrough: true }) response: CookieResponse) {
    const email = body.email?.trim().toLowerCase();
    const password = body.password;

    if (!email || !password) {
      throw new BadRequestException('Email and password are required');
    }

    const result = await this.authService.login(email, password);

    this.setRefreshCookie(response, result.refreshToken);
    this.setMediaCookie(response, result.mediaToken);

    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  @Post('register/request')
  @HttpCode(HttpStatus.OK)
  async requestEmailRegistration(
    @Body() body: EmailRegistrationRequestBody,
    @Req() request: RequestWithAuth,
  ) {
    return this.authService.requestEmailRegistration(this.parseEmail(body.email), request);
  }

  @Post('register/verify')
  @HttpCode(HttpStatus.OK)
  async verifyEmailRegistration(
    @Body() body: EmailRegistrationVerifyBody,
    @Res({ passthrough: true }) response: CookieResponse,
  ) {
    const result = await this.authService.verifyEmailRegistration(this.parseEmailRegistrationVerifyBody(body));

    this.setRefreshCookie(response, result.refreshToken);
    this.setMediaCookie(response, result.mediaToken);

    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: RequestWithAuth, @Res({ passthrough: true }) response: CookieResponse) {
    await this.authService.logout(request);
    response.clearCookie(getRefreshCookieName(), this.clearCookieOptions(getRefreshCookieOptions()));
    response.clearCookie(getMediaCookieName(), this.clearCookieOptions(getMediaCookieOptions()));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() request: RequestWithAuth, @Res({ passthrough: true }) response: CookieResponse) {
    const result = await this.authService.refresh(request);

    this.setRefreshCookie(response, result.refreshToken);
    this.setMediaCookie(response, result.mediaToken);

    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: NonNullable<RequestWithAuth['user']>) {
    return this.authService.getMe(user);
  }

  private parseEmailRegistrationVerifyBody(body: EmailRegistrationVerifyBody): EmailRegistrationVerifyInput {
    const password = this.parseRegistrationPassword(body.password, body.passwordConfirmation);

    if (typeof body.token === 'string' && body.token.trim().length > 0) {
      return {
        token: body.token.trim(),
        ...password,
      };
    }

    const email = this.parseEmail(body.email);

    if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code.trim())) {
      throw new BadRequestException('Email code is required');
    }

    return {
      email,
      code: body.code.trim(),
      ...password,
    };
  }

  private parseRegistrationPassword(passwordValue: unknown, confirmationValue: unknown) {
    if (typeof passwordValue !== 'string' || typeof confirmationValue !== 'string') {
      throw new BadRequestException('Password and confirmation are required');
    }

    if (passwordValue !== confirmationValue) {
      throw new BadRequestException('Password confirmation does not match');
    }

    if (!this.isValidRegistrationPassword(passwordValue)) {
      throw new BadRequestException(
        'Password must be at least 8 ASCII characters and include an uppercase letter and a special character',
      );
    }

    return {
      password: passwordValue,
      passwordConfirmation: confirmationValue,
    };
  }

  private isValidRegistrationPassword(password: string) {
    return (
      password.length >= 8 &&
      /^[\x21-\x7E]+$/.test(password) &&
      /[A-Z]/.test(password) &&
      /[^A-Za-z0-9]/.test(password)
    );
  }

  private parseEmail(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('Email is required');
    }

    const email = value.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      throw new BadRequestException('Email is invalid');
    }

    return email;
  }

  private setRefreshCookie(response: CookieResponse, refreshToken: string) {
    const refreshTtlDays = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30);
    const maxAge = refreshTtlDays * 24 * 60 * 60 * 1000;

    response.cookie(getRefreshCookieName(), refreshToken, getRefreshCookieOptions(maxAge));
  }

  private setMediaCookie(response: CookieResponse, mediaToken: string | null) {
    if (!mediaToken) {
      response.clearCookie(getMediaCookieName(), this.clearCookieOptions(getMediaCookieOptions()));
      return;
    }

    const maxAge = this.getMediaCookieMaxAge();

    response.cookie(getMediaCookieName(), mediaToken, getMediaCookieOptions(maxAge));
  }

  private clearCookieOptions(options: ReturnType<typeof getRefreshCookieOptions>) {
    const { path, sameSite, secure } = options;

    return { path, sameSite, secure };
  }

  private getMediaCookieMaxAge() {
    const ttlMinutes = Number(process.env.MEDIA_TOKEN_TTL_MINUTES ?? DEFAULT_MEDIA_TTL_MINUTES);

    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      return DEFAULT_MEDIA_TTL_MINUTES * 60 * 1000;
    }

    return ttlMinutes * 60 * 1000;
  }
}
