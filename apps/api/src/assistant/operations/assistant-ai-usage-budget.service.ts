import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  ASSISTANT_AI_PRICING_CATALOG_VERSION,
  ASSISTANT_AI_SERVICE_TIER,
  calculateAssistantAiCost,
  formatAssistantUsd,
  parseAssistantUsd,
} from './assistant-ai-cost';

export type AssistantAiUsageReservation = {
  id: string;
  operationRunId: string;
  executionId: string;
  attemptOrdinal: number;
  provider: string;
  model: string;
  serviceTier: string;
  usageDate: Date;
  reservationExpiresAt: Date;
  reservedCostUsd: string;
};

type AssistantAiUsageAttemptRow = {
  id: string;
  operationRunId: string;
  executionId: string;
  attemptOrdinal: number;
  operation: string;
  provider: string;
  requestedModel: string;
  serviceTier: string;
  reasoningEffort: string | null;
  promptVersion: string | null;
  validatorVersion: string | null;
  isFallback: boolean;
  status: string;
  pricingCatalogVersion: string;
  dailyBudgetUsd: Prisma.Decimal | null;
  reservedCostUsd: Prisma.Decimal;
  usageDate: Date;
  reservationExpiresAt: Date;
};

type AssistantAiExecutionFenceRow = {
  executionId: string;
};

const maximumProviderTimeoutMs = 120_000;
const assistantAiSettlementGraceMs = 60_000;
const assistantAiReservationSafetyMs = 5_000;
const assistantAiSettlementAttempts = 3;

export class AssistantAiUsageBudgetError extends Error {
  readonly provider = 'openai' as const;

  constructor(
    readonly code: string,
    readonly retryAt: Date | null = null,
  ) {
    super(code);
    this.name = 'AssistantAiUsageBudgetError';
  }
}

