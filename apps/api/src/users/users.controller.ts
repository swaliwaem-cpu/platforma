import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermissions('users:read')
  async list(@Query() query: Record<string, string | undefined>) {
    return this.usersService.list(query);
  }

  @Get('roles')
  @RequirePermissions('users:read')
  async listRoles() {
    return this.usersService.listRoles();
  }

  @Post()
  @RequirePermissions('users:create')
  async create(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.usersService.create(body, actor, request);
  }

  @Patch(':id')
  @RequirePermissions('users:update')
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.usersService.update(id, body, actor, request);
  }

  @Post(':id/activate')
  @RequirePermissions('users:update')
  async activate(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.usersService.activate(id, actor, request);
  }

  @Post(':id/deactivate')
  @RequirePermissions('users:delete')
  async deactivateByAction(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.usersService.deactivate(id, actor, request);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('users:delete')
  async deactivate(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    await this.usersService.deactivate(id, actor, request);
  }
}
