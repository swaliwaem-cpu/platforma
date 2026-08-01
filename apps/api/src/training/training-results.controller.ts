import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  TrainingAttemptStatus,
  TrainingPassStatus,
  TrainingReviewStatus,
} from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { buildTrainingRankingCsv } from './training-csv';
import { TrainingFeatureGuard } from './training-feature.guard';
import { isTrainingUuid } from './training-uuid';
import {
  TrainingRankingService,
  type TrainingRankingFilters,
} from './training-ranking.service';
import {
  TrainingResultsService,
  type TrainingAdminResultFilters,
  type TrainingEmployeeAttemptFilters,
  type TrainingResultsAuditRequest,
} from './training-results.service';

type CsvResponse = {
  setHeader(name: string, value: string): void;
  send(body: string): void;
};

type JsonResponse = {
  setHeader(name: string, value: string): void;
};

@Controller('training')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
export class TrainingEmployeeResultsController {
  constructor(private readonly results: TrainingResultsService) {}

  @Get('projects')
  @RequirePermissions('training:take')
  listProjects(@CurrentUser() user: AuthenticatedUser) {
    return this.results.listEmployeeProjects(user.id);
  }

  @Get('projects/:projectId')
  @RequirePermissions('training:take')
  getProject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.results.getEmployeeProject(
      user.id,
      readUuid(projectId, 'projectId'),
    );
  }

  @Get('attempts')
  @RequirePermissions('training:own-results:read')
  listAttempts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ) {
    return this.results.listEmployeeAttempts(
      user.id,
      readEmployeeAttemptFilters(query),
    );
  }

  @Get('attempts/:attemptId')
  @RequirePermissions('training:own-results:read')
  getAttempt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('attemptId') attemptId: string,
  ) {
    return this.results.getEmployeeAttempt(
      user.id,
      readUuid(attemptId, 'attemptId'),
    );
  }
}

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
@RequirePermissions('training:results:read')
export class TrainingAdminResultsController {
  constructor(
    private readonly results: TrainingResultsService,
    private readonly ranking: TrainingRankingService,
  ) {}

  @Get('results')
  listResults(@Query() query: Record<string, unknown>) {
    return this.results.listAdminResults(readAdminResultFilters(query));
  }

  @Get('results/:attemptId')
  getResult(
    @Param('attemptId') attemptId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingResultsAuditRequest,
    @Res({ passthrough: true }) response: JsonResponse,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    return this.results.getAdminAttempt(
      readUuid(attemptId, 'attemptId'),
      actor,
      request,
    );
  }

  @Get('ranking')
  listRanking(@Query() query: Record<string, unknown>) {
    return this.ranking.list(readRankingFilters(query));
  }

