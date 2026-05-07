import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { GENERIC_MAX_SIZE_BYTES } from './file-upload.constants';
import { FilesService } from './files.service';
import { UploadedFile as UploadedFileData } from './uploaded-file.type';

type FileContentResponse = {
  setHeader: (name: string, value: string | number) => void;
  send: (body: Buffer) => void;
};

@Controller('files')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @RequirePermissions('files:upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: GENERIC_MAX_SIZE_BYTES } }))
  async upload(
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.filesService.uploadFile(file, actor, 'generic');
  }

  @Get(':id')
  @RequirePermissions('objects:read')
  async getById(@Param('id') id: string) {
    return this.filesService.getById(id);
  }

  @Get(':id/content')
  @RequirePermissions('objects:read')
  async getContent(@Param('id') id: string, @Res() response: FileContentResponse) {
    const { file, buffer } = await this.filesService.getContent(id);

    response.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    response.setHeader('Content-Length', buffer.length);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Content-Disposition', `inline; filename="${sanitizeHeaderFilename(file.originalName)}"`);
    response.send(buffer);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('files:delete')
  async delete(@Param('id') id: string) {
    await this.filesService.delete(id);
  }
}

function sanitizeHeaderFilename(value: string | null) {
  return (value ?? 'file').replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/gu, '_');
}