@Injectable()
export class AssistantAiUsageBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(input: {
    provider: string;
    model: string;
    operation: 'PLANNER' | 'SOURCE_DISCOVERY';
    operationRunId: string;
    executionId: string;
    attemptOrdinal: number;
    dailyBudgetUsd: string;
    reservedCostUsd: string;
    serviceTier?: string;
    reasoningEffort?: string | null;
    promptVersion?: string | null;
    validatorVersion?: string | null;
    isFallback?: boolean;
    reservationExpiresAt?: Date;
    now?: Date;
  }): Promise<AssistantAiUsageReservation> {
    const now = validDate(input.now ?? new Date());
    const usageDate = truncateUtcDay(now);
    const operationRunId = bounded(input.operationRunId, 160);
    const executionId = uuid(input.executionId);
    const attemptOrdinal = positiveSmallInt(input.attemptOrdinal);
    const provider = bounded(input.provider, 40);
    const model = bounded(input.model, 160);
    const serviceTier = bounded(input.serviceTier ?? ASSISTANT_AI_SERVICE_TIER, 24);
    const reasoningEffort = boundedNullable(input.reasoningEffort, 20);
    const promptVersion = boundedNullable(input.promptVersion, 120);
    const validatorVersion = boundedNullable(input.validatorVersion, 120);
    const isFallback = input.isFallback ?? false;
    const dailyBudgetUsd = formatAssistantUsd(parseAssistantUsd(input.dailyBudgetUsd));
    const reservedCostUsd = formatAssistantUsd(parseAssistantUsd(input.reservedCostUsd));
    const reservationExpiresAt = validDate(input.reservationExpiresAt
      ?? createAssistantAiReservationExpiresAt(maximumProviderTimeoutMs, now));
    if (parseAssistantUsd(dailyBudgetUsd) === 0n || parseAssistantUsd(reservedCostUsd) === 0n) {
      throw new AssistantAiUsageBudgetError('ASSISTANT_AI_BUDGET_VALUE_INVALID');
    }
    const priceability = calculateAssistantAiCost({
      model,
      serviceTier,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      webSearchCalls: 0,
    });
    if (priceability.status === 'MODEL_UNPRICED') {
      throw new AssistantAiUsageBudgetError('ASSISTANT_AI_MODEL_UNPRICED');
    }
    if (priceability.status === 'SERVICE_TIER_UNPRICED') {
      throw new AssistantAiUsageBudgetError('ASSISTANT_AI_SERVICE_TIER_UNPRICED');
    }
    if (priceability.status !== 'PRICED') {
      throw new AssistantAiUsageBudgetError('ASSISTANT_AI_COST_UNPRICED');
    }

    return this.prisma.$transaction(async (transaction) => {
      const fence = await lockOrCreateExecutionFence(
        transaction,
        operationRunId,
        executionId,
      );
      if (fence.executionId !== executionId) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_EXECUTION_STALE');
      }
      const id = randomUUID();
      const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "assistant_ai_usage_attempts" (
          "id", "operation_run_id", "execution_id", "attempt_ordinal", "operation", "provider",
          "requested_model", "service_tier", "reasoning_effort", "prompt_version", "validator_version",
          "is_fallback", "status", "pricing_catalog_version", "pricing_status",
          "daily_budget_usd", "reserved_cost_usd", "usage_date", "reservation_expires_at"
        ) VALUES (
          CAST(${id} AS uuid), ${operationRunId}, CAST(${executionId} AS uuid), ${attemptOrdinal},
          ${input.operation}, ${provider}, ${model}, ${serviceTier},
          ${reasoningEffort}, ${promptVersion}, ${validatorVersion}, ${isFallback},
          'RESERVED', ${ASSISTANT_AI_PRICING_CATALOG_VERSION}, 'RESERVED',
          CAST(${dailyBudgetUsd} AS numeric), CAST(${reservedCostUsd} AS numeric),
          ${usageDate}, ${reservationExpiresAt}
        )
        ON CONFLICT ("operation_run_id", "execution_id", "attempt_ordinal") DO NOTHING
        RETURNING "id"
      `);
      if (inserted.length === 0) {
        const existingRows = await transaction.$queryRaw<AssistantAiUsageAttemptRow[]>(Prisma.sql`
          SELECT
            "id",
            "operation_run_id" AS "operationRunId",
            "execution_id" AS "executionId",
            "attempt_ordinal" AS "attemptOrdinal",
            "operation",
            "provider",
            "requested_model" AS "requestedModel",
            "service_tier" AS "serviceTier",
            "reasoning_effort" AS "reasoningEffort",
            "prompt_version" AS "promptVersion",
            "validator_version" AS "validatorVersion",
            "is_fallback" AS "isFallback",
            "status",
            "pricing_catalog_version" AS "pricingCatalogVersion",
            "daily_budget_usd" AS "dailyBudgetUsd",
            "reserved_cost_usd" AS "reservedCostUsd",
            "usage_date" AS "usageDate",
            "reservation_expires_at" AS "reservationExpiresAt"
          FROM "assistant_ai_usage_attempts"
          WHERE "operation_run_id" = ${operationRunId}
            AND "execution_id" = CAST(${executionId} AS uuid)
            AND "attempt_ordinal" = ${attemptOrdinal}
          FOR UPDATE
        `);
        const existing = existingRows[0];
        if (!existing || !sameReservationParameters(existing, {
          operationRunId,
          executionId,
          attemptOrdinal,
          operation: input.operation,
          provider,
          model,
          serviceTier,
          reasoningEffort,
          promptVersion,
          validatorVersion,
          isFallback,
          dailyBudgetUsd,
          reservedCostUsd,
        })) {
          throw new AssistantAiUsageBudgetError('ASSISTANT_AI_ATTEMPT_CONFLICT');
        }
        return toReservation(existing);
      }

      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "assistant_ai_daily_budgets" (
          "provider", "usage_date", "budget_limit_usd", "updated_at"
        ) VALUES (
          ${provider}, ${usageDate}, CAST(${dailyBudgetUsd} AS numeric), NOW()
        )
        ON CONFLICT ("provider", "usage_date") DO UPDATE SET
          "budget_limit_usd" = LEAST(
            "assistant_ai_daily_budgets"."budget_limit_usd",
            EXCLUDED."budget_limit_usd"
          ),
          "updated_at" = NOW()
      `);

      const reserved = await transaction.$queryRaw<Array<{ reservedCostUsd: Prisma.Decimal }>>(Prisma.sql`
        UPDATE "assistant_ai_daily_budgets"
        SET
          "reserved_cost_usd" = "reserved_cost_usd" + CAST(${reservedCostUsd} AS numeric),
          "updated_at" = NOW()
        WHERE "provider" = ${provider}
          AND "usage_date" = ${usageDate}
          AND "settled_cost_usd" + "reserved_cost_usd" + CAST(${reservedCostUsd} AS numeric)
            <= "budget_limit_usd"
        RETURNING "reserved_cost_usd" AS "reservedCostUsd"
      `);
      if (reserved.length !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_DAILY_BUDGET_EXHAUSTED');
      }
      return {
        id,
        operationRunId,
        executionId,
        attemptOrdinal,
        provider,
        model,
        serviceTier,
        usageDate,
        reservationExpiresAt,
        reservedCostUsd,
      };
    });
  }

  async settle(input: {
    reservation: AssistantAiUsageReservation;
    actualModel?: string | null;
    outcome: string;
    errorCode?: string | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    webSearchCalls: number | null;
    durationMs: number;
  }) {
    const reservationId = uuid(input.reservation.id);
    const requestedActualModel = boundedNullable(input.actualModel, 160);
    const outcome = bounded(input.outcome, 40);
    const errorCode = boundedNullable(input.errorCode, 120);
    const durationMs = nonNegativeInteger(input.durationMs);

    return this.withSettlementRetry(() => this.prisma.$transaction(async (transaction) => {
      const attempts = await transaction.$queryRaw<Array<{
        provider: string;
        usageDate: Date;
        status: string;
        requestedModel: string;
        serviceTier: string;
        reservedCostUsd: Prisma.Decimal;
      }>>(Prisma.sql`
        SELECT
          "provider",
          "usage_date" AS "usageDate",
          "status",
          "requested_model" AS "requestedModel",
          "service_tier" AS "serviceTier",
          "reserved_cost_usd" AS "reservedCostUsd"
        FROM "assistant_ai_usage_attempts"
        WHERE "id" = CAST(${reservationId} AS uuid)
        FOR UPDATE
      `);
      const attempt = attempts[0];
      if (!attempt) throw new AssistantAiUsageBudgetError('ASSISTANT_AI_ATTEMPT_MISSING');
      if (attempt.status === 'SETTLED') return false;

      const budgetRows = await transaction.$queryRaw<Array<{ provider: string }>>(Prisma.sql`
        SELECT "provider"
        FROM "assistant_ai_daily_budgets"
        WHERE "provider" = ${attempt.provider} AND "usage_date" = ${attempt.usageDate}
        FOR UPDATE
      `);
      if (budgetRows.length !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_DAILY_BUDGET_MISSING');
      }

      const actualModel = requestedActualModel ?? attempt.requestedModel;
      const cost = calculateAssistantAiCost({
        model: actualModel,
        serviceTier: attempt.serviceTier,
        inputTokens: input.inputTokens,
        cachedInputTokens: input.cachedInputTokens,
        cacheWriteInputTokens: input.cacheWriteInputTokens,
        outputTokens: input.outputTokens,
        webSearchCalls: input.webSearchCalls,
      });
      const reservedCostUsd = attempt.reservedCostUsd.toFixed(8);
      const chargedCostUsd = cost.estimatedUsd ?? reservedCostUsd;
      const reserveExceeded = cost.estimatedUsdUnits !== null
        && cost.estimatedUsdUnits > parseAssistantUsd(reservedCostUsd);
      const budgetUpdated = await transaction.$executeRaw(Prisma.sql`
        UPDATE "assistant_ai_daily_budgets"
        SET
          "reserved_cost_usd" = "reserved_cost_usd" - CAST(${reservedCostUsd} AS numeric),
          "settled_cost_usd" = "settled_cost_usd" + CAST(${chargedCostUsd} AS numeric),
          "updated_at" = NOW()
        WHERE "provider" = ${attempt.provider}
          AND "usage_date" = ${attempt.usageDate}
          AND "reserved_cost_usd" >= CAST(${reservedCostUsd} AS numeric)
      `);
      if (budgetUpdated !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_DAILY_BUDGET_UPDATE_FAILED');
      }
      const attemptUpdated = await transaction.$executeRaw(Prisma.sql`
        UPDATE "assistant_ai_usage_attempts"
        SET
          "actual_model" = ${actualModel},
          "status" = 'SETTLED',
          "outcome" = ${outcome},
          "error_code" = ${errorCode},
          "input_tokens" = ${nullableCount(input.inputTokens)},
          "cached_input_tokens" = ${nullableCount(input.cachedInputTokens)},
          "cache_write_input_tokens" = ${nullableCount(input.cacheWriteInputTokens)},
          "output_tokens" = ${nullableCount(input.outputTokens)},
          "reasoning_tokens" = ${nullableCount(input.reasoningTokens)},
          "total_tokens" = ${nullableCount(input.totalTokens)},
          "web_search_calls" = ${nullableCount(input.webSearchCalls)},
          "pricing_status" = ${reserveExceeded ? 'RESERVE_EXCEEDED' : cost.status},
          "estimated_cost_usd" = ${cost.estimatedUsd === null
            ? Prisma.sql`NULL`
            : Prisma.sql`CAST(${cost.estimatedUsd} AS numeric)`},
          "charged_cost_usd" = CAST(${chargedCostUsd} AS numeric),
          "duration_ms" = ${durationMs},
          "settled_at" = NOW()
        WHERE "id" = CAST(${reservationId} AS uuid) AND "status" = 'RESERVED'
      `);
      if (attemptUpdated !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_ATTEMPT_SETTLEMENT_FAILED');
      }
      return true;
    }));
  }

  async reconcileExpiredReservations(input: {
    operationRunId: string;
    executionId: string;
    now?: Date;
  }) {
    const operationRunId = bounded(input.operationRunId, 160);
    const executionId = uuid(input.executionId);
    const now = validDate(input.now ?? new Date());
    const result = await this.prisma.$transaction(async (transaction) => {
      const fence = await lockOrCreateExecutionFence(
        transaction,
        operationRunId,
        executionId,
      );
      const attempts = await transaction.$queryRaw<Array<{
        id: string;
        executionId: string;
        provider: string;
        usageDate: Date;
        reservedCostUsd: Prisma.Decimal;
        reservationExpiresAt: Date;
      }>>(Prisma.sql`
        SELECT
          "id",
          "execution_id" AS "executionId",
          "provider",
          "usage_date" AS "usageDate",
          "reserved_cost_usd" AS "reservedCostUsd",
          "reservation_expires_at" AS "reservationExpiresAt"
        FROM "assistant_ai_usage_attempts"
        WHERE "operation_run_id" = ${operationRunId}
          AND "status" = 'RESERVED'
        ORDER BY "provider", "usage_date", "id"
        FOR UPDATE
      `);
      const expiredAttempts = attempts.filter(({ reservationExpiresAt }) => (
        reservationExpiresAt.getTime() <= now.getTime()
      ));
      const activeUntil = attempts.reduce<Date | null>((latest, attempt) => {
        if (attempt.reservationExpiresAt.getTime() <= now.getTime()) return latest;
        return latest === null || attempt.reservationExpiresAt.getTime() > latest.getTime()
          ? attempt.reservationExpiresAt
          : latest;
      }, null);
      const activeExecutionIds = new Set(attempts
        .filter(({ reservationExpiresAt }) => reservationExpiresAt.getTime() > now.getTime())
        .map(({ executionId: activeExecutionId }) => activeExecutionId));
      if (activeUntil !== null && activeExecutionIds.size !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_EXECUTION_STATE_INVALID');
      }

      const budgetGroups = groupReservationCosts(expiredAttempts);
      for (const group of budgetGroups) {
        const lockedBudget = await transaction.$queryRaw<Array<{ provider: string }>>(Prisma.sql`
          SELECT "provider"
          FROM "assistant_ai_daily_budgets"
          WHERE "provider" = ${group.provider} AND "usage_date" = ${group.usageDate}
          FOR UPDATE
        `);
        if (lockedBudget.length !== 1) {
          throw new AssistantAiUsageBudgetError('ASSISTANT_AI_DAILY_BUDGET_MISSING');
        }
      }

      for (const group of budgetGroups) {
        const budgetUpdated = await transaction.$executeRaw(Prisma.sql`
          UPDATE "assistant_ai_daily_budgets"
          SET
            "reserved_cost_usd" = "reserved_cost_usd" - CAST(${group.reservedCostUsd} AS numeric),
            "settled_cost_usd" = "settled_cost_usd" + CAST(${group.reservedCostUsd} AS numeric),
            "updated_at" = ${now}
          WHERE "provider" = ${group.provider}
            AND "usage_date" = ${group.usageDate}
            AND "reserved_cost_usd" >= CAST(${group.reservedCostUsd} AS numeric)
        `);
        if (budgetUpdated !== 1) {
          throw new AssistantAiUsageBudgetError('ASSISTANT_AI_DAILY_BUDGET_RECONCILIATION_FAILED');
        }
      }

      for (const attempt of expiredAttempts) {
        const reservedCostUsd = attempt.reservedCostUsd.toFixed(8);
        const attemptUpdated = await transaction.$executeRaw(Prisma.sql`
          UPDATE "assistant_ai_usage_attempts"
          SET
            "status" = 'SETTLED',
            "outcome" = 'UNKNOWN_AFTER_CRASH',
            "error_code" = 'ASSISTANT_AI_RESERVATION_EXPIRED_AFTER_CRASH',
            "pricing_status" = 'USAGE_INCOMPLETE',
            "estimated_cost_usd" = NULL,
            "charged_cost_usd" = CAST(${reservedCostUsd} AS numeric),
            "settled_at" = ${now}
          WHERE "id" = CAST(${attempt.id} AS uuid)
            AND "status" = 'RESERVED'
            AND "reservation_expires_at" <= ${now}
        `);
        if (attemptUpdated !== 1) {
          throw new AssistantAiUsageBudgetError('ASSISTANT_AI_ATTEMPT_RECONCILIATION_FAILED');
        }
      }

      const fencedExecutionId = activeUntil
        ? [...activeExecutionIds][0]!
        : executionId;
      const fenceUpdated = await transaction.$executeRaw(Prisma.sql`
        UPDATE "assistant_ai_execution_fences"
        SET "execution_id" = CAST(${fencedExecutionId} AS uuid), "updated_at" = ${now}
        WHERE "operation_run_id" = ${operationRunId}
          AND "execution_id" = CAST(${fence.executionId} AS uuid)
      `);
      if (fenceUpdated !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_EXECUTION_FENCE_UPDATE_FAILED');
      }
      return { reconciledCount: expiredAttempts.length, activeUntil };
    });

    if (result.activeUntil) {
      throw new AssistantAiUsageBudgetError(
        'ASSISTANT_AI_RESERVATION_ACTIVE',
        result.activeUntil,
      );
    }
    return result.reconciledCount;
  }

  private async withSettlementRetry<Value>(operation: () => Promise<Value>) {
    for (let attempt = 1; attempt <= assistantAiSettlementAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof AssistantAiUsageBudgetError) throw error;
        if (attempt === assistantAiSettlementAttempts) {
          throw new AssistantAiUsageBudgetError('ASSISTANT_AI_USAGE_SETTLEMENT_FAILED');
        }
        await delay(attempt * 25);
      }
    }
    throw new AssistantAiUsageBudgetError('ASSISTANT_AI_USAGE_SETTLEMENT_FAILED');
  }
}