  @Get('ranking/export.csv')
  async exportRanking(
    @Query() query: Record<string, unknown>,
    @Res() response: CsvResponse,
  ) {
    const filters = readRankingFilters(query);
    const ranking = await this.ranking.listForExport({
      user: filters.user,
      projectId: filters.projectId,
    });
    const filename = `training-ranking-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(buildTrainingRankingCsv(ranking));
  }
}

function readEmployeeAttemptFilters(
  query: Record<string, unknown>,
): TrainingEmployeeAttemptFilters {
  const filters: TrainingEmployeeAttemptFilters = {
    page: readInteger(query.page, 'page', 1, 1, 10_000),
    pageSize: readInteger(
      query.pageSize ?? query.limit,
      query.pageSize !== undefined ? 'pageSize' : 'limit',
      20,
      1,
      100,
    ),
    projectId: readOptionalUuid(query.projectId, 'projectId'),
    status: readOptionalEnum(
      query.status,
      'status',
      Object.values(TrainingAttemptStatus),
    ),
    dateFrom: readOptionalDate(query.dateFrom, 'dateFrom', false),
    dateTo: readOptionalDate(query.dateTo, 'dateTo', true),
  };
  validateDateRange(filters.dateFrom, filters.dateTo);
  return filters;
}

function readAdminResultFilters(
  query: Record<string, unknown>,
): TrainingAdminResultFilters {
  const filters: TrainingAdminResultFilters = {
    page: readInteger(query.page, 'page', 1, 1, 10_000),
    pageSize: readInteger(
      query.pageSize ?? query.limit,
      query.pageSize !== undefined ? 'pageSize' : 'limit',
      25,
      1,
      100,
    ),
    user: readOptionalText(query.user, 200),
    userId: readOptionalUuid(query.userId, 'userId'),
    projectId: readOptionalUuid(query.projectId, 'projectId'),
    projectVersionId: readOptionalUuid(
      query.projectVersionId,
      'projectVersionId',
    ),
    status: readOptionalEnum(
      query.status,
      'status',
      Object.values(TrainingAttemptStatus),
    ),
    reviewStatus: readOptionalEnum(
      query.reviewStatus,
      'reviewStatus',
      Object.values(TrainingReviewStatus),
    ),
    passStatus: readOptionalEnum(
      query.passStatus,
      'passStatus',
      Object.values(TrainingPassStatus),
    ),
    requiresReview: readOptionalBoolean(
      query.requiresReview,
      'requiresReview',
    ),
    dateFrom: readOptionalDate(query.dateFrom, 'dateFrom', false),
    dateTo: readOptionalDate(query.dateTo, 'dateTo', true),
    minScore: readOptionalNumber(
      query.minScore ?? query.finalScoreFrom,
      query.minScore !== undefined ? 'minScore' : 'finalScoreFrom',
      0,
      100,
    ),
    maxScore: readOptionalNumber(
      query.maxScore ?? query.finalScoreTo,
      query.maxScore !== undefined ? 'maxScore' : 'finalScoreTo',
      0,
      100,
    ),
    sort: readOptionalEnum(query.sort, 'sort', [
      'newest',
      'oldest',
      'score_desc',
      'score_asc',
    ]),
    sortField: readOptionalEnum(query.sortField, 'sortField', [
      'startedAt',
      'completedAt',
      'finalScore',
    ]),
    sortDirection: readOptionalEnum(
      query.sortDirection,
      'sortDirection',
      ['asc', 'desc'],
    ),
  };
  validateDateRange(filters.dateFrom, filters.dateTo);
  if (
    filters.minScore !== undefined &&
    filters.maxScore !== undefined &&
    filters.minScore > filters.maxScore
  ) {
    throw new BadRequestException(
      'finalScoreFrom/minScore must not exceed finalScoreTo/maxScore',
    );
  }
  if (filters.sortDirection && !filters.sortField) {
    throw new BadRequestException(
      'sortDirection requires sortField',
    );
  }
  return filters;
}

function readRankingFilters(
  query: Record<string, unknown>,
): TrainingRankingFilters {
  return {
    page: readInteger(query.page, 'page', 1, 1, 10_000),
    pageSize: readInteger(query.pageSize, 'pageSize', 25, 1, 100),
    user: readOptionalText(query.user, 200),
    projectId: readOptionalUuid(query.projectId, 'projectId'),
  };
}

function readInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new BadRequestException(
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function readOptionalNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new BadRequestException(
      `${field} must be a number from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function readOptionalBoolean(value: unknown, field: string) {
  if (value === undefined || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new BadRequestException(`${field} must be true or false`);
}

function readOptionalText(value: unknown, maximum: number) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException('Filter must be a string');
  }
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function readOptionalDate(
  value: unknown,
  field: string,
  endOfDay: boolean,
) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be an ISO date`);
  }
  const normalized = /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be an ISO date`);
  }
  return parsed;
}

function readOptionalUuid(value: unknown, field: string) {
  if (value === undefined || value === '') return undefined;
  return readUuid(value, field);
}

function readUuid(value: unknown, field: string) {
  if (
    !isTrainingUuid(value)
  ) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function readOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value as T;
}

function validateDateRange(dateFrom?: Date, dateTo?: Date) {
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new BadRequestException(
      'dateFrom must not exceed dateTo',
    );
  }
}
