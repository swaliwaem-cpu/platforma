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
  Req,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import {
  TrainingContentService,
  type TrainingAuditRequest,
} from './training-content.service';
import { TrainingFeatureGuard } from './training-feature.guard';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
@RequirePermissions('training:projects:manage')
export class TrainingAdminFactsController {
  constructor(
    private readonly trainingContent: TrainingContentService,
  ) {}

  @Get('versions/:versionId/facts')
  async listFacts(@Param('versionId') versionId: string) {
    return this.trainingContent.listFacts(versionId);
  }

  @Post('versions/:versionId/facts')
  async createFact(
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.createFact(versionId, body, actor, request);
  }

  @Patch('versions/:versionId/facts/:factId')
  async updateFact(
    @Param('versionId') versionId: string,
    @Param('factId') factId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.updateFact(versionId, factId, body, actor, request);
  }

  @Delete('versions/:versionId/facts/:factId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteFact(
    @Param('versionId') versionId: string,
    @Param('factId') factId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    await this.trainingContent.deleteFact(versionId, factId, actor, request);
  }
}
