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
import type { TrainingAuditRequest } from './training-content.service';
import { TRAINING_MAX_DOCUMENT_BYTES } from './training-document.config';
import { TrainingDocumentWorkerService } from './training-document-worker.service';
import { TrainingDocumentsService } from './training-documents.service';
import { TrainingFeatureGuard } from './training-feature.guard';

type ContentResponse = {
  setHeader(name: string, value: string | number): void;
  send(body: Buffer): void;
};

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
@RequirePermissions('training:projects:manage')
export class TrainingAdminDocumentsController {
  constructor(
    private readonly trainingDocuments: TrainingDocumentsService,
    private readonly documentWorker: TrainingDocumentWorkerService,
  ) {}

  @Get('real-estate-objects')
  async listRealEstateObjects(@Query() query: Record<string, string | undefined>) {
    return this.trainingDocuments.listRealEstateObjects(query);
  }

  @Get('versions/:versionId/documents')
  async listDocuments(@Param('versionId') versionId: string) {
    return this.trainingDocuments.listDocuments(versionId);
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
}

function getTrainingDocumentContentDisposition(value: string | null) {
  const utf8Name = (value ?? 'training-document').replace(/[\r\n"\\/]/gu, '_');
  const asciiName = utf8Name.replace(/[^\x20-\x7E]/gu, '_');

  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
}