export function readAssistantDailyUsdBudget(value: string | undefined, required: boolean) {
  if (value === undefined || value.trim() === '') {
    if (required) throw new Error('ASSISTANT_MODEL_DAILY_BUDGET_USD_REQUIRED');
    return '1000000.00000000';
  }
  const normalized = formatAssistantUsd(parseAssistantUsd(value.trim()));
  if (parseAssistantUsd(normalized) === 0n) {
    throw new Error('ASSISTANT_MODEL_DAILY_BUDGET_USD_INVALID');
  }
  return normalized;
}

export function createAssistantAiReservationExpiresAt(
  providerTimeoutMs: number,
  now = new Date(),
) {
  if (!Number.isSafeInteger(providerTimeoutMs)
    || providerTimeoutMs < 0
    || providerTimeoutMs > maximumProviderTimeoutMs) {
    throw new AssistantAiUsageBudgetError('ASSISTANT_AI_PROVIDER_TIMEOUT_INVALID');
  }
  return new Date(validDate(now).getTime()
    + providerTimeoutMs
    + assistantAiSettlementGraceMs
    + assistantAiReservationSafetyMs);
}

function sameReservationParameters(
  existing: AssistantAiUsageAttemptRow,
  expected: {
    operationRunId: string;
    executionId: string;
    attemptOrdinal: number;
    operation: string;
    provider: string;
    model: string;
    serviceTier: string;
    reasoningEffort: string | null;
    promptVersion: string | null;
    validatorVersion: string | null;
    isFallback: boolean;
    dailyBudgetUsd: string;
    reservedCostUsd: string;
  },
) {
  return existing.operationRunId === expected.operationRunId
    && existing.executionId === expected.executionId
    && existing.attemptOrdinal === expected.attemptOrdinal
    && existing.operation === expected.operation
    && existing.provider === expected.provider
    && existing.requestedModel === expected.model
    && existing.serviceTier === expected.serviceTier
    && existing.reasoningEffort === expected.reasoningEffort
    && existing.promptVersion === expected.promptVersion
    && existing.validatorVersion === expected.validatorVersion
    && existing.isFallback === expected.isFallback
    && existing.pricingCatalogVersion === ASSISTANT_AI_PRICING_CATALOG_VERSION
    && existing.dailyBudgetUsd?.toFixed(8) === expected.dailyBudgetUsd
    && existing.reservedCostUsd.toFixed(8) === expected.reservedCostUsd;
}

