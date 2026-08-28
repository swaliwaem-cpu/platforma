import { Injectable } from '@nestjs/common';
import { AssistantUsageWindow, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

type AssistantUsageWriteClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export type AssistantUsageReservation = {
  provider: string;
  model: string;
  minuteStartedAt: Date;
  dayStartedAt: Date;
};

export class AssistantUsageBudgetError extends Error {
  constructor(
    readonly code: string,
    readonly provider: string,
  ) {
    super(code);
    this.name = 'AssistantUsageBudgetError';
  }
}

@Injectable()
export class AssistantUsageBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(input: {
    provider: string;
    model: string;
    perMinuteLimit: number;
    dailyLimit: number;
    now?: Date;
    errorPrefix: string;
  }): Promise<AssistantUsageReservation> {
    return this.prisma.$transaction((transaction) => this.reserveWithClient(transaction, input));
  }

  async reserveWithClient(
    transaction: AssistantUsageWriteClient,
    input: {
      provider: string;
      model: string;
      perMinuteLimit: number;
      dailyLimit: number;
      now?: Date;
      errorPrefix: string;
    },
  ): Promise<AssistantUsageReservation> {
    const now = input.now ?? new Date();
    const minuteStartedAt = truncateUtcMinute(now);
    const dayStartedAt = truncateUtcDay(now);
    const minuteReserved = await reserveBucket(
      transaction,
      input.provider,
      input.model,
      AssistantUsageWindow.MINUTE,
      minuteStartedAt,
      input.perMinuteLimit,
    );
    if (!minuteReserved) {
      throw new AssistantUsageBudgetError(`${input.errorPrefix}_MINUTE_BUDGET_EXHAUSTED`, input.provider);
    }
    const dayReserved = await reserveBucket(
      transaction,
      input.provider,
      input.model,
      AssistantUsageWindow.DAY,
      dayStartedAt,
      input.dailyLimit,
    );
    if (!dayReserved) {
      throw new AssistantUsageBudgetError(`${input.errorPrefix}_DAILY_BUDGET_EXHAUSTED`, input.provider);
    }
    return { provider: input.provider, model: input.model, minuteStartedAt, dayStartedAt };
  }

  async complete(input: {
    reservation: AssistantUsageReservation;
    outcome: 'ACCEPTED' | 'LOCAL_VALIDATION_FAILED' | 'PROVIDER_ERROR' | 'SUCCESS' | 'ERROR';
    inputTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    totalTokens?: number | null;
    durationMs: number;
  }) {
    return this.prisma.$transaction((transaction) => this.completeWithClient(transaction, input));
  }

  async completeWithClient(
    transaction: AssistantUsageWriteClient,
    input: {
      reservation: AssistantUsageReservation;
      outcome: 'ACCEPTED' | 'LOCAL_VALIDATION_FAILED' | 'PROVIDER_ERROR' | 'SUCCESS' | 'ERROR';
      inputTokens?: number | null;
      outputTokens?: number | null;
      reasoningTokens?: number | null;
      totalTokens?: number | null;
      durationMs: number;
    },
  ) {
    const completed = input.outcome === 'ACCEPTED' || input.outcome === 'SUCCESS';
    const minuteUpdated = await updateBucket(
      transaction,
      input.reservation,
      AssistantUsageWindow.MINUTE,
      input.reservation.minuteStartedAt,
      input,
      completed,
    );
    const dayUpdated = await updateBucket(
      transaction,
      input.reservation,
      AssistantUsageWindow.DAY,
      input.reservation.dayStartedAt,
      input,
      completed,
    );
    return { minuteUpdated, dayUpdated };
  }
}

async function reserveBucket(
  transaction: AssistantUsageWriteClient,
  provider: string,
  model: string,
  window: AssistantUsageWindow,
  windowStartedAt: Date,
  limit: number,
) {
  const rows = await transaction.$queryRaw<Array<{ requestCount: number }>>(Prisma.sql`
    INSERT INTO "assistant_usage_metrics" (
      "provider", "model", "window", "window_started_at", "request_count", "updated_at"
    ) VALUES (
      ${provider}, ${model}, ${window.toLocaleLowerCase('en-US')}::assistant_usage_window,
      ${windowStartedAt}, 1, NOW()
    )
    ON CONFLICT ("provider", "model", "window", "window_started_at") DO UPDATE SET
      "request_count" = "assistant_usage_metrics"."request_count" + 1,
      "updated_at" = NOW()
    WHERE "assistant_usage_metrics"."request_count" < ${limit}
    RETURNING "request_count" AS "requestCount"
  `);
  return rows.length === 1;
}

function updateBucket(
  prisma: AssistantUsageWriteClient,
  reservation: AssistantUsageReservation,
  window: AssistantUsageWindow,
  windowStartedAt: Date,
  input: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    totalTokens?: number | null;
    durationMs: number;
  },
  completed: boolean,
) {
  return prisma.$executeRaw(Prisma.sql`
    UPDATE "assistant_usage_metrics"
    SET
      "completed_count" = "completed_count" + ${completed ? 1 : 0},
      "error_count" = "error_count" + ${completed ? 0 : 1},
      "input_tokens" = "input_tokens" + ${toCount(input.inputTokens)},
      "output_tokens" = "output_tokens" + ${toCount(input.outputTokens)},
      "reasoning_tokens" = "reasoning_tokens" + ${toCount(input.reasoningTokens)},
      "total_tokens" = "total_tokens" + ${toCount(input.totalTokens)},
      "total_latency_ms" = "total_latency_ms" + ${toCount(input.durationMs)},
      "updated_at" = NOW()
    WHERE "provider" = ${reservation.provider}
      AND "model" = ${reservation.model}
      AND "window" = ${window.toLocaleLowerCase('en-US')}::assistant_usage_window
      AND "window_started_at" = ${windowStartedAt}
  `);
}

function toCount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function truncateUtcMinute(value: Date) {
  const result = new Date(value);
  result.setUTCSeconds(0, 0);
  return result;
}

function truncateUtcDay(value: Date) {
  const result = new Date(value);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

export function readAssistantBudgetLimit(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
) {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(code);
  }
  return parsed;
}
