import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  ASSISTANT_AI_PRICING_CATALOG_VERSION,
  calculateAssistantAiCost,
  formatAssistantUsd,
  parseAssistantUsd,
} from './assistant-ai-cost';

export type AssistantAiUsageReservation = {
  id: string;
  provider: string;
  model: string;
  usageDate: Date;
  reservedCostUsd: string;
};

export class AssistantAiUsageBudgetError extends Error {
  readonly provider = 'openai' as const;

  constructor(readonly code: string) {
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
    attemptOrdinal: number;
    dailyBudgetUsd: string;
    reservedCostUsd: string;
    reasoningEffort?: string | null;
    promptVersion?: string | null;
    validatorVersion?: string | null;
    isFallback?: boolean;
    now?: Date;
  }): Promise<AssistantAiUsageReservation> {
    const id = randomUUID();
    const usageDate = truncateUtcDay(input.now ?? new Date());
    const dailyBudgetUsd = formatAssistantUsd(parseAssistantUsd(input.dailyBudgetUsd));
    const reservedCostUsd = formatAssistantUsd(parseAssistantUsd(input.reservedCostUsd));
    if (parseAssistantUsd(dailyBudgetUsd) === 0n || parseAssistantUsd(reservedCostUsd) === 0n) {
      throw new AssistantAiUsageBudgetError('ASSISTANT_AI_BUDGET_VALUE_INVALID');
    }

    await this.prisma.$transaction(async (transaction) => {
      const inserted = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "assistant_ai_usage_attempts" (
          "id", "operation_run_id", "attempt_ordinal", "operation", "provider",
          "requested_model", "reasoning_effort", "prompt_version", "validator_version",
          "is_fallback", "status", "pricing_catalog_version", "pricing_status",
          "reserved_cost_usd", "usage_date"
        ) VALUES (
          CAST(${id} AS uuid), ${bounded(input.operationRunId, 160)}, ${input.attemptOrdinal},
          ${input.operation}, ${bounded(input.provider, 40)}, ${bounded(input.model, 160)},
          ${boundedNullable(input.reasoningEffort, 20)}, ${boundedNullable(input.promptVersion, 120)},
          ${boundedNullable(input.validatorVersion, 120)}, ${input.isFallback ?? false},
          'RESERVED', ${ASSISTANT_AI_PRICING_CATALOG_VERSION}, 'RESERVED',
          CAST(${reservedCostUsd} AS numeric), ${usageDate}
        )
        ON CONFLICT ("operation_run_id", "attempt_ordinal") DO NOTHING
        RETURNING "id"
      `);
      if (inserted.length !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_ATTEMPT_DUPLICATE');
      }

      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "assistant_ai_daily_budgets" (
          "provider", "usage_date", "budget_limit_usd", "updated_at"
        ) VALUES (
          ${bounded(input.provider, 40)}, ${usageDate}, CAST(${dailyBudgetUsd} AS numeric), NOW()
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
        WHERE "provider" = ${bounded(input.provider, 40)}
          AND "usage_date" = ${usageDate}
          AND "settled_cost_usd" + "reserved_cost_usd" + CAST(${reservedCostUsd} AS numeric)
            <= "budget_limit_usd"
        RETURNING "reserved_cost_usd" AS "reservedCostUsd"
      `);
      if (reserved.length !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_DAILY_BUDGET_EXHAUSTED');
      }
    });

    return {
      id,
      provider: bounded(input.provider, 40),
      model: bounded(input.model, 160),
      usageDate,
      reservedCostUsd,
    };
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
    const actualModel = boundedNullable(input.actualModel, 160) ?? input.reservation.model;
    const cost = calculateAssistantAiCost({
      model: actualModel,
      inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens,
      cacheWriteInputTokens: input.cacheWriteInputTokens,
      outputTokens: input.outputTokens,
      webSearchCalls: input.webSearchCalls,
    });

    return this.prisma.$transaction(async (transaction) => {
      const attempts = await transaction.$queryRaw<Array<{
        provider: string;
        usageDate: Date;
        status: string;
        reservedCostUsd: Prisma.Decimal;
      }>>(Prisma.sql`
        SELECT
          "provider", "usage_date" AS "usageDate", "status",
          "reserved_cost_usd" AS "reservedCostUsd"
        FROM "assistant_ai_usage_attempts"
        WHERE "id" = CAST(${input.reservation.id} AS uuid)
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
      const reservedCostUsd = attempt.reservedCostUsd.toFixed(8);
      const chargedCostUsd = cost.estimatedUsd ?? reservedCostUsd;
      const reserveExceeded = cost.estimatedUsdUnits !== null
        && cost.estimatedUsdUnits > parseAssistantUsd(reservedCostUsd);
      const budgetUpdated = await transaction.$executeRaw(Prisma.sql`
        UPDATE "assistant_ai_daily_budgets"
        SET
          "reserved_cost_usd" = GREATEST(
            0,
            "reserved_cost_usd" - CAST(${reservedCostUsd} AS numeric)
          ),
          "settled_cost_usd" = "settled_cost_usd" + CAST(${chargedCostUsd} AS numeric),
          "updated_at" = NOW()
        WHERE "provider" = ${attempt.provider} AND "usage_date" = ${attempt.usageDate}
      `);
      if (budgetUpdated !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_DAILY_BUDGET_UPDATE_FAILED');
      }
      const attemptUpdated = await transaction.$executeRaw(Prisma.sql`
        UPDATE "assistant_ai_usage_attempts"
        SET
          "actual_model" = ${actualModel},
          "status" = 'SETTLED',
          "outcome" = ${bounded(input.outcome, 40)},
          "error_code" = ${boundedNullable(input.errorCode, 120)},
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
          "duration_ms" = ${Math.max(0, Math.trunc(input.durationMs))},
          "settled_at" = NOW()
        WHERE "id" = CAST(${input.reservation.id} AS uuid) AND "status" = 'RESERVED'
      `);
      if (attemptUpdated !== 1) {
        throw new AssistantAiUsageBudgetError('ASSISTANT_AI_ATTEMPT_SETTLEMENT_FAILED');
      }
      return true;
    });
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