function toReservation(attempt: AssistantAiUsageAttemptRow): AssistantAiUsageReservation {
  return {
    id: attempt.id,
    operationRunId: attempt.operationRunId,
    executionId: attempt.executionId,
    attemptOrdinal: attempt.attemptOrdinal,
    provider: attempt.provider,
    model: attempt.requestedModel,
    serviceTier: attempt.serviceTier,
    usageDate: attempt.usageDate,
    reservationExpiresAt: attempt.reservationExpiresAt,
    reservedCostUsd: attempt.reservedCostUsd.toFixed(8),
  };
}

function groupReservationCosts(attempts: Array<{
  provider: string;
  usageDate: Date;
  reservedCostUsd: Prisma.Decimal;
}>) {
  const groups = new Map<string, {
    provider: string;
    usageDate: Date;
    reservedCostUnits: bigint;
  }>();
  for (const attempt of attempts) {
    const key = `${attempt.provider}\u0000${attempt.usageDate.toISOString()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.reservedCostUnits += parseAssistantUsd(attempt.reservedCostUsd.toFixed(8));
      continue;
    }
    groups.set(key, {
      provider: attempt.provider,
      usageDate: attempt.usageDate,
      reservedCostUnits: parseAssistantUsd(attempt.reservedCostUsd.toFixed(8)),
    });
  }
  return [...groups.values()].map((group) => ({
    provider: group.provider,
    usageDate: group.usageDate,
    reservedCostUsd: formatAssistantUsd(group.reservedCostUnits),
  }));
}

async function lockOrCreateExecutionFence(
  transaction: Prisma.TransactionClient,
  operationRunId: string,
  executionId: string,
) {
  const inserted = await transaction.$queryRaw<AssistantAiExecutionFenceRow[]>(Prisma.sql`
    INSERT INTO "assistant_ai_execution_fences" (
      "operation_run_id", "execution_id", "updated_at"
    ) VALUES (
      ${operationRunId}, CAST(${executionId} AS uuid), NOW()
    )
    ON CONFLICT ("operation_run_id") DO NOTHING
    RETURNING "execution_id" AS "executionId"
  `);
  const created = inserted[0];
  if (created) return created;

  const existing = await transaction.$queryRaw<AssistantAiExecutionFenceRow[]>(Prisma.sql`
    SELECT "execution_id" AS "executionId"
    FROM "assistant_ai_execution_fences"
    WHERE "operation_run_id" = ${operationRunId}
    FOR UPDATE
  `);
  const fence = existing[0];
  if (!fence || existing.length !== 1) {
    throw new AssistantAiUsageBudgetError('ASSISTANT_AI_EXECUTION_FENCE_MISSING');
  }
  return fence;
}

function bounded(value: string, maximumLength: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new AssistantAiUsageBudgetError('ASSISTANT_AI_TELEMETRY_INVALID');
  }
  return normalized;
}

function boundedNullable(value: string | null | undefined, maximumLength: number) {
  return value === null || value === undefined || value.trim() === ''
    ? null
    : bounded(value, maximumLength);
}

function uuid(value: string) {
  const normalized = bounded(value, 36).toLocaleLowerCase('en-US');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new AssistantAiUsageBudgetError('ASSISTANT_AI_TELEMETRY_INVALID');
  }
  return normalized;
}

function positiveSmallInt(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32_767) {
    throw new AssistantAiUsageBudgetError('ASSISTANT_AI_TELEMETRY_INVALID');
  }
  return value;
}

function nonNegativeInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AssistantAiUsageBudgetError('ASSISTANT_AI_TELEMETRY_INVALID');
  }
  return value;
}

function validDate(value: Date) {
  const normalized = new Date(value);
  if (!Number.isFinite(normalized.getTime())) {
    throw new AssistantAiUsageBudgetError('ASSISTANT_AI_TELEMETRY_INVALID');
  }
  return normalized;
}

function delay(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

function nullableCount(value: number | null) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : null;
}

function truncateUtcDay(value: Date) {
  const result = new Date(value);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}
