import {
  Body,
  Controller,
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
import { TrainingDocumentWorkerService } from './training-document-worker.service';
import { TrainingDocumentsService } from './training-documents.service';
import { TrainingFeatureGuard } from './training-feature.guard';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
@RequirePermissions('training:projects:manage')
export class TrainingLinkedObjectSourcesController {
  constructor(
    private readonly trainingDocuments: TrainingDocumentsService,
    private readonly documentWorker: TrainingDocumentWorkerService,
  ) {}

  @Get('versions/:versionId/linked-object-pdfs')
  async listLinkedObjectPdfs(@Param('versionId') versionId: string) {
    return this.trainingDocuments.listLinkedObjectPdfs(versionId);
  }

  @Post('versions/:versionId/documents/from-linked-object')
  @HttpCode(HttpStatus.ACCEPTED)
  async attachLinkedObjectPdfs(
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    const response = await this.trainingDocuments.attachLinkedObjectPdfs(
      versionId,
      body,
      actor,
      request,
    );
    if (response.createdCount > 0) {
      this.documentWorker.kick();
    }
    return response;
  }
}
