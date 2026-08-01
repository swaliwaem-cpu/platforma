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
export class TrainingAdminQuestionsController {
  constructor(
    private readonly trainingContent: TrainingContentService,
  ) {}

  @Get('versions/:versionId/questions')
  async listQuestions(@Param('versionId') versionId: string) {
    return this.trainingContent.listQuestions(versionId);
  }

  @Post('versions/:versionId/questions')
  async createQuestion(
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.createQuestion(versionId, body, actor, request);
  }

  @Patch('versions/:versionId/questions/:questionId')
  async updateQuestion(
    @Param('versionId') versionId: string,
    @Param('questionId') questionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.updateQuestion(versionId, questionId, body, actor, request);
  }

  @Delete('versions/:versionId/questions/:questionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteQuestion(
    @Param('versionId') versionId: string,
    @Param('questionId') questionId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    await this.trainingContent.deleteQuestion(versionId, questionId, actor, request);
  }
}
