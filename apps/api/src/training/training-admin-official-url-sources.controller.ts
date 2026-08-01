import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import type { TrainingAuditRequest } from './training-content.service';
import { TrainingFeatureGuard } from './training-feature.guard';
import { TrainingOfficialUrlSourcesService } from './training-official-url-sources.service';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
@RequirePermissions('training:projects:manage')
export class TrainingAdminOfficialUrlSourcesController {
  constructor(
    private readonly officialUrlSources: TrainingOfficialUrlSourcesService,
  ) {}

  @Get('versions/:versionId/official-url-sources')
  async listOfficialUrlSources(@Param('versionId') versionId: string) {
    return this.officialUrlSources.listSources(versionId);
  }

  @Post('versions/:versionId/official-url-sources')
  async createOfficialUrlSource(
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.officialUrlSources.createSource(
      versionId,
      body,
      actor,
      request,
    );
  }

  @Get('versions/:versionId/official-url-sources/:sourceId/text')
  async getOfficialUrlSourceText(
    @Param('versionId') versionId: string,
    @Param('sourceId') sourceId: string,
  ) {
    return this.officialUrlSources.getSourceText(versionId, sourceId);
  }

  @Post('versions/:versionId/official-url-sources/:sourceId/retry')
  async retryOfficialUrlSource(
    @Param('versionId') versionId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.officialUrlSources.retrySource(
      versionId,
      sourceId,
      actor,
      request,
    );
  }

  @Delete('versions/:versionId/official-url-sources/:sourceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOfficialUrlSource(
    @Param('versionId') versionId: string,
    @Param('sourceId') sourceId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    await this.officialUrlSources.deleteSource(
      versionId,
      sourceId,
      actor,
      request,
    );
  }
}
