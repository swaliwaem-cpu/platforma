import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import type { UploadedFile as UploadedFileData } from '../files/uploaded-file.type';
import {
  TrainingContentService,
  type TrainingAuditRequest,
} from './training-content.service';
import { TRAINING_MAX_DOCUMENT_BYTES } from './training-document.config';
import { TrainingDocumentWorkerService } from './training-document-worker.service';
import { TrainingDocumentsService } from './training-documents.service';
import { TrainingFeatureGuard } from './training-feature.guard';
import { TrainingFactSuggestionsService } from './fact-suggestions/training-fact-suggestions.service';
import { TrainingOfficialUrlSourcesService } from './training-official-url-sources.service';

type ContentResponse = {
  setHeader(name: string, value: string | number): void;
  send(body: Buffer): void;
};

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
@RequirePermissions('training:projects:manage')
export class TrainingAdminController {
  constructor(
    private readonly trainingContent: TrainingContentService,
    private readonly trainingDocuments: TrainingDocumentsService,
    private readonly documentWorker: TrainingDocumentWorkerService,
    private readonly officialUrlSources: TrainingOfficialUrlSourcesService,
    private readonly factSuggestions: TrainingFactSuggestionsService,
  ) {}

  @Get('real-estate-objects')
  async listRealEstateObjects(@Query() query: Record<string, string | undefined>) {
    return this.trainingDocuments.listRealEstateObjects(query);
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

  @Get('versions/:versionId/documents')
  async listDocuments(@Param('versionId') versionId: string) {
    return this.trainingDocuments.listDocuments(versionId);
  }

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

  @Post('versions/:versionId/fact-suggestion-runs')
  async createFactSuggestionRun(
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.factSuggestions.createRun(
      versionId,
      body,
      actor,
      request,
      idempotencyKey,
    );
  }

  @Get('versions/:versionId/fact-suggestion-runs/latest')
  async getLatestFactSuggestionRun(@Param('versionId') versionId: string) {
    return this.factSuggestions.getLatestRun(versionId);
  }

  @Get('versions/:versionId/fact-suggestions')
  async listFactSuggestions(@Param('versionId') versionId: string) {
    return this.factSuggestions.listSuggestions(versionId);
  }

  @Post(
    'versions/:versionId/fact-suggestions/:suggestionId/accept',
  )
  async acceptFactSuggestion(
    @Param('versionId') versionId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.factSuggestions.acceptSuggestion(
      versionId,
      suggestionId,
      body,
      actor,
      request,
    );
  }

  @Post(
    'versions/:versionId/fact-suggestions/:suggestionId/reject',
  )
  async rejectFactSuggestion(
    @Param('versionId') versionId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.factSuggestions.rejectSuggestion(
      versionId,
      suggestionId,
      body,
      actor,
      request,
    );
  }

  @Post('versions/:versionId/documents')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: TRAINING_MAX_DOCUMENT_BYTES } }),
  )
  async uploadDocument(
    @Param('versionId') versionId: string,
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    const response = await this.trainingDocuments.uploadDocument(
      versionId,
      file,
      actor,
      request,
    );
    this.documentWorker.kick();
    return response;
  }

  @Get('versions/:versionId/documents/:documentId/text')
  async getDocumentText(
    @Param('versionId') versionId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.trainingDocuments.getDocumentText(versionId, documentId);
  }

  @Patch('versions/:versionId/documents/:documentId')
  async updateDocumentText(
    @Param('versionId') versionId: string,
    @Param('documentId') documentId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.trainingDocuments.updateManualText(
      versionId,
      documentId,
      body,
      actor,
      request,
    );
  }

  @Post('versions/:versionId/documents/:documentId/retry')
  async retryDocument(
    @Param('versionId') versionId: string,
    @Param('documentId') documentId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    const response = await this.trainingDocuments.retryDocument(
      versionId,
      documentId,
      actor,
      request,
    );
    this.documentWorker.kick();
    return response;
  }

  @Delete('versions/:versionId/documents/:documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDocument(
    @Param('versionId') versionId: string,
    @Param('documentId') documentId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    await this.trainingDocuments.deleteDocument(
      versionId,
      documentId,
      actor,
      request,
    );
  }

  @Get('versions/:versionId/documents/:documentId/content')
  async getDocumentContent(
    @Param('versionId') versionId: string,
    @Param('documentId') documentId: string,
    @Res() response: ContentResponse,
  ) {
    const { file, buffer } = await this.trainingDocuments.getDocumentContent(
      versionId,
      documentId,
    );
    response.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
    response.setHeader('Content-Length', buffer.length);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader(
      'Content-Disposition',
      getTrainingDocumentContentDisposition(file.originalName),
    );
    response.send(buffer);
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

function getTrainingDocumentContentDisposition(value: string | null) {
  const utf8Name = (value ?? 'training-document').replace(/[\r\n"\\/]/gu, '_');
  const asciiName = utf8Name.replace(/[^\x20-\x7E]/gu, '_');

  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
}
