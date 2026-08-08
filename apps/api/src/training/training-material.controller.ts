import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ApplyTrainingMaterialSuggestionsRequest } from '@platforma/shared' with { 'resolution-mode': 'import' };

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import type { UploadedFile as UploadedFileData } from '../files/uploaded-file.type';
import { TrainingMaterialOperationService } from './training-material-operation.service';
import { TrainingMaterialService } from './training-material.service';
import {
  cleanupTrainingPdfUpload,
  trainingMaterialPdfUploadOptions,
} from './training-material-upload';
import { TrainingFeatureGuard } from './training-runtime-config';
import { parseUuid } from './training.validation';

type ContentResponse = { setHeader(name: string, value: string | number): void; send(body: Buffer): void };
type StatusResponse = { status(code: number): StatusResponse };

@Controller('training/admin')
@UseGuards(TrainingFeatureGuard, JwtAuthGuard, PermissionsGuard)
@RequirePermissions('training:projects:manage')
export class TrainingMaterialController {
  constructor(
    private readonly materials: TrainingMaterialService,
    private readonly operations: TrainingMaterialOperationService,
  ) {}

  @Get('projects/:projectId/materials')
  list(@Param('projectId') projectId: string) {
    return this.materials.list(parseUuid(projectId, 'projectId'));
  }

  @Get('projects/:projectId/object-options')
  listObjectOptions(
    @Param('projectId') projectId: string,
    @Query('search') search: string | undefined,
  ) {
    return this.materials.listObjectOptions(parseUuid(projectId, 'projectId'), search);
  }

  @Post('projects/:projectId/import-object')
  @HttpCode(HttpStatus.ACCEPTED)
  importObjectContent(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.operations.queueObjectImport({
      projectId: parseUuid(projectId, 'projectId'),
      actorId: actor.id,
      idempotencyKey: parseUuid(idempotencyKey, 'Idempotency-Key'),
      objectId: parseUuid(body.objectId, 'objectId'),
      replaceExistingQuestions: requiredBoolean(body.replaceExistingQuestions, 'replaceExistingQuestions'),
    });
  }

  @Post('projects/:projectId/materials')
  createMaterial(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    const parsedProjectId = parseUuid(projectId, 'projectId');
    const title = requiredText(body.title, 'title', 240);
    if (body.type === 'MANUAL_TEXT') {
      return this.materials.createManual(
        parsedProjectId, actor.id, title, requiredText(body.text, 'text'),
      );
    }
    if (body.type === 'OFFICIAL_URL') {
      response.status(HttpStatus.ACCEPTED);
      return this.operations.queueOfficialUrl({
        projectId: parsedProjectId,
        actorId: actor.id,
        idempotencyKey: parseUuid(idempotencyKey, 'Idempotency-Key'),
        title,
        sourceUrl: requiredText(body.url, 'url', 2_048),
        officialConfirmed: body.officialConfirmed === true,
        replaceExistingQuestions: optionalBoolean(body.replaceExistingQuestions, 'replaceExistingQuestions'),
      });
    }
    if (body.type === 'OBJECT_SNAPSHOT') {
      return this.materials.createObjectSnapshot(
        parsedProjectId, actor.id, title, stringArray(body.fieldCodes, 'fieldCodes'),
      );
    }
    throw new BadRequestException('MATERIAL_TYPE_INVALID');
  }

  @Post('projects/:projectId/materials/pdf')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file', trainingMaterialPdfUploadOptions))
  async createPdf(
    @Param('projectId') projectId: string,
    @Body('title') title: string,
    @Body('replaceExistingQuestions') replaceExistingQuestions: unknown,
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    try {
      return await this.operations.queuePdf({
        projectId: parseUuid(projectId, 'projectId'),
        actorId: actor.id,
        idempotencyKey: parseUuid(idempotencyKey, 'Idempotency-Key'),
        title: requiredText(title, 'title', 240),
        file,
        replaceExistingQuestions: optionalMultipartBoolean(
          replaceExistingQuestions,
          'replaceExistingQuestions',
        ),
      });
    } finally {
      await cleanupTrainingPdfUpload(file);
    }
  }

  @Get('projects/:projectId/material-operations')
  listOperations(@Param('projectId') projectId: string) {
    return this.operations.list(parseUuid(projectId, 'projectId'));
  }

