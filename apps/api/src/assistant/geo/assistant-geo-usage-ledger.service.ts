import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  AssistantUsageBudgetError,
  AssistantUsageBudgetService,
  type AssistantUsageReservation,
} from '../operations/assistant-usage-budget.service';

type GeoLedgerEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;
type GeoProviderName = 'locationiq' | 'overpass';
type ResolutionContext = { operationId: string };

export type AssistantGeoUsageReservation = AssistantUsageReservation & {
  id: string;
  operationId: string;
  attemptOrdinal: number;
  provider: GeoProviderName;
};

export class AssistantGeoUsageLedgerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AssistantGeoUsageLedgerError';
  }
}

@Injectable()
export class AssistantGeoUsageLedgerService {
  private readonly context = new AsyncLocalStorage<ResolutionContext>();
  private readonly maxLocationIqAttempts: number;
  private readonly maxOverpassAttempts: number;
  private readonly locationIqMinuteLimit: number;
  private readonly locationIqDailyLimit: number;
  private readonly overpassMinuteLimit: number;
  private readonly overpassDailyLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly budgets: AssistantUsageBudgetService,
    environment: GeoLedgerEnvironment = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.maxLocationIqAttempts = readInteger(
      environment.ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE,
      2,
      1,
      2,
      'ASSISTANT_GEO_MAX_LOCATIONIQ_ATTEMPTS_PER_RESOLVE_INVALID',
    );
    this.maxOverpassAttempts = readInteger(
      environment.ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE,
      1,
      1,
      1,
      'ASSISTANT_GEO_MAX_OVERPASS_ATTEMPTS_PER_RESOLVE_INVALID',
    );
    this.locationIqMinuteLimit = readInteger(
      environment.ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE,
      60,
      1,
      1_000_000,
      'ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE_INVALID',
    );
    this.locationIqDailyLimit = readInteger(
      environment.ASSISTANT_GEO_PROVIDER_DAILY_BUDGET,
      10_000,
      1,
      1_000_000,
      'ASSISTANT_GEO_PROVIDER_DAILY_BUDGET_INVALID',
    );
    this.overpassMinuteLimit = readInteger(
      environment.ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE,
      60,
      1,
      1_000_000,
      'ASSISTANT_OVERPASS_REQUESTS_PER_MINUTE_INVALID',
    );
    this.overpassDailyLimit = readInteger(
      environment.ASSISTANT_OVERPASS_DAILY_BUDGET,
      10_000,
      1,
      1_000_000,
      'ASSISTANT_OVERPASS_DAILY_BUDGET_INVALID',
    );
  }

  runResolution<T>(operationId: string, task: () => Promise<T>): Promise<T> {
    if (!uuidPattern.test(operationId)) {
      throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_OPERATION_ID_INVALID');
    }
    return this.context.run({ operationId }, task);
  }

  async reserve(provider: GeoProviderName): Promise<AssistantGeoUsageReservation> {
    const operationId = this.context.getStore()?.operationId;
    if (!operationId) throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_RESOLUTION_CONTEXT_REQUIRED');
    const plan = this.providerPlan(provider);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const operations = await transaction.$queryRaw<Array<{ status: string }>>(Prisma.sql`
          SELECT "status"
          FROM "assistant_geo_operations"
          WHERE "id" = ${operationId}::uuid
          FOR UPDATE
        `);
        if (operations[0]?.status !== 'RUNNING') {
          throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_OPERATION_NOT_RUNNING');
        }

        const [counts] = await transaction.$queryRaw<Array<{
          totalCount: number;
          providerCount: number;
        }>>(Prisma.sql`
          SELECT
            COUNT(*)::int AS "totalCount",
            COUNT(*) FILTER (WHERE "provider" = ${provider})::int AS "providerCount"
          FROM "assistant_geo_usage_attempts"
          WHERE "operation_id" = ${operationId}::uuid
        `);
        const totalCount = counts?.totalCount ?? 0;
        const providerCount = counts?.providerCount ?? 0;
        if (providerCount >= plan.resolutionLimit) {
          throw new AssistantGeoUsageLedgerError(plan.resolutionErrorCode);
        }
        if (totalCount >= this.maxLocationIqAttempts + this.maxOverpassAttempts) {
          throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_TOTAL_RESOLUTION_BUDGET_EXHAUSTED');
        }

        const reservedAt = this.now();
        const aggregate = await this.budgets.reserveWithClient(transaction, {
          provider,
          model: provider,
          perMinuteLimit: plan.minuteLimit,
          dailyLimit: plan.dailyLimit,
          now: reservedAt,
          errorPrefix: plan.aggregateErrorPrefix,
        });
        const id = randomUUID();
        const attemptOrdinal = totalCount + 1;
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO "assistant_geo_usage_attempts" (
            "id", "operation_id", "attempt_ordinal", "provider", "status",
            "minute_started_at", "day_started_at"
          ) VALUES (
            ${id}::uuid, ${operationId}::uuid, ${attemptOrdinal}, ${provider}, 'RESERVED',
            ${aggregate.minuteStartedAt}, ${aggregate.dayStartedAt}::date
          )
        `);
        await transaction.$executeRaw(Prisma.sql`
          UPDATE "assistant_geo_operations"
          SET "provider" = ${provider},
              "provider_call_count" = ${attemptOrdinal}
          WHERE "id" = ${operationId}::uuid
        `);
        return {
          ...aggregate,
          id,
          operationId,
          attemptOrdinal,
          provider,
        };
      });
    } catch (error) {
      if (error instanceof AssistantGeoUsageLedgerError) throw error;
      if (error instanceof AssistantUsageBudgetError) {
        throw new AssistantGeoUsageLedgerError(error.code);
      }
      throw error;
    }
  }

  async settle(
    reservation: AssistantGeoUsageReservation,
    input: { outcome: 'SUCCESS' | 'ERROR'; errorCode: string | null; durationMs: number },
  ) {
    const durationMs = readDuration(input.durationMs);
    const errorCode = readErrorCode(input.errorCode);
    if ((input.outcome === 'SUCCESS' && errorCode !== null)
      || (input.outcome === 'ERROR' && errorCode === null)) {
      throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_USAGE_OUTCOME_INVALID');
    }
    return this.prisma.$transaction(async (transaction) => {
      const attempts = await transaction.$queryRaw<Array<{
        status: string;
        provider: string;
        operationId: string;
        attemptOrdinal: number;
        outcome: string | null;
        errorCode: string | null;
        durationMs: number | null;
      }>>(Prisma.sql`
        SELECT
          "status", "provider", "operation_id"::text AS "operationId",
          "attempt_ordinal" AS "attemptOrdinal", "outcome",
          "error_code" AS "errorCode", "duration_ms" AS "durationMs"
        FROM "assistant_geo_usage_attempts"
        WHERE "id" = ${reservation.id}::uuid
        FOR UPDATE
      `);
      const attempt = attempts[0];
      if (!attempt) throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_USAGE_ATTEMPT_MISSING');
      if (attempt.status === 'SETTLED') {
        if (attempt.outcome === input.outcome
          && attempt.errorCode === errorCode
          && attempt.durationMs === durationMs) return false;
        throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_USAGE_ATTEMPT_CONFLICT');
      }
      if (attempt.status !== 'RESERVED'
        || attempt.provider !== reservation.provider
        || attempt.operationId !== reservation.operationId
        || attempt.attemptOrdinal !== reservation.attemptOrdinal) {
        throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_USAGE_ATTEMPT_CONFLICT');
      }

      const aggregate = await this.budgets.completeWithClient(transaction, {
        reservation,
        outcome: input.outcome,
        durationMs,
      });
      if (aggregate.minuteUpdated !== 1 || aggregate.dayUpdated !== 1) {
        throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_USAGE_METRIC_MISSING');
      }
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE "assistant_geo_usage_attempts"
        SET
          "status" = 'SETTLED',
          "outcome" = ${input.outcome},
          "error_code" = ${errorCode},
          "duration_ms" = ${durationMs},
          "settled_at" = clock_timestamp()
        WHERE "id" = ${reservation.id}::uuid AND "status" = 'RESERVED'
      `);
      if (updated !== 1) {
        throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_USAGE_SETTLEMENT_FAILED');
      }
      return true;
    });
  }

  private providerPlan(provider: GeoProviderName) {
    return provider === 'locationiq'
      ? {
          resolutionLimit: this.maxLocationIqAttempts,
          minuteLimit: this.locationIqMinuteLimit,
          dailyLimit: this.locationIqDailyLimit,
          resolutionErrorCode: 'ASSISTANT_GEO_LOCATIONIQ_RESOLUTION_BUDGET_EXHAUSTED',
          aggregateErrorPrefix: 'ASSISTANT_GEO_PROVIDER',
        }
      : {
          resolutionLimit: this.maxOverpassAttempts,
          minuteLimit: this.overpassMinuteLimit,
          dailyLimit: this.overpassDailyLimit,
          resolutionErrorCode: 'ASSISTANT_GEO_OVERPASS_RESOLUTION_BUDGET_EXHAUSTED',
          aggregateErrorPrefix: 'ASSISTANT_OVERPASS',
        };
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, code: string) {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AssistantGeoUsageLedgerError(code);
  }
  return parsed;
}

function readDuration(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 120_000) {
    throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_USAGE_DURATION_INVALID');
  }
  return value;
}

function readErrorCode(value: string | null) {
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 120 || !/^[A-Z0-9_]+$/u.test(normalized)) {
    throw new AssistantGeoUsageLedgerError('ASSISTANT_GEO_USAGE_ERROR_CODE_INVALID');
  }
  return normalized;
}
