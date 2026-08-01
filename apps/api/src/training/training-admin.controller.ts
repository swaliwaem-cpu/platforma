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
import { TrainingAdminControllerCompatibility } from './training-admin-controller.compatibility';
import {
  TrainingContentService,
  type TrainingAuditRequest,
} from './training-content.service';
import { TrainingDocumentWorkerService } from './training-document-worker.service';
import { TrainingDocumentsService } from './training-documents.service';
import { TrainingFeatureGuard } from './training-feature.guard';
import { TrainingFactSuggestionsService } from './fact-suggestions/training-fact-suggestions.service';
import { TrainingOfficialUrlSourcesService } from './training-official-url-sources.service';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
@RequirePermissions('training:projects:manage')
export class TrainingAdminController extends TrainingAdminControllerCompatibility {
  constructor(
    private readonly trainingContent: TrainingContentService,
    trainingDocuments: TrainingDocumentsService,
    documentWorker: TrainingDocumentWorkerService,
    officialUrlSources: TrainingOfficialUrlSourcesService,
    factSuggestions: TrainingFactSuggestionsService,
  ) {
    super(
      trainingContent,
      trainingDocuments,
      documentWorker,
      officialUrlSources,
      factSuggestions,
    );
  }

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

  @Get('versions/:versionId/readiness')
  async getVersionReadiness(@Param('versionId') versionId: string) {
    return this.trainingContent.getVersionReadiness(versionId);
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
}
