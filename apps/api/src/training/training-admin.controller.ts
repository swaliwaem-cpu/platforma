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

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import {
  TrainingContentService,
  type TrainingAuditRequest,
} from './training-content.service';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('training:projects:manage')
export class TrainingAdminController {
  constructor(private readonly trainingContent: TrainingContentService) {}

  @Get('projects')
  async listProjects(@Query() query: Record<string, string | undefined>) {
    return this.trainingContent.listProjects(query);
  }

  @Post('projects')
  async createProject(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.createProject(body, actor, request);
  }

  @Get('projects/:projectId')
  async getProject(@Param('projectId') projectId: string) {
    return this.trainingContent.getProject(projectId);
  }

  @Patch('projects/:projectId')
  async updateProject(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.updateProject(projectId, body, actor, request);
  }

  @Post('projects/:projectId/draft-version')
  async createDraftVersion(
    @Param('projectId') projectId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.createDraftVersion(projectId, actor, request);
  }

  @Post('projects/:projectId/open')
  async openProject(
    @Param('projectId') projectId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.openProject(projectId, actor, request);
  }

  @Post('projects/:projectId/close')
  async closeProject(
    @Param('projectId') projectId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.closeProject(projectId, actor, request);
  }

  @Post('projects/:projectId/archive')
  async archiveProject(
    @Param('projectId') projectId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.archiveProject(projectId, actor, request);
  }

  @Get('versions/:versionId')
  async getVersion(@Param('versionId') versionId: string) {
    return this.trainingContent.getVersion(versionId);
  }

  @Patch('versions/:versionId')
  async updateVersion(
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.updateVersion(versionId, body, actor, request);
  }

  @Delete('versions/:versionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDraftVersion(
    @Param('versionId') versionId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    await this.trainingContent.deleteDraftVersion(versionId, actor, request);
  }

  @Post('versions/:versionId/publish')
  async publishVersion(
    @Param('versionId') versionId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingContent.publishVersion(versionId, actor, request);
  }

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
