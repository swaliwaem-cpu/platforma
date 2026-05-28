import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { FEED_XML_MAX_SIZE_BYTES } from '../files/file-upload.constants';
import { UploadedFile as UploadedFileData } from '../files/uploaded-file.type';
import { FeedsService } from './feeds.service';

@Controller('feeds')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FeedsController {
  constructor(private readonly feedsService: FeedsService) {}

  @Get('sources')
  @RequirePermissions('feeds:read')
  async listSources(@Query() query: Record<string, string | undefined>) {
    return this.feedsService.listSources(query);
  }

  @Post('sources')
  @RequirePermissions('feeds:manage')
  @UseInterceptors(FileInterceptor('xmlFile', { limits: { fileSize: FEED_XML_MAX_SIZE_BYTES } }))
  async createSource(
    @Body() body: Record<string, unknown>,
    @UploadedFile() xmlFile: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.feedsService.createSource(body, xmlFile, actor);
  }

  @Post('analyze')
  @RequirePermissions('feeds:manage')
  @UseInterceptors(FileInterceptor('xmlFile', { limits: { fileSize: FEED_XML_MAX_SIZE_BYTES } }))
  async analyzeFeed(
    @Body() body: Record<string, unknown>,
    @UploadedFile() xmlFile: UploadedFileData | undefined,
  ) {
    return this.feedsService.analyzeSource(body, xmlFile);
  }

  @Patch('sources/:id')
  @RequirePermissions('feeds:manage')
  @UseInterceptors(FileInterceptor('xmlFile', { limits: { fileSize: FEED_XML_MAX_SIZE_BYTES } }))
  async updateSource(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() xmlFile: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.feedsService.updateSource(id, body, xmlFile, actor);
  }

  @Post('sources/:id/preview')
  @RequirePermissions('feeds:run')
  async runPreview(@Param('id') id: string) {
    return this.feedsService.runFeedImportCommand(id, 'preview');
  }

  @Post('sources/:id/run')
  @RequirePermissions('feeds:run')
  async runImport(@Param('id') id: string) {
    return this.feedsService.runFeedImportCommand(id, 'run');
  }

  @Get('sources/:id/runs')
  @RequirePermissions('feeds:read')
  async listSourceRuns(@Param('id') id: string, @Query() query: Record<string, string | undefined>) {
    return this.feedsService.listSourceRuns(id, query);
  }

  @Get('runs/:id')
  @RequirePermissions('feeds:read')
  async getRun(@Param('id') id: string) {
    return this.feedsService.getRun(id);
  }

  @Post('runs/:id/stop')
  @RequirePermissions('feeds:run')
  async stopRun(@Param('id') id: string) {
    return this.feedsService.stopFeedImportRun(id);
  }

  @Get('units')
  @RequirePermissions('feeds:read')
  async listUnits(@Query() query: Record<string, string | undefined>) {
    return this.feedsService.listUnits(query);
  }
}
