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
export class TrainingAdminCriteriaController {
  constructor(
    private readonly trainingContent: TrainingContentService,
  ) {}

  @Get('versions/:versionId/criteria')
  async listCriteria(@Param('versionId') versionId: string) {
    return this.trainingContent.listCriteria(versionId);
  }

  @Post('versions/:versionId/criteria')
  async createCriterion(
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.createCriterion(versionId, body, actor, request);
  }

  @Patch('versions/:versionId/criteria/:criterionId')
  async updateCriterion(
    @Param('versionId') versionId: string,
    @Param('criterionId') criterionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.updateCriterion(versionId, criterionId, body, actor, request);
  }

  @Delete('versions/:versionId/criteria/:criterionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCriterion(
    @Param('versionId') versionId: string,
    @Param('criterionId') criterionId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    await this.trainingContent.deleteCriterion(versionId, criterionId, actor, request);
  }
}
