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
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectPresentationsAdminGuard } from './project-presentations-admin.guard';
import { ProjectPresentationsService } from './project-presentations.service';
import { ProjectPresentationsWorkerService } from './project-presentations-worker.service';

type ContentResponse = { setHeader(name: string, value: string | number): void; send(body: Buffer): void };

@Controller('project-presentations')
@UseGuards(JwtAuthGuard, ProjectPresentationsAdminGuard)
export class ProjectPresentationsController {
  constructor(
    private readonly service: ProjectPresentationsService,
    private readonly worker: ProjectPresentationsWorkerService,
  ) {}

  @Get('objects')
  listObjects(@Query() query: Record<string, string | undefined>) { return this.service.listCatalogObjects(query); }

  @Get('drafts')
  listDrafts() { return this.service.listDrafts(); }

  @Post('drafts')
  createDraft(@Body() body: Record<string, unknown>, @CurrentUser() actor: AuthenticatedUser) { return this.service.createDraft(body, actor); }

  @Get('drafts/:draftId')
  getDraft(@Param('draftId') draftId: string) { return this.service.getDraft(draftId); }

  @Patch('drafts/:draftId')
  updateDraft(@Param('draftId') draftId: string, @Body() body: Record<string, unknown>) { return this.service.updateDraft(draftId, body); }

  @Put('drafts/:draftId/objects')
  replaceDraftObjects(@Param('draftId') draftId: string, @Body() body: Record<string, unknown>) { return this.service.replaceDraftObjects(draftId, body); }

  @Delete('drafts/:draftId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDraft(@Param('draftId') draftId: string) { await this.service.deleteDraft(draftId); }

  @Post('drafts/:draftId/documents')
  @HttpCode(HttpStatus.ACCEPTED)
  async createDocument(
    @Param('draftId') draftId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const response = await this.service.createDocument(draftId, body, actor);
    this.worker.kick();
    return response;
  }

  @Get('documents')
  listDocuments(@Query() query: Record<string, string | undefined>) { return this.service.listDocuments(query); }

  @Get('documents/:documentId')
  getDocument(@Param('documentId') documentId: string) { return this.service.getDocument(documentId); }

  @Post('documents/:documentId/retry')
  async retryDocument(@Param('documentId') documentId: string) {
    const response = await this.service.retryDocument(documentId);
    this.worker.kick();
    return response;
  }

  @Delete('documents/:documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDocument(@Param('documentId') documentId: string) { await this.service.deleteDocument(documentId); }

  @Get('documents/:documentId/content')
  async getContent(@Param('documentId') documentId: string, @Res() response: ContentResponse) {
    const { file, buffer } = await this.service.getDocumentContent(documentId);
    response.setHeader('Content-Type', file.mimeType ?? 'application/pdf');
    response.setHeader('Content-Length', buffer.length);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Content-Disposition', getContentDisposition(file.originalName));
    response.send(buffer);
  }
}

function getContentDisposition(value: string | null) {
  const utf8Name = (value ?? 'project-presentation.pdf').replace(/[\r\n"\\/]/gu, '_');
  const asciiName = utf8Name.replace(/[^\x20-\x7E]/gu, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
}
