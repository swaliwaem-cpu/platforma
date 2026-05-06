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
import { CookieResponse, RequestWithAuth } from './auth.types';
import { CurrentUser } from './current-user.decorator';
import { getRefreshCookieName, getRefreshCookieOptions } from './cookies';
import { JwtAuthGuard } from './jwt-auth.guard';

type LoginBody = {
  email?: string;
  password?: string;
};

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

    return {
      accessToken: result.accessToken,
      user: result.user,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: RequestWithAuth, @Res({ passthrough: true }) response: CookieResponse) {
    await this.authService.logout(request);
    response.clearCookie(getRefreshCookieName(), this.clearCookieOptions());
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() request: RequestWithAuth, @Res({ passthrough: true }) response: CookieResponse) {
    const result = await this.authService.refresh(request);

    this.setRefreshCookie(response, result.refreshToken);

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

  private setRefreshCookie(response: CookieResponse, refreshToken: string) {
    const refreshTtlDays = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30);
    const maxAge = refreshTtlDays * 24 * 60 * 60 * 1000;

    response.cookie(getRefreshCookieName(), refreshToken, getRefreshCookieOptions(maxAge));
  }

  private clearCookieOptions() {
    const { path, sameSite, secure } = getRefreshCookieOptions();

    return { path, sameSite, secure };
  }
}
