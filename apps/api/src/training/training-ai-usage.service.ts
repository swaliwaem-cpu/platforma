import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { estimateTrainingAiCost } from './training-ai-pricing';
import type { TrainingOpenAIAttemptOutcome } from './training-openai-client';
import type { TrainingOpenAIUsage } from './training-openai-usage';

const TRAINING_AI_USAGE_SPIKE_RATIO = 2;
const TRAINING_AI_USAGE_SPIKE_MIN_TOKENS = 10_000;
const TRAINING_AI_USAGE_SPIKE_BASELINE_DAYS = 7;
const TRAINING_AI_USAGE_SPIKE_MIN_BASELINE_DAYS = 3;

export type TrainingAiUsageRecordInput = Readonly<{
  operationRunId: string;
  operation: string;
  requestedModel: string;
  model: string;
  reasoningEffort: string | null;
  promptVersion: string | null;
  compilerVersion: string | null;
  schemaVersion: string | null;
  projectId: string | null;
  attemptId?: string | null;
  questionId?: string | null;
  attemptOrdinal: number;
  clientRequestId?: string | null;
  requestId?: string | null;
  responseId: string | null;
  httpStatus?: number | null;
  outcome: TrainingOpenAIAttemptOutcome;
  errorCode?: string | null;
  fallbackReason?: string | null;
  isRetry: boolean;
  isFallback: boolean;
  usage: TrainingOpenAIUsage | null;
  latencyMs: number;
  occurredAt?: Date;
}>;

export type TrainingAiUsageReportFilter = Readonly<{
  from: Date;
  to: Date;
  projectId: string | null;
  attemptId: string | null;
  operationRunId: string | null;
}>;

export interface TrainingAiUsageRecorder {
  record(input: TrainingAiUsageRecordInput): Promise<boolean>;
}

type AggregateRow = {
  attempts: bigint;
  acceptedAttempts: bigint;
  tokenReportedAttempts: bigint;
  retryAttempts: bigint;
  fallbackAttempts: bigint;
  inputTokens: bigint;
  cachedTokens: bigint;
  cacheWriteTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  totalTokens: bigint;
  retryTokens: bigint;
  fallbackTokens: bigint;
  estimatedCostUsd: string;
  retryCostUsd: string;
  fallbackCostUsd: string;
  unpricedAttempts: bigint;
  latencyP50: number | null;
  latencyP95: number | null;
  pricingVersions: string[];
};

type DimensionAggregateRow = AggregateRow & { key: string };
type DayAggregateRow = AggregateRow & { key: Date };
type ProjectAggregateRow = AggregateRow & {
  key: string | null;
  projectTitle: string | null;
};
type RunAggregateRow = AggregateRow & {
  operationRunId: string;
  operation: string;
  projectId: string | null;
  attemptId: string | null;
  models: string[];
  createdAt: Date;
};

const AGGREGATE_COLUMNS = Prisma.sql`
  COUNT(*)::bigint AS "attempts",
  COUNT(*) FILTER (WHERE "outcome" = 'accepted')::bigint AS "acceptedAttempts",
  COUNT(*) FILTER (WHERE "total_tokens" IS NOT NULL)::bigint AS "tokenReportedAttempts",
  COUNT(*) FILTER (WHERE "is_retry")::bigint AS "retryAttempts",
  COUNT(*) FILTER (WHERE "is_fallback")::bigint AS "fallbackAttempts",
  COALESCE(SUM("input_tokens"), 0)::bigint AS "inputTokens",
  COALESCE(SUM("cached_tokens"), 0)::bigint AS "cachedTokens",
  COALESCE(SUM("cache_write_tokens"), 0)::bigint AS "cacheWriteTokens",
  COALESCE(SUM("output_tokens"), 0)::bigint AS "outputTokens",
  COALESCE(SUM("reasoning_tokens"), 0)::bigint AS "reasoningTokens",
  COALESCE(SUM("total_tokens"), 0)::bigint AS "totalTokens",
  COALESCE(SUM("total_tokens") FILTER (WHERE "is_retry"), 0)::bigint
    AS "retryTokens",
  COALESCE(SUM("total_tokens") FILTER (WHERE "is_fallback"), 0)::bigint
    AS "fallbackTokens",
  COALESCE(SUM("estimated_cost_usd"), 0)::text AS "estimatedCostUsd",
  COALESCE(SUM("estimated_cost_usd") FILTER (WHERE "is_retry"), 0)::text
    AS "retryCostUsd",
  COALESCE(SUM("estimated_cost_usd") FILTER (WHERE "is_fallback"), 0)::text
    AS "fallbackCostUsd",
  COUNT(*) FILTER (WHERE "pricing_status" <> 'estimated')::bigint AS "unpricedAttempts",
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "latency_ms")::double precision
    AS "latencyP50",
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "latency_ms")::double precision
    AS "latencyP95",
  ARRAY_REMOVE(ARRAY_AGG(DISTINCT "pricing_version"), NULL) AS "pricingVersions"
`;

