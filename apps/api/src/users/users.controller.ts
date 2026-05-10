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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { IMAGE_MAX_SIZE_BYTES } from '../files/file-upload.constants';
import { UploadedFile as UploadedFileData } from '../files/uploaded-file.type';
import { UsersService } from './users.service';

type FileContentResponse = {
  setHeader: (name: string, value: string | number) => void;
  send: (body: Buffer) => void;
};

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

  @Get('me/profile-photo/content')
  async getOwnProfilePhotoContent(
    @CurrentUser() actor: AuthenticatedUser,
    @Res() response: FileContentResponse,
  ) {
    const { file, buffer } = await this.usersService.getOwnProfilePhotoContent(actor);

    response.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    response.setHeader('Content-Length', buffer.length);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Content-Disposition', `inline; filename="${sanitizeHeaderFilename(file.originalName)}"`);
    response.send(buffer);
  }

  @Patch('me')
  async updateOwnProfile(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.usersService.updateOwnProfile(body, actor, request);
  }

  @Patch('me/password')
  async changeOwnPassword(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.usersService.changeOwnPassword(body, actor, request);
  }

  @Post('me/profile-photo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_MAX_SIZE_BYTES } }))
  async uploadOwnProfilePhoto(
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.usersService.uploadOwnProfilePhoto(file, actor, request);
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

function sanitizeHeaderFilename(value: string | null) {
  return (value ?? 'file').replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/gu, '_');
}
