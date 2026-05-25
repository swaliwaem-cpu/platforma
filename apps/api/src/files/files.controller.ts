import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
import {
  type FileContentResponse,
  getFileContentDisposition,
  sendFileContentResponse,
} from './file-content-response';
import { FilesService } from './files.service';
import { UploadedFile as UploadedFileData } from './uploaded-file.type';

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
  async getContent(
    @Param('id') id: string,
    @Query('variant') variant: string | undefined,
    @Res() response: FileContentResponse,
    @Query('download') download: string | undefined,
  ) {
    const content = await this.filesService.getContent(id, variant);

    sendFileContentResponse(response, content, {
      disposition: getFileContentDisposition(download),
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('files:delete')
  async delete(@Param('id') id: string) {
    await this.filesService.delete(id);
  }
}
