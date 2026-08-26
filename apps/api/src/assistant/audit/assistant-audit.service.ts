import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AssistantFeedbackRating,
  AssistantReviewClassification,
  AssistantReviewStatus,
  AssistantRunStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AssistantGeoAliasService } from '../geo/assistant-geo-alias.service';
import { AssistantSourceRegistryService } from '../sources/assistant-source-registry.service';
import { assistantQualityFlags, type AssistantQualityFlag } from './assistant-run-audit';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const maximumPageSize = 50;
const defaultPageSize = 30;
const listInclude = {
  userMessage: { select: { content: true } },
  assistantMessage: { select: { content: true } },
  feedback: {
    select: {
      id: true,
      rating: true,
      reason: true,
      comment: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  reviewItem: {
    select: {
      id: true,
      status: true,
      classification: true,
      reviewerComment: true,
      reviewedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.AssistantRunInclude;

const detailInclude = {
  ...listInclude,
  owner: { select: { id: true, email: true, name: true } },
} satisfies Prisma.AssistantRunInclude;

@Injectable()
export class AssistantAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: AssistantSourceRegistryService,
    private readonly aliases: AssistantGeoAliasService,
  ) {}

  async listRuns(query: unknown) {
    const filters = parseRunFilters(query);
    const where: Prisma.AssistantRunWhereInput = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.reviewStatus ? { reviewItem: { status: filters.reviewStatus } } : {}),
      ...(filters.negativeFeedback ? { feedback: { rating: AssistantFeedbackRating.DISLIKE } } : {}),
      ...(filters.qualityFlags.length > 0 ? { qualityFlags: { hasSome: filters.qualityFlags } } : {}),
    };
    const [runs, total] = await Promise.all([
      this.prisma.assistantRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        include: listInclude,
      }),
      this.prisma.assistantRun.count({ where }),
    ]);
    return {
      items: runs.map((run) => serializeRunSummary(run)),
      total,
      page: filters.page,
      limit: filters.limit,
      totalPages: Math.max(1, Math.ceil(total / filters.limit)),
    };
  }

  async getRun(runIdValue: unknown) {
    const runId = parseUuid(runIdValue, 'runId');
    const run = await this.prisma.assistantRun.findUnique({
      where: { id: runId },
      include: detailInclude,
    });
    if (!run) throw new NotFoundException('ASSISTANT_AUDIT_RUN_NOT_FOUND');
    return {
      run: serializeDates({
        ...serializeRunSummary(run),
        owner: run.owner,
        request: run.userMessage.content,
        finalAnswer: run.assistantMessage?.content ?? null,
        structuredIntent: run.intentJson,
        audit: run.auditJson,
        evidence: run.evidenceJson,
        telemetry: run.telemetryJson,
        errorClassification: run.errorCode,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      }),
    };
  }

  async review(reviewIdValue: unknown, reviewerUserId: string, body: unknown) {
    const reviewId = parseUuid(reviewIdValue, 'reviewId');
    const input = parseReviewInput(body);
    const existing = await this.prisma.assistantReviewItem.findUnique({
      where: { id: reviewId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('ASSISTANT_REVIEW_ITEM_NOT_FOUND');
    const review = await this.prisma.assistantReviewItem.update({
      where: { id: reviewId },
      data: {
        status: AssistantReviewStatus.REVIEWED,
        classification: input.classification,
        reviewerComment: input.comment,
        reviewerUserId,
        reviewedAt: new Date(),
      },
    });
    return { review: serializeDates(review) };
  }

  listSources() {
    return this.sources.list();
  }

  listAliases() {
    return this.aliases.list();
  }

  async listGeoOperations(query: unknown) {
    const limit = parseLimit(query, 100);
    const items = await this.prisma.assistantGeoOperation.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        normalizedQuery: true,
        provider: true,
        status: true,
        durationMs: true,
        cacheHit: true,
        providerCallCount: true,
        errorCode: true,
        createdAt: true,
      },
    });
    return { items: serializeDates(items) };
  }

  async listUsageMetrics(query: unknown) {
    const limit = parseLimit(query, 180);
    const metrics = await this.prisma.assistantUsageMetric.findMany({
      orderBy: [{ windowStartedAt: 'desc' }, { provider: 'asc' }, { model: 'asc' }],
      take: limit,
    });
    return {
      items: metrics.map((metric) => ({
        provider: metric.provider,
        model: metric.model || null,
        window: metric.window,
        windowStartedAt: metric.windowStartedAt.toISOString(),
        requestCount: metric.requestCount,
        completedCount: metric.completedCount,
        errorCount: metric.errorCount,
        inputTokens: Number(metric.inputTokens),
        outputTokens: Number(metric.outputTokens),
        reasoningTokens: Number(metric.reasoningTokens),
        totalTokens: Number(metric.totalTokens),
        totalLatencyMs: Number(metric.totalLatencyMs),
        updatedAt: metric.updatedAt.toISOString(),
      })),
    };
  }
}