  @Get('material-operations/:operationId')
  getOperation(@Param('operationId') operationId: string) {
    return this.operations.get(parseUuid(operationId, 'operationId'));
  }

  @Post('material-operations/:operationId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retryOperation(@Param('operationId') operationId: string) {
    return this.operations.retry(parseUuid(operationId, 'operationId'));
  }

  @Get('materials/:materialId')
  get(@Param('materialId') materialId: string) {
    return this.materials.get(parseUuid(materialId, 'materialId'));
  }

  @Post('materials/:materialId/revisions')
  @UseInterceptors(FileInterceptor('file', trainingMaterialPdfUploadOptions))
  async refresh(
    @Param('materialId') materialId: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const parsedMaterialId = parseUuid(materialId, 'materialId');
    try {
      if (file) return await this.materials.refreshPdf(parsedMaterialId, actor.id, file);
      return await this.materials.refresh(parsedMaterialId, actor.id, {
        ...(body.text === undefined ? {} : { text: requiredText(body.text, 'text') }),
        ...(body.fieldCodes === undefined ? {} : { fieldCodes: stringArray(body.fieldCodes, 'fieldCodes') }),
      });
    } finally {
      await cleanupTrainingPdfUpload(file);
    }
  }

  @Post('material-revisions/:revisionId/suggestions')
  generateSuggestions(@Param('revisionId') revisionId: string) {
    return this.materials.generateSuggestions(parseUuid(revisionId, 'revisionId'));
  }

  @Post('material-revisions/:revisionId/apply-suggestions')
  applySuggestions(
    @Param('revisionId') revisionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.materials.applySuggestions(
      parseUuid(revisionId, 'revisionId'), parseApplySuggestions(body),
    );
  }

  @Patch('materials/:materialId')
  archive(@Param('materialId') materialId: string, @Body() body: Record<string, unknown>) {
    if (body.status !== 'ARCHIVED') throw new BadRequestException('MATERIAL_STATUS_INVALID');
    return this.materials.archive(parseUuid(materialId, 'materialId'));
  }

  @Get('materials/:materialId/pdf')
  async downloadPdf(
    @Param('materialId') materialId: string,
    @Res() response: ContentResponse,
  ) {
    const { file, buffer } = await this.materials.downloadPdf(parseUuid(materialId, 'materialId'));
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Length', buffer.length);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Disposition', `inline; filename="${safeFilename(file.originalName)}"`);
    response.send(buffer);
  }
}

function parseApplySuggestions(body: Record<string, unknown>): ApplyTrainingMaterialSuggestionsRequest {
  if (!Array.isArray(body.suggestions) || body.suggestions.length === 0 || body.suggestions.length > 30) {
    throw new BadRequestException('suggestions must contain 1..30 items');
  }
  return {
    suggestions: body.suggestions.map((value, index) => {
      if (!isRecord(value)) throw new BadRequestException(`suggestions[${index}] is invalid`);
      return {
        suggestionId: requiredText(value.suggestionId, `suggestions[${index}].suggestionId`, 64),
        targetQuestionId: parseUuid(value.targetQuestionId, `suggestions[${index}].targetQuestionId`),
        statement: requiredText(value.statement, `suggestions[${index}].statement`, 1_000),
        aliases: stringArray(value.aliases, `suggestions[${index}].aliases`, 20, 0),
        isRequired: requiredBoolean(value.isRequired, `suggestions[${index}].isRequired`),
        sourceLocator: requiredText(value.sourceLocator, `suggestions[${index}].sourceLocator`, 240),
        sourceExcerpt: requiredText(value.sourceExcerpt, `suggestions[${index}].sourceExcerpt`, 500),
      };
    }),
  };
}

function requiredText(value: unknown, field: string, maximum = 2_000_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string, maximum = 32, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum ||
    value.some((item) => typeof item !== 'string')) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value as string[];
}

function requiredBoolean(value: unknown, field: string) {
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} is invalid`);
  return value;
}

function optionalBoolean(value: unknown, field: string) {
  if (value === undefined) return false;
  return requiredBoolean(value, field);
}

function optionalMultipartBoolean(value: unknown, field: string) {
  if (value === undefined) return false;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  throw new BadRequestException(`${field} is invalid`);
}

function safeFilename(value: string | null) {
  return (value ?? 'training-material.pdf').replace(/["\\\r\n]/gu, '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
