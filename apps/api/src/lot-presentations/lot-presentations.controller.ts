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
  Res,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { LotPresentationsAccessGuard } from './lot-presentations-access.guard';
import { LotPresentationsService } from './lot-presentations.service';

type FileContentResponse = {
  setHeader: (name: string, value: string | number) => void;
  send: (body: Buffer) => void;
};

@Controller('lot-presentations')
@UseGuards(JwtAuthGuard, LotPresentationsAccessGuard)
export class LotPresentationsController {
  constructor(private readonly lotPresentationsService: LotPresentationsService) {}

  @Get('lots')
  async listLots(
    @Query() query: Record<string, string | undefined>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.listLots(query, actor);
  }

  @Get('workspace')
  async getWorkspace(@CurrentUser() actor: AuthenticatedUser) {
    return this.lotPresentationsService.getWorkspace(actor);
  }

  @Post('workspace/items')
  async addWorkspaceItem(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.addWorkspaceItem(body, actor);
  }

  @Delete('workspace/items')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearWorkspace(@CurrentUser() actor: AuthenticatedUser) {
    await this.lotPresentationsService.clearWorkspace(actor);
  }

  @Delete('workspace/items/:unitId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeWorkspaceItem(
    @Param('unitId') unitId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.lotPresentationsService.removeWorkspaceItem(unitId, actor);
  }

  @Patch('workspace/items/:unitId')
  async updateWorkspaceItemComment(
    @Param('unitId') unitId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.updateWorkspaceItemComment(unitId, body, actor);
  }

  @Get('collections')
  async listCollections(
    @Query() query: Record<string, string | undefined>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.listCollections(query, actor);
  }

  @Post('collections')
  async createCollection(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.createCollection(body, actor);
  }

  @Patch('collections/:collectionId')
  async updateCollection(
    @Param('collectionId') collectionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.updateCollection(collectionId, body, actor);
  }

  @Delete('collections/:collectionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteCollection(
    @Param('collectionId') collectionId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.lotPresentationsService.deleteCollection(collectionId, actor);
  }

  @Post('collections/:collectionId/items')
  async addCollectionItem(
    @Param('collectionId') collectionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.addCollectionItem(collectionId, body, actor);
  }

  @Patch('collections/:collectionId/items/:unitId')
  async updateCollectionItemComment(
    @Param('collectionId') collectionId: string,
    @Param('unitId') unitId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.updateCollectionItemComment(collectionId, unitId, body, actor);
  }

  @Delete('collections/:collectionId/items/:unitId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCollectionItem(
    @Param('collectionId') collectionId: string,
    @Param('unitId') unitId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.lotPresentationsService.removeCollectionItem(collectionId, unitId, actor);
  }

  @Post('documents')
  async createDocument(
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.createDocument(body, actor);
  }

  @Get('documents')
  async listDocuments(
    @Query() query: Record<string, string | undefined>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lotPresentationsService.listDocuments(query, actor);
  }

  @Get('documents/:documentId/content')
  async getDocumentContent(
    @Param('documentId') documentId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Res() response: FileContentResponse,
  ) {
    const { file, buffer } = await this.lotPresentationsService.getDocumentContent(documentId, actor);

    response.setHeader('Content-Type', file.mimeType ?? 'application/pdf');
    response.setHeader('Content-Length', buffer.length);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Content-Disposition', `attachment; filename="${sanitizeHeaderFilename(file.originalName)}"`);
    response.send(buffer);
  }
}

function sanitizeHeaderFilename(value: string | null) {
  return (value ?? 'lot-presentation.pdf').replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/gu, '_');
}