@Injectable()
export class TrainingAiUsageService implements TrainingAiUsageRecorder {
  private readonly logger = new Logger(TrainingAiUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: TrainingAiUsageRecordInput) {
    const occurredAt = input.occurredAt ?? new Date();
    const pricing = estimateTrainingAiCost(input.model, input.usage, occurredAt);

    try {
      await this.prisma.trainingAiUsageEvent.createMany({
        data: [{
          operationRunId: input.operationRunId,
          provider: 'openai',
          operation: bounded(input.operation, 64),
          requestedModel: bounded(input.requestedModel, 120),
          model: bounded(input.model, 120),
          reasoningEffort: boundedNullable(input.reasoningEffort, 16),
          promptVersion: boundedNullable(input.promptVersion, 64),
          compilerVersion: boundedNullable(input.compilerVersion, 64),
          schemaVersion: boundedNullable(input.schemaVersion, 64),
          projectId: input.projectId,
          attemptId: input.attemptId ?? null,
          questionId: input.questionId ?? null,
          attemptOrdinal: Math.max(1, Math.trunc(input.attemptOrdinal)),
          clientRequestId: boundedNullable(input.clientRequestId ?? null, 160),
          requestId: boundedNullable(input.requestId ?? null, 160),
          responseId: boundedNullable(input.responseId, 160),
          httpStatus: input.httpStatus ?? null,
          outcome: input.outcome,
          errorCode: boundedNullable(input.errorCode ?? null, 120),
          fallbackReason: boundedNullable(input.fallbackReason ?? null, 120),
          isRetry: input.isRetry,
          isFallback: input.isFallback,
          inputTokens: input.usage?.inputTokens ?? null,
          cachedTokens: input.usage?.cachedTokens ?? null,
          cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
          outputTokens: input.usage?.outputTokens ?? null,
          reasoningTokens: input.usage?.reasoningTokens ?? null,
          totalTokens: input.usage?.totalTokens ?? null,
          pricingVersion: pricing.pricingVersion,
          pricingStatus: pricing.pricingStatus,
          estimatedCostUsd: pricing.estimatedCostUsd,
          latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
          createdAt: occurredAt,
        }],
        skipDuplicates: true,
      });
      return true;
    } catch (error) {
      this.logger.warn({
        event: 'training_ai_usage_persist_failed',
        operation: bounded(input.operation, 64),
        code: safePersistenceErrorCode(error),
      });
      return false;
    }
  }