function parseRunFilters(value: unknown) {
  if (!isRecord(value)) throw new BadRequestException('ASSISTANT_AUDIT_FILTERS_INVALID');
  const status = value.status === undefined || value.status === ''
    ? null
    : typeof value.status === 'string'
      && Object.values(AssistantRunStatus).includes(value.status as AssistantRunStatus)
      ? value.status as AssistantRunStatus
      : undefined;
  const reviewStatus = value.reviewStatus === undefined || value.reviewStatus === ''
    ? null
    : typeof value.reviewStatus === 'string'
      && Object.values(AssistantReviewStatus).includes(value.reviewStatus as AssistantReviewStatus)
      ? value.reviewStatus as AssistantReviewStatus
      : undefined;
  const rawIssues = typeof value.issues === 'string'
    ? value.issues.split(',').map((issue) => issue.trim()).filter(Boolean)
    : [];
  const negativeFeedback = rawIssues.includes('NEGATIVE_FEEDBACK');
  const qualityFlags = rawIssues.filter((issue): issue is AssistantQualityFlag =>
    assistantQualityFlags.includes(issue as AssistantQualityFlag));
  if (status === undefined || reviewStatus === undefined
    || rawIssues.some((issue) => issue !== 'NEGATIVE_FEEDBACK'
      && !assistantQualityFlags.includes(issue as AssistantQualityFlag))) {
    throw new BadRequestException('ASSISTANT_AUDIT_FILTERS_INVALID');
  }
  return {
    status,
    reviewStatus,
    negativeFeedback,
    qualityFlags,
    page: parseInteger(value.page, 1, 1, 10_000),
    limit: parseInteger(value.limit, defaultPageSize, 1, maximumPageSize),
  };
}

function parseReviewInput(value: unknown) {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'classification' && key !== 'comment')) {
    throw new BadRequestException('ASSISTANT_REVIEW_INPUT_INVALID');
  }
  const classification = typeof value.classification === 'string'
    && Object.values(AssistantReviewClassification).includes(value.classification as AssistantReviewClassification)
    ? value.classification as AssistantReviewClassification
    : null;
  const comment = value.comment === undefined || value.comment === null || value.comment === ''
    ? null
    : typeof value.comment === 'string'
      ? value.comment.trim().replace(/\s+/gu, ' ')
      : undefined;
  if (!classification || comment === undefined || (comment !== null && (!comment || comment.length > 500))) {
    throw new BadRequestException('ASSISTANT_REVIEW_INPUT_INVALID');
  }
  return { classification, comment };
}

function serializeRunSummary(run: Prisma.AssistantRunGetPayload<{ include: typeof listInclude }>) {
  const telemetry = Array.isArray(run.telemetryJson) ? run.telemetryJson : [];
  const accepted = [...telemetry].reverse().find((item) => isRecord(item) && item.outcome === 'ACCEPTED');
  return serializeDates({
    id: run.id,
    status: run.status,
    query: run.userMessage.content,
    answer: run.assistantMessage?.content ?? null,
    qualityFlags: run.qualityFlags,
    latencyMs: run.latencyMs,
    model: isRecord(accepted) && typeof accepted.model === 'string' ? accepted.model : null,
    reasoningEffort: isRecord(accepted) && typeof accepted.reasoningEffort === 'string'
      ? accepted.reasoningEffort
      : null,
    fallback: telemetry.some((item) => isRecord(item) && item.isFallback === true),
    feedback: run.feedback,
    review: run.reviewItem,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  });
}

function parseLimit(value: unknown, fallback: number) {
  return isRecord(value) ? parseInteger(value.limit, fallback, 1, 500) : fallback;
}

function parseInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(parsed) || (parsed as number) < minimum || (parsed as number) > maximum) {
    throw new BadRequestException('ASSISTANT_AUDIT_PAGINATION_INVALID');
  }
  return parsed as number;
}

function parseUuid(value: unknown, field: string) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function serializeDates<Value>(value: Value): Value {
  if (value instanceof Date) return value.toISOString() as Value;
  if (typeof value === 'bigint') return Number(value) as Value;
  if (Array.isArray(value)) return value.map((item) => serializeDates(item)) as Value;
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeDates(item)])) as Value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
