import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';

import { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { GENERIC_MAX_SIZE_BYTES, IMAGE_MAX_SIZE_BYTES } from '../files/file-upload.constants';
import { UploadedFile as UploadedFileData } from '../files/uploaded-file.type';
import { ObjectsService } from './objects.service';

const objectGalleryBatchFileLimit = 80;

@Controller('objects')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ObjectsController {
  constructor(private readonly objectsService: ObjectsService) {}

  @Get()
  @RequirePermissions('objects:read')
  async list(@Query() query: Record<string, string | undefined>) {
    return this.objectsService.list(query);
  }

  @Get('slug/:slug')
  @RequirePermissions('objects:read')
  async getBySlug(@Param('slug') slug: string) {
    return this.objectsService.getBySlug(slug);
  }

  @Get(':id/feed-units')
  @RequirePermissions('objects:read')
  async listFeedUnits(@Param('id') id: string, @Query() query: Record<string, string | undefined>) {
    return this.objectsService.listFeedUnits(id, query);
  }

  @Get(':id/feed-units/:unitId')
  @RequirePermissions('objects:read')
  async getFeedUnit(@Param('id') id: string, @Param('unitId') unitId: string) {
    return this.objectsService.getFeedUnit(id, unitId);
  }

  @Get(':id')
  @RequirePermissions('objects:read')
  async getById(@Param('id') id: string) {
    return this.objectsService.getById(id);
  }

  @Post()
  @RequirePermissions('objects:create')
  async create(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.create(body, actor, request);
  }

  @Patch(':id')
  @RequirePermissions('objects:update')
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.update(id, body, actor, request);
  }

  @Patch(':id/status')
  @RequirePermissions('objects:publish')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.updateStatus(id, body, actor, request);
  }

  @Post(':id/publish')
  @RequirePermissions('objects:publish')
  async publish(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.publish(id, actor, request);
  }

  @Post(':id/cover')
  @RequirePermissions('objects:update', 'files:upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_MAX_SIZE_BYTES } }))
  async uploadCover(
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.uploadCover(id, file, actor, request);
  }

  @Post(':id/gallery')
  @RequirePermissions('objects:update', 'files:upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMAGE_MAX_SIZE_BYTES } }))
  async uploadGalleryImage(
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.uploadGalleryImage(id, file, actor, request);
  }

  @Patch(':id/gallery/batch')
  @RequirePermissions('objects:update')
  @UseInterceptors(FilesInterceptor('files', objectGalleryBatchFileLimit, { limits: { fileSize: IMAGE_MAX_SIZE_BYTES, files: objectGalleryBatchFileLimit } }))
  async replaceGallery(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: UploadedFileData[] | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.replaceGallery(id, body, files, actor, request);
  }

  @Patch(':id/gallery/layout')
  @RequirePermissions('objects:update')
  async updateGalleryLayout(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.updateGalleryLayout(id, body, actor, request);
  }

  @Patch(':id/gallery/sort')
  @RequirePermissions('objects:update')
  async sortGallery(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.sortGallery(id, body, actor, request);
  }

  @Delete(':id/gallery/:imageId')
  @RequirePermissions('objects:update', 'files:delete')
  async deleteGalleryImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.deleteGalleryImage(id, imageId, actor, request);
  }

  @Post(':id/files')
  @RequirePermissions('objects:update', 'files:upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: GENERIC_MAX_SIZE_BYTES } }))
  async uploadObjectFile(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.uploadObjectFile(id, body, file, actor, request);
  }

  @Delete(':id/files/:objectFileId')
  @RequirePermissions('objects:update', 'files:delete')
  async deleteObjectFile(
    @Param('id') id: string,
    @Param('objectFileId') objectFileId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithAuth,
  ) {
    return this.objectsService.deleteObjectFile(id, objectFileId, actor, request);
  }
}