  async report(filter: TrainingAiUsageReportFilter) {
    const where = usageWhere(filter);
    const [totalsRows, dailyRows, operationRows, modelRows, projectRows, runRows] =
      await Promise.all([
        this.prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
          SELECT ${AGGREGATE_COLUMNS}
          FROM "training_ai_usage_events"
          WHERE ${where}
        `),
        this.prisma.$queryRaw<DayAggregateRow[]>(Prisma.sql`
          SELECT
            DATE_TRUNC('day', "created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "key",
            ${AGGREGATE_COLUMNS}
          FROM "training_ai_usage_events"
          WHERE ${where}
          GROUP BY 1
          ORDER BY 1 ASC
        `),
        this.prisma.$queryRaw<DimensionAggregateRow[]>(Prisma.sql`
          SELECT "operation" AS "key", ${AGGREGATE_COLUMNS}
          FROM "training_ai_usage_events"
          WHERE ${where}
          GROUP BY "operation"
          ORDER BY "operation" ASC
        `),
        this.prisma.$queryRaw<DimensionAggregateRow[]>(Prisma.sql`
          SELECT "model" AS "key", ${AGGREGATE_COLUMNS}
          FROM "training_ai_usage_events"
          WHERE ${where}
          GROUP BY "model"
          ORDER BY "model" ASC
        `),
        this.prisma.$queryRaw<ProjectAggregateRow[]>(Prisma.sql`
          SELECT
            usage."project_id" AS "key",
            project."title" AS "projectTitle",
            ${AGGREGATE_COLUMNS}
          FROM "training_ai_usage_events" AS usage
          LEFT JOIN "training_projects" AS project ON project."id" = usage."project_id"
          WHERE ${qualifiedUsageWhere(filter)}
          GROUP BY usage."project_id", project."title"
          ORDER BY COALESCE(project."title", ''), usage."project_id"
        `),
        this.prisma.$queryRaw<RunAggregateRow[]>(Prisma.sql`
          SELECT
            "operation_run_id" AS "operationRunId",
            "operation",
            "project_id" AS "projectId",
            "attempt_id" AS "attemptId",
            ARRAY_AGG(DISTINCT "model" ORDER BY "model") AS "models",
            MAX("created_at") AS "createdAt",
            ${AGGREGATE_COLUMNS}
          FROM "training_ai_usage_events"
          WHERE ${where}
          GROUP BY "operation_run_id", "operation", "project_id", "attempt_id"
          ORDER BY MAX("created_at") DESC
          LIMIT 100
        `),
      ]);
    const totals = serializeAggregate(totalsRows[0] ?? emptyAggregate());
    const daily = dailyRows.map((row) => ({
      day: row.key.toISOString().slice(0, 10),
      ...serializeAggregate(row),
    }));

    return {
      range: {
        from: filter.from.toISOString(),
        to: filter.to.toISOString(),
        projectId: filter.projectId,
        attemptId: filter.attemptId,
        operationRunId: filter.operationRunId,
      },
      totals,
      daily,
      byOperation: operationRows.map((row) => ({
        operation: row.key,
        ...serializeAggregate(row),
      })),
      byModel: modelRows.map((row) => ({
        model: row.key,
        ...serializeAggregate(row),
      })),
      byProject: projectRows.map((row) => ({
        projectId: row.key,
        projectTitle: row.projectTitle,
        ...serializeAggregate(row),
      })),
      recentRuns: {
        limit: 100,
        items: runRows.map((row) => ({
          operationRunId: row.operationRunId,
          operation: row.operation,
          projectId: row.projectId,
          attemptId: row.attemptId,
          models: row.models,
          createdAt: row.createdAt.toISOString(),
          ...serializeAggregate(row),
        })),
      },
      warnings: createSpikeWarnings(daily),
    };
  }
}

function usageWhere(filter: TrainingAiUsageReportFilter) {
  const predicates = [
    Prisma.sql`"created_at" >= ${filter.from}`,
    Prisma.sql`"created_at" < ${filter.to}`,
  ];
  if (filter.projectId) predicates.push(Prisma.sql`"project_id" = CAST(${filter.projectId} AS uuid)`);
  if (filter.attemptId) predicates.push(Prisma.sql`"attempt_id" = CAST(${filter.attemptId} AS uuid)`);
  if (filter.operationRunId) {
    predicates.push(Prisma.sql`"operation_run_id" = CAST(${filter.operationRunId} AS uuid)`);
  }
  return Prisma.join(predicates, ' AND ');
}

function qualifiedUsageWhere(filter: TrainingAiUsageReportFilter) {
  const predicates = [
    Prisma.sql`usage."created_at" >= ${filter.from}`,
    Prisma.sql`usage."created_at" < ${filter.to}`,
  ];
  if (filter.projectId) {
    predicates.push(Prisma.sql`usage."project_id" = CAST(${filter.projectId} AS uuid)`);
  }
  if (filter.attemptId) {
    predicates.push(Prisma.sql`usage."attempt_id" = CAST(${filter.attemptId} AS uuid)`);
  }
  if (filter.operationRunId) {
    predicates.push(
      Prisma.sql`usage."operation_run_id" = CAST(${filter.operationRunId} AS uuid)`,
    );
  }
  return Prisma.join(predicates, ' AND ');
}

function serializeAggregate(row: AggregateRow) {
  const attempts = Number(row.attempts);
  const inputTokens = Number(row.inputTokens);

  return {
    attempts,
    acceptedAttempts: Number(row.acceptedAttempts),
    failedAttempts: attempts - Number(row.acceptedAttempts),
    tokenReportedAttempts: Number(row.tokenReportedAttempts),
    retryAttempts: Number(row.retryAttempts),
    fallbackAttempts: Number(row.fallbackAttempts),
    inputTokens,
    cachedTokens: Number(row.cachedTokens),
    cacheWriteTokens: Number(row.cacheWriteTokens),
    outputTokens: Number(row.outputTokens),
    reasoningTokens: Number(row.reasoningTokens),
    totalTokens: Number(row.totalTokens),
    cachedTokenRatio: ratio(Number(row.cachedTokens), inputTokens),
    errorRate: ratio(attempts - Number(row.acceptedAttempts), attempts),
    retryOverhead: {
      attempts: Number(row.retryAttempts),
      totalTokens: Number(row.retryTokens),
      estimatedCostUsd: usd(row.retryCostUsd),
    },
    fallbackOverhead: {
      attempts: Number(row.fallbackAttempts),
      totalTokens: Number(row.fallbackTokens),
      estimatedCostUsd: usd(row.fallbackCostUsd),
    },
    latencyMs: {
      p50: roundedLatency(row.latencyP50),
      p95: roundedLatency(row.latencyP95),
    },
    estimatedCostUsd: usd(row.estimatedCostUsd),
    unpricedAttempts: Number(row.unpricedAttempts),
    pricingVersions: row.pricingVersions ?? [],
  };
}

function createSpikeWarnings(
  daily: Array<{ day: string; totalTokens: number }>,
) {
  const byDay = new Map(daily.map((item) => [item.day, item.totalTokens]));
  const today = new Date().toISOString().slice(0, 10);
  const warnings: Array<{
    code: 'DAILY_TOKEN_SPIKE';
    day: string;
    totalTokens: number;
    baselineAverageTokens: number;
    ratio: number;
  }> = [];

  for (const item of daily) {
    if (item.day >= today || item.totalTokens < TRAINING_AI_USAGE_SPIKE_MIN_TOKENS) continue;
    const baseline: number[] = [];
    const dayStart = Date.parse(`${item.day}T00:00:00.000Z`);

    for (let offset = 1; offset <= TRAINING_AI_USAGE_SPIKE_BASELINE_DAYS; offset += 1) {
      const previousDay = new Date(dayStart - offset * 86_400_000).toISOString().slice(0, 10);
      if (byDay.has(previousDay)) baseline.push(byDay.get(previousDay) as number);
    }
    if (baseline.length < TRAINING_AI_USAGE_SPIKE_MIN_BASELINE_DAYS) continue;
    const average = baseline.reduce((sum, value) => sum + value, 0) / baseline.length;
    if (average <= 0 || item.totalTokens / average < TRAINING_AI_USAGE_SPIKE_RATIO) continue;
    warnings.push({
      code: 'DAILY_TOKEN_SPIKE',
      day: item.day,
      totalTokens: item.totalTokens,
      baselineAverageTokens: Math.round(average),
      ratio: Number((item.totalTokens / average).toFixed(2)),
    });
  }

  return warnings.slice(-10);
}

function emptyAggregate(): AggregateRow {
  return {
    attempts: 0n,
    acceptedAttempts: 0n,
    tokenReportedAttempts: 0n,
    retryAttempts: 0n,
    fallbackAttempts: 0n,
    inputTokens: 0n,
    cachedTokens: 0n,
    cacheWriteTokens: 0n,
    outputTokens: 0n,
    reasoningTokens: 0n,
    totalTokens: 0n,
    retryTokens: 0n,
    fallbackTokens: 0n,
    estimatedCostUsd: '0',
    retryCostUsd: '0',
    fallbackCostUsd: '0',
    unpricedAttempts: 0n,
    latencyP50: null,
    latencyP95: null,
    pricingVersions: [],
  };
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function usd(value: string) {
  return Number(Number(value).toFixed(8));
}

function roundedLatency(value: number | null) {
  return value === null ? null : Math.round(value);
}

function bounded(value: string, maximumLength: number) {
  return value.trim().slice(0, maximumLength);
}

function boundedNullable(value: string | null, maximumLength: number) {
  if (value === null) return null;
  return bounded(value, maximumLength) || null;
}

function safePersistenceErrorCode(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code
    : 'UNEXPECTED_ERROR';
}
